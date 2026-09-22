/**
 * 集成测试（@vscode/test-electron，真实 VSCode Extension Host + 真实 daemon 子进程）。
 *
 * 覆盖 smoke 测不到的「扩展宿主层 ↔ daemon」完整闭环，自动化 T 系列真机场景：
 *  - T1 激活与连接：DaemonManager 拉起内置 daemon 并完成 initialize 握手
 *  - T2 补丁流程：file.patch.pending → 接受 → 落盘
 *  - T3 审批流程：approval.request → 批准 → tool.executed
 *  - T4 路径护栏：工作区外目标拒绝（-32012）
 *  - T5 编辑后应用（P2）：respond 携带 content 覆盖写盘
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { EVENTS, METHODS } from '../../../shared/protocol';
import type { DaemonManager } from '../../daemonManager';
import type { DshDiffManager } from '../../diffProvider';
import type { WebviewPanelHost } from '../../webviewPanel';
import type { DshClient } from '../../wsClient';

const EXT_ID = 'deepseek-ai.vscode-dsh';

interface EventRecord {
  method: string;
  params: unknown;
}

let daemon: DaemonManager;
let client: DshClient;
let diff: DshDiffManager;
let panel: WebviewPanelHost;
const events: EventRecord[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function activateExtension(): Promise<{
  daemon: DaemonManager;
  diff: DshDiffManager;
  panel: WebviewPanelHost;
}> {
  const ext = vscode.extensions.getExtension(EXT_ID);
  if (!ext) throw new Error(`扩展未找到: ${EXT_ID}`);
  // 扩展的 activationEvents 无自动触发，需显式 activate() 拿到 exports
  return (await ext.activate()) as { daemon: DaemonManager; diff: DshDiffManager; panel: WebviewPanelHost };
}

interface HistoryRecord {
  sessionId: string;
  messages: { role: string; text: string }[];
}

/** 读取工作区 .dsh/history.json 中某个会话的落库记录（黑盒断言，不依赖内部状态）。 */
function readHistoryRecord(file: string, sessionId: string): HistoryRecord | undefined {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, HistoryRecord[]>;
  const list = raw['dsh.sessionHistory.v1'] ?? [];
  return list.find((r) => r.sessionId === sessionId);
}

function assistantCount(rec: HistoryRecord | undefined): number {
  return rec ? rec.messages.filter((m) => m.role === 'assistant').length : 0;
}

/** 找到补丁 Diff 的新内容侧文档（scheme: dsh-patch）。 */
function findPatchNewDocument(patchId: string): vscode.TextDocument | undefined {
  return vscode.window.visibleTextEditors
    .map((e) => e.document)
    .find(
      (d) =>
        d.uri.scheme === 'dsh-patch' &&
        d.uri.query.includes('side=new') &&
        d.uri.query.includes(encodeURIComponent(patchId))
    );
}

function workspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) throw new Error('无工作区文件夹');
  return folders[0].uri.fsPath;
}

async function waitFor<T>(poll: () => T | undefined | null | false, what: string, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = poll();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`等待 ${what} 超时`);
    await sleep(200);
  }
}

/** 从事件队列取下一个匹配事件（每一用例前 events 已清空，故串行安全）。 */
async function nextEvent<T = Record<string, unknown>>(method: string, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const idx = events.findIndex((e) => e.method === method);
    if (idx >= 0) return events.splice(idx, 1)[0].params as T;
    if (Date.now() - start > timeoutMs) throw new Error(`等待事件 ${method} 超时`);
    await sleep(100);
  }
}

async function createSession(): Promise<string> {
  const r = (await client.request(METHODS.SessionCreate, {})) as { sessionId: string };
  return r.sessionId;
}

describe('dsh 集成（扩展宿主层 ↔ daemon 闭环）', function () {
  this.timeout(90_000);

  before(async function () {
    this.timeout(60_000);
    const api = await activateExtension();
    daemon = api.daemon;
    diff = api.diff;
    panel = api.panel;
    client = daemon.client;
    // 订阅一次，事件进全局队列；各用例用 nextEvent 精确匹配
    client.onEvent((msg) => events.push({ method: msg.method, params: msg.params }));

    // T1：等待 DaemonManager 完成握手（connected）
    await waitFor(
      () => (daemon.getStatus().status === 'connected' ? daemon.getStatus() : null),
      'daemon 连接'
    );
  });

  beforeEach(() => {
    events.length = 0;
  });

  it('T1 激活后 daemon 已连接并持有会话 id', () => {
    const status = daemon.getStatus();
    assert.strictEqual(status.status, 'connected');
    assert.ok(status.detail.includes('已连接'));
    assert.ok(daemon.getSessionId().length > 0, 'initialize 应分配默认会话 id');
  });

  it('T2 补丁流程：file.patch.pending → 接受 → 落盘', async function () {
    const file = path.join(workspaceRoot(), 'it-patch.txt');
    fs.writeFileSync(file, 'TODO: fix\n', 'utf8');
    const sid = await createSession();

    const accepted = (await client.request(METHODS.SessionSend, {
      sessionId: sid,
      prompt: '请修改文件内容（write edit）',
      attachments: [{ kind: 'file', path: file, name: 'it-patch.txt', content: 'TODO: fix\n' }],
    })) as { accepted: boolean };
    assert.strictEqual(accepted.accepted, true);

    const pending = await nextEvent<{ patchId: string; path: string; newContent: string }>(EVENTS.FilePatchPending);
    assert.strictEqual(pending.path, file);
    assert.ok(pending.newContent.includes('DONE'), 'newContent 应将 TODO 替换为 DONE');

    await client.request(METHODS.FilePatchRespond, { sessionId: sid, patchId: pending.patchId, accept: true });

    const result = await nextEvent<{ accepted: boolean; applied: boolean }>(EVENTS.FilePatchResult);
    assert.strictEqual(result.accepted, true);
    assert.strictEqual(result.applied, true);

    const written = fs.readFileSync(file, 'utf8');
    assert.ok(written.includes('DONE'), '磁盘内容应含 DONE');
    assert.ok(!written.includes('TODO: fix'), '原始 TODO 行应被替换');
  });

  it('T3 审批流程：approval.request → 批准 → tool.executed ok', async function () {
    const sid = await createSession();
    await client.request(METHODS.SessionSend, { sessionId: sid, prompt: '危险操作：请运行 bash（danger）' });

    const approval = await nextEvent<{
      approvalId: string;
      tool: string;
      risk: string;
      input: { command: string };
      expiresAt?: number;
    }>(EVENTS.ApprovalRequest);
    assert.strictEqual(approval.tool, 'bash_execute');
    assert.strictEqual(approval.risk, 'high');
    assert.ok(approval.input.command.includes('rm -rf'), '命令应为高危 rm -rf');
    // dsh.approval.ttlSeconds（缺省 60）经 initialize 传到 daemon，再盖戳到事件上
    const ttl = (approval.expiresAt ?? 0) - Date.now();
    assert.ok(ttl > 0 && ttl <= 61_000, `审批事件应带 expiresAt（缺省 60s，实际 ${ttl}ms）`);

    await client.request(METHODS.ApprovalRespond, {
      sessionId: sid,
      approvalId: approval.approvalId,
      approved: true,
    });

    const executed = await nextEvent<{ tool: string; ok: boolean }>(EVENTS.ToolExecuted);
    assert.strictEqual(executed.tool, 'bash_execute');
    assert.strictEqual(executed.ok, true);
  });

  it('T4 路径护栏：工作区外目标被拒绝（-32012）', async function () {
    const sid = await createSession();
    await client.request(METHODS.SessionSend, { sessionId: sid, prompt: '请修改 ../escape.txt（write edit）' });

    const err = await nextEvent<{ code: number; message: string }>(EVENTS.Error);
    assert.strictEqual(err.code, -32012);
    assert.ok(err.message.includes('工作区') || err.message.includes('越界') || err.message.includes('范围'));
  });

  it('T5 编辑后应用（P2）：respond 携带 content 覆盖写盘', async function () {
    const file = path.join(workspaceRoot(), 'it-edit.txt');
    fs.writeFileSync(file, 'TODO: original\n', 'utf8');
    const sid = await createSession();

    await client.request(METHODS.SessionSend, {
      sessionId: sid,
      prompt: '请修改文件（edit）',
      attachments: [{ kind: 'file', path: file, name: 'it-edit.txt', content: 'TODO: original\n' }],
    });

    const pending = await nextEvent<{ patchId: string; path: string }>(EVENTS.FilePatchPending);
    const edited = '// 用户编辑后的最终内容\n';
    await client.request(METHODS.FilePatchRespond, {
      sessionId: sid,
      patchId: pending.patchId,
      accept: true,
      content: edited,
    });

    await nextEvent(EVENTS.FilePatchResult);
    const written = fs.readFileSync(file, 'utf8');
    assert.strictEqual(written, edited, '落盘内容应是用户编辑后的内容');
  });

  /**
   * T6 覆盖「在 Diff 里真编辑」这条用户路径：T5 只验证了协议层（respond 带 content），
   * 这里要求补丁的新内容侧在原生 Diff 中可编辑，且 applyEdited 读到的是用户改过的文本。
   */
  it('T6 Diff 可编辑 + 编辑后应用（用户真实路径）', async function () {
    const file = path.join(workspaceRoot(), 'it-diff-edit.txt');
    fs.writeFileSync(file, 'TODO: original\n', 'utf8');
    const sid = await createSession();

    await client.request(METHODS.SessionSend, {
      sessionId: sid,
      prompt: '请修改文件（edit）',
      attachments: [{ kind: 'file', path: file, name: 'it-diff-edit.txt', content: 'TODO: original\n' }],
    });

    const pending = await nextEvent<{ patchId: string; path: string }>(EVENTS.FilePatchPending);
    await diff.openDiff(pending.patchId);
    const doc = await waitFor(
      () => findPatchNewDocument(pending.patchId),
      '补丁 Diff 的新内容侧文档',
      10_000
    );

    // 用户能在这侧打字吗？applyEdit 能生效不代表编辑器允许输入：
    // 只读文档会在输入通道（default:type）被拦下，这才是 P2 功能的成败点。
    const beforeTyping = doc.getText();
    const typed = new Promise<void>((resolve) => {
      const sub = vscode.workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => {
        if (e.document.uri.toString() === doc.uri.toString()) {
          sub.dispose();
          resolve();
        }
      });
      setTimeout(() => {
        sub.dispose();
        resolve();
      }, 1500);
    });
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand('type', { text: 'X' });
    await typed;
    assert.notStrictEqual(doc.getText(), beforeTyping, '用户输入应写入补丁文档（只读文档会拒绝输入）');

    const edited = '// 用户编辑后的最终内容\n';
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      doc.uri,
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(doc.lineCount, 0)),
      edited
    );
    const applied = await vscode.workspace.applyEdit(edit);
    assert.ok(applied, '用户编辑应当能应用到补丁文档');

    await diff.applyEdited(pending.patchId);
    await sleep(300);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), edited, '落盘内容应为用户编辑后的文本');
  });

  it('T7 新建会话：分配新会话 id 且可继续发消息', async function () {
    const before = daemon.getSessionId();
    const fresh = await panel.newSession();
    assert.notStrictEqual(fresh, before, '新建会话应分配新的 sessionId');
    assert.strictEqual(daemon.getSessionId(), fresh, '当前会话应切到新会话');

    const r = (await client.request(METHODS.SessionSend, { sessionId: fresh, prompt: '你好（hello）' })) as {
      accepted: boolean;
    };
    assert.strictEqual(r.accepted, true);
    await nextEvent(EVENTS.SessionEnded);
  });

  it('T8 切回历史会话：重放缓冲且不重复写历史', async function () {
    const sid = await createSession();
    await client.request(METHODS.SessionSend, { sessionId: sid, prompt: '请解释这段代码（explain）' });
    await nextEvent(EVENTS.SessionEnded);
    await sleep(400); // 等历史落库队列

    const historyFile = path.join(workspaceRoot(), '.dsh', 'history.json');
    const before = readHistoryRecord(historyFile, sid);
    assert.strictEqual(assistantCount(before), 1, '首次对话应落库 1 条回答');

    const fresh = await panel.newSession();
    assert.notStrictEqual(fresh, sid);

    const switched = await panel.openHistorySession(sid);
    assert.strictEqual(switched, true, 'daemon 仍持有该会话，应真实切回（而非只读回放）');
    assert.strictEqual(daemon.getSessionId(), sid, '切回后当前会话应为该历史会话');

    await sleep(400);
    const after = readHistoryRecord(historyFile, sid);
    assert.strictEqual(assistantCount(after), 1, '重放事件不得把同一段回答重复写入历史');
  });

  it('T9 侧边栏入口：视图已贡献且可加载出 webview surface', async function () {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('dsh.agentView.focus'),
      'dsh.agentView 应作为 webview 视图注册（活动栏常驻入口）'
    );
    await vscode.commands.executeCommand('dsh.openPanel');
    const ready = await waitFor(
      () => (panel.getReadySurfaceCount() > 0 ? true : undefined),
      '侧边栏 webview 就绪',
      20_000
    );
    assert.ok(ready);
  });
});
