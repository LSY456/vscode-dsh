/**
 * 参考 daemon 的模拟 Agent 循环。
 *
 * 行为由 prompt 关键词驱动（确定性、便于演示与冒烟测试）：
 *  - 始终：reasoning.delta 流 -> message.delta 流
 *  - 含 修改/edit/write/创建/replace：发起 file.patch.pending，等待
 *    file.patch.respond；接受则写盘并回 file.patch.result
 *  - 含 bash/danger/危险/rm：发起 approval.request（高危），等待响应后
 *    以 tool.started/tool.executed 呈现执行结果
 *  - 含 slow/慢：延长流式输出，用于验证 session.cancel
 *  - 含 read/查看：以 tool.started/tool.executed 呈现附件文件读取
 *
 * 真实实现（Cordis 动态插件版 daemon）只需保持相同的事件时序与消息结构。
 */
import * as fs from 'fs';
import * as path from 'path';
import { EVENTS, SessionSendParams } from '../../shared/protocol';

export interface AgentContext {
  sessionId: string;
  notify(method: string, params: unknown): void;
  /** 等待用户对某次审批/补丁的响应 */
  waitForUser(kind: 'approval' | 'patch', id: string): Promise<boolean>;
  isCanceled(): boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let stepCounter = 0;

function trajectory(ctx: AgentContext, kind: 'reasoning' | 'message' | 'tool' | 'patch' | 'approval' | 'system', detail: string) {
  ctx.notify(EVENTS.Trajectory, {
    sessionId: ctx.sessionId,
    step: ++stepCounter,
    kind,
    detail,
    ts: Date.now(),
  });
}

export async function runFakeAgent(ctx: AgentContext, params: SessionSendParams): Promise<void> {
  const { prompt, attachments = [] } = params;
  const truncated = (s: string, n = 120) => (s.length > n ? s.slice(0, n) + '…' : s);

  ctx.notify(EVENTS.SessionStarted, { sessionId: ctx.sessionId, title: truncated(prompt, 60) });
  trajectory(ctx, 'system', `session 开始：${truncated(prompt, 80)}`);

  // ---- 1. 推理流
  const reasoning = [
    `用户请求：${truncated(prompt)}\n`,
    `已捕获 ${attachments.length} 个上下文附件（${attachments.map((a) => a.kind).join(', ') || '无'}）。\n`,
    '开始分析：定位目标文件、评估改动影响、规划工具调用序列。\n',
    attachments[0]?.path ? `目标文件：${attachments[0].path}\n` : '',
  ].join('');
  for (const ch of chunk(reasoning, 6)) {
    if (ctx.isCanceled()) break;
    ctx.notify(EVENTS.ReasoningDelta, { sessionId: ctx.sessionId, delta: ch });
    trajectory(ctx, 'reasoning', ch.trim());
    await sleep(60);
  }

  // ---- 2. 可选的 read 工具（模拟读取附件）
  if (/read|查看|读取/i.test(prompt) && attachments.length > 0) {
    const file = attachments.find((a) => a.path) ?? attachments[0];
    const input = { path: file.path ?? file.uri ?? 'unknown' };
    ctx.notify(EVENTS.ToolStarted, { sessionId: ctx.sessionId, tool: 'read_file', input });
    trajectory(ctx, 'tool', `read_file ${JSON.stringify(input)}`);
    await sleep(120);
    const content = (file.content ?? '').split('\n').slice(0, 12).join('\n');
    ctx.notify(EVENTS.ToolExecuted, {
      sessionId: ctx.sessionId,
      tool: 'read_file',
      ok: true,
      output: content || '(空文件)',
      durationMs: 120,
    });
    trajectory(ctx, 'tool', 'read_file 完成');
  }

  // ---- 3. 文件修改（触发补丁审批）
  if (/修改|edit|write|创建|replace/i.test(prompt)) {
    const target =
      attachments.find((a) => a.path)?.path ?? extractPath(prompt) ?? path.join(process.cwd(), 'output.txt');
    let oldContent: string | undefined;
    try {
      oldContent = fs.readFileSync(target, 'utf8');
    } catch {
      oldContent = undefined; // 文件不存在 => 新建
    }
    const newContent = buildNewContent(oldContent ?? '');

    const patchId = `patch_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    ctx.notify(EVENTS.FilePatchPending, {
      sessionId: ctx.sessionId,
      patchId,
      path: target,
      oldContent,
      newContent,
      description: `模拟 Agent 提议修改 ${path.basename(target)}（TODO -> DONE 并追加签名）`,
    });
    trajectory(ctx, 'patch', `file.patch.pending ${target}`);

    const accepted = await ctx.waitForUser('patch', patchId);
    trajectory(ctx, 'patch', `file.patch.respond ${accepted ? 'accept' : 'reject'}`);

    let applied = false;
    let error: string | undefined;
    if (accepted) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, newContent, 'utf8');
        applied = true;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    ctx.notify(EVENTS.FilePatchResult, { sessionId: ctx.sessionId, patchId, accepted, applied, error });
    ctx.notify(EVENTS.MessageDelta, {
      sessionId: ctx.sessionId,
      delta: `\n\n[补丁] ${accepted ? (applied ? `已应用 ${target}` : `应用失败：${error}`) : '已拒绝'}。`,
    });
  }

  // ---- 4. 高危命令（触发工具审批）
  if (/bash|danger|危险|rm\s/i.test(prompt)) {
    const approvalId = `approval_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    ctx.notify(EVENTS.ApprovalRequest, {
      sessionId: ctx.sessionId,
      approvalId,
      tool: 'bash_execute',
      input: { command: 'rm -rf build/ && npm run build' },
      risk: 'high',
      reason: '高危命令：递归删除目录，可能造成不可恢复的数据丢失。',
      expiresAt: Date.now() + 60_000,
    });
    trajectory(ctx, 'approval', 'approval.request bash_execute');

    const approved = await ctx.waitForUser('approval', approvalId);
    trajectory(ctx, 'approval', `approval.respond ${approved ? 'approved' : 'rejected'}`);

    ctx.notify(EVENTS.ToolStarted, {
      sessionId: ctx.sessionId,
      tool: 'bash_execute',
      input: { command: 'rm -rf build/ && npm run build' },
    });
    await sleep(200);
    ctx.notify(EVENTS.ToolExecuted, {
      sessionId: ctx.sessionId,
      tool: 'bash_execute',
      ok: approved,
      output: approved ? 'mock: 已清理 build/ 并完成构建（演示输出）' : '已取消：用户拒绝了该命令。',
      durationMs: 200,
    });
    trajectory(ctx, 'tool', 'bash_execute 完成');
  }

  // ---- 5. 慢速输出（验证取消）
  if (/slow|慢/i.test(prompt)) {
    for (let i = 0; i < 30; i++) {
      if (ctx.isCanceled()) break;
      ctx.notify(EVENTS.MessageDelta, { sessionId: ctx.sessionId, delta: '.' });
      await sleep(120);
    }
  }

  // ---- 6. 收尾
  const canceled = ctx.isCanceled();
  if (canceled) {
    ctx.notify(EVENTS.MessageDelta, { sessionId: ctx.sessionId, delta: '\n\n[已取消]' });
    ctx.notify(EVENTS.SessionEnded, { sessionId: ctx.sessionId, reason: 'canceled' });
  } else {
    ctx.notify(EVENTS.MessageDelta, {
      sessionId: ctx.sessionId,
      delta: `\n\n---\n*（参考 daemon 演示输出，非真实模型结果）* 已处理请求：${truncated(prompt, 80)}`,
    });
    ctx.notify(EVENTS.MessageDone, { sessionId: ctx.sessionId });
    ctx.notify(EVENTS.SessionEnded, { sessionId: ctx.sessionId, reason: 'completed' });
  }
  trajectory(ctx, 'system', `session 结束：${canceled ? 'canceled' : 'completed'}`);
}

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function extractPath(prompt: string): string | null {
  const m = prompt.match(/([A-Za-z]:\\[^\s"']+|\/[^\s"']+)/);
  return m ? m[1] : null;
}

function buildNewContent(oldContent: string): string {
  const replaced = oldContent.replace(/TODO/g, 'DONE');
  const banner = `\n// edited by dsh mock agent @ ${new Date().toISOString()}\n`;
  return replaced.endsWith('\n') ? replaced + banner : replaced + '\n' + banner;
}
