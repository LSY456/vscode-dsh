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
import type { DshClient } from '../../wsClient';

const EXT_ID = 'deepseek-ai.vscode-dsh';

interface EventRecord {
  method: string;
  params: unknown;
}

let daemon: DaemonManager;
let client: DshClient;
const events: EventRecord[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function activateExtension(): Promise<{ daemon: DaemonManager; diff: unknown }> {
  const ext = vscode.extensions.getExtension(EXT_ID);
  if (!ext) throw new Error(`扩展未找到: ${EXT_ID}`);
  // 扩展的 activationEvents 无自动触发，需显式 activate() 拿到 exports
  return (await ext.activate()) as { daemon: DaemonManager; diff: unknown };
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
    }>(EVENTS.ApprovalRequest);
    assert.strictEqual(approval.tool, 'bash_execute');
    assert.strictEqual(approval.risk, 'high');
    assert.ok(approval.input.command.includes('rm -rf'), '命令应为高危 rm -rf');

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
});