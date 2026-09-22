/**
 * 参考 daemon 的模拟 Agent 循环。
 *
 * 行为由 prompt 关键词驱动（确定性、便于演示与冒烟测试）：
 *  - 始终：reasoning.delta 流 -> message.delta 流
 *  - 含 修改/edit/write/创建/replace：发起 file.patch.pending，等待
 *    file.patch.respond；接受则写盘并回 file.patch.result（目标必须在工作区内）
 *  - 含 bash/danger/危险/rm：发起 approval.request（高危）；若 allowedTools
 *    未包含 bash_execute 则直接以"工具被禁用"结束，不发起审批
 *  - 含 slow/慢：延长流式输出，用于验证 session.cancel
 *  - 含 read/查看：以 tool.started/tool.executed 呈现附件文件读取
 *    （附件省略内容时经 ctx.readFile 按需读取）
 *
 * 真实实现（Cordis 动态插件版 daemon）只需保持相同的事件时序与消息结构。
 */
import * as path from 'path';
import {
  EVENTS,
  ERROR_CODES,
  EventApprovalRequest,
  EventFilePatchPending,
  SessionSendParams,
} from '../../shared/protocol';
import { assertPathInside } from './paths';
import { applyPatchDecision, describePatchOutcome, PatchApplyEnv } from './patchApply';

export interface AgentCapabilities {
  allowedTools?: string[];
  allowedDirs?: string[];
}

export interface AgentContext {
  sessionId: string;
  workspaceRoot: string;
  capabilities?: AgentCapabilities;
  notify(method: string, params: unknown): void;
  /** 等待用户响应：携带完整快照（用于挂起快照与续跑重放） */
  waitForUser(
    kind: 'approval' | 'patch',
    snapshot: EventApprovalRequest | EventFilePatchPending
  ): Promise<boolean>;
  isCanceled(): boolean;
  /**
   * P0-3 取消订阅：注册一个「会话被取消」回调，由 server 在 `session.cancel()` 时同步触发。
   *
   * 仅轮询 `isCanceled()` 不足以中断**在途**的网络请求——若模型端不吐增量（首字节未到或
   * 中途静默），`onChunk` 永不被调用，取消会长久无响应。此钩子让 Agent 能在取消瞬间
   * `abort()` 掉在途 fetch。返回取消订阅函数（会话收尾时应调用，避免泄漏）。
   */
  onCancel?(fn: () => void): () => void;
  /** B1 信任记忆：命令是否命中免审批白名单（server 注入；测试缺省走审批） */
  isTrusted?(command: string): boolean;
  /** P2 编辑后应用：读用户编辑后的补丁内容（无则 undefined，用原始 newContent） */
  getPatchContent?(patchId: string): string | undefined;
  /**
   * P0-1：目标文件当前是否为「编辑器未保存」状态（daemon 脏文档覆盖层命中）。
   * 仅用于给用户/模型加标注；读取内容本身由 `readFile` 统一覆盖层优先。
   */
  isDirty?(target: string): boolean;
  /** P0-1：本补丁是否已由客户端应用到编辑器缓冲区（为 true 时 agent 不得写盘） */
  isPatchAppliedInEditor?(patchId: string): boolean;
  /** 按需读取文件（须在工作区内），失败返回 undefined */
  readFile(target: string, maxBytes?: number): Promise<string | undefined>;
}

/**
 * 由 AgentContext 组装补丁落地环境（P0-1 / P0-2 / P2）。
 * mock 与 real agent 共用，避免「脏文档判定」「乐观锁」等语义在两处漂移。
 */
export function makePatchEnv(ctx: AgentContext): PatchApplyEnv {
  return {
    workspaceRoot: ctx.workspaceRoot,
    allowedDirs: ctx.capabilities?.allowedDirs ?? [],
    isDirty: (target) => ctx.isDirty?.(target) ?? false,
    isAppliedInEditor: (patchId) => ctx.isPatchAppliedInEditor?.(patchId) ?? false,
    getEditedContent: (patchId) => ctx.getPatchContent?.(patchId),
    notifyUser: (delta) => ctx.notify(EVENTS.MessageDelta, { sessionId: ctx.sessionId, delta }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let stepCounter = 0;

function trajectory(
  ctx: AgentContext,
  kind: 'reasoning' | 'message' | 'tool' | 'patch' | 'approval' | 'system',
  detail: string
) {
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

  // ---- 2. 可选的 read 工具（模拟读取附件，支持 contentOmitted 按需读取）
  if (/read|查看|读取/i.test(prompt) && attachments.length > 0) {
    const file = attachments.find((a) => a.path) ?? attachments[0];
    const target = file.path ?? file.uri ?? 'unknown';
    ctx.notify(EVENTS.ToolStarted, { sessionId: ctx.sessionId, tool: 'read_file', input: { path: target } });
    trajectory(ctx, 'tool', `read_file ${JSON.stringify({ path: target })}`);
    await sleep(120);
    let content = file.content ?? '';
    if ((content === '' || file.contentOmitted) && file.path) {
      content = (await ctx.readFile(file.path)) ?? '(无法读取：路径越界或文件不存在)';
    }
    ctx.notify(EVENTS.ToolExecuted, {
      sessionId: ctx.sessionId,
      tool: 'read_file',
      ok: true,
      output: content.split('\n').slice(0, 12).join('\n') || '(空文件)',
      durationMs: 120,
    });
    trajectory(ctx, 'tool', 'read_file 完成');
  }

  // ---- 3. 文件修改（触发补丁审批，目标路径须在工作区内，canonical 校验防符号链接逃逸）
  if (/修改|edit|write|创建|replace/i.test(prompt)) {
    const rawTarget =
      attachments.find((a) => a.path)?.path ??
      resolvePromptPath(ctx, prompt) ??
      // 兜底：解析不出路径时落到工作区内（勿用 process.cwd()——那是 daemon 进程的
      // 启动目录，VSCode 拉起时指向安装目录，会误产出越界路径）
      path.join(ctx.workspaceRoot, 'output.txt');

    const target = safeResolve(ctx, rawTarget);
    if (target) {
      // P0-1：脏文档优先——命中编辑器未保存缓冲区则取缓冲区，未命中回落磁盘；
      // 返回 undefined 即文件不存在（按「新建」处理）
      const oldContent = (await ctx.readFile(target)) ?? undefined;
      const newContent = buildNewContent(oldContent ?? '');

      const patchId = `patch_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const patchPayload: EventFilePatchPending = {
        sessionId: ctx.sessionId,
        patchId,
        path: target,
        oldContent,
        newContent,
        description: `模拟 Agent 提议修改 ${path.basename(target)}（TODO -> DONE 并追加签名）`,
      };
      ctx.notify(EVENTS.FilePatchPending, patchPayload);
      trajectory(ctx, 'patch', `file.patch.pending ${target}`);

      const accepted = await ctx.waitForUser('patch', patchPayload);
      trajectory(ctx, 'patch', `file.patch.respond ${accepted ? 'accept' : 'reject'}`);

      // P0-1 / P0-2 / P2 统一落地裁决（脏文档走编辑器、普通文件走乐观锁）
      let applied = false;
      let appliedInEditor = false;
      let error: string | undefined;
      let outcomeText = '';
      if (accepted) {
        const result = applyPatchDecision(makePatchEnv(ctx), {
          patchId,
          resolvedPath: target,
          oldContent,
          newContent,
        });
        applied = result.applied;
        appliedInEditor = result.appliedInEditor;
        error = result.error;
        outcomeText = describePatchOutcome(result, target);
      }
      ctx.notify(EVENTS.FilePatchResult, {
        sessionId: ctx.sessionId,
        patchId,
        accepted,
        applied,
        error,
        appliedInEditor: appliedInEditor || undefined,
      });
      ctx.notify(EVENTS.MessageDelta, {
        sessionId: ctx.sessionId,
        delta: `\n\n[补丁] ${accepted ? outcomeText : '已拒绝'}。`,
      });
    }
  }

  // ---- 4. 高危命令（触发工具审批，受 allowedTools 约束）
  if (/bash|danger|危险|rm\s/i.test(prompt)) {
    // 语义：allowedTools 缺省/空数组 = 全部允许；非空 = 仅白名单内允许
    const tools = ctx.capabilities?.allowedTools;
    const toolAllowed = !tools || tools.length === 0 || tools.includes('bash_execute');
    ctx.notify(EVENTS.ToolStarted, {
      sessionId: ctx.sessionId,
      tool: 'bash_execute',
      input: { command: 'rm -rf build/ && npm run build' },
    });
    if (!toolAllowed) {
      ctx.notify(EVENTS.ToolExecuted, {
        sessionId: ctx.sessionId,
        tool: 'bash_execute',
        ok: false,
        output: '工具被禁用：capabilities.allowedTools 未包含 bash_execute。',
        durationMs: 0,
      });
      trajectory(ctx, 'tool', 'bash_execute 被禁用');
    } else if (ctx.isTrusted?.('rm -rf build/ && npm run build')) {
      // B1 信任记忆：白名单命中 -> 免审批直接执行（不发起 approval.request）
      ctx.notify(EVENTS.ToolExecuted, {
        sessionId: ctx.sessionId,
        tool: 'bash_execute',
        ok: true,
        output: 'mock: 已执行（信任命令，跳过审批）',
        durationMs: 0,
        trusted: true,
      });
      trajectory(ctx, 'tool', 'bash_execute 命中信任规则，免审批');
    } else {
      const approvalId = `approval_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const approvalParams: EventApprovalRequest = {
        sessionId: ctx.sessionId,
        approvalId,
        tool: 'bash_execute',
        input: { command: 'rm -rf build/ && npm run build' },
        risk: 'high',
        reason: '高危命令：递归删除目录，可能造成不可恢复的数据丢失。',
        // expiresAt 由 daemon 按 approvalTtlMs 统一盖戳（见 server.ts notify）
      };
      ctx.notify(EVENTS.ApprovalRequest, approvalParams);
      trajectory(ctx, 'approval', 'approval.request bash_execute');

      const approved = await ctx.waitForUser('approval', approvalParams);
      trajectory(ctx, 'approval', `approval.respond ${approved ? 'approved' : 'rejected'}`);

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

/** canonical 解析目标路径；越界时发 Error 事件并返回 null。 */
function safeResolve(ctx: AgentContext, raw: string): string | null {
  try {
    return assertPathInside(ctx.workspaceRoot, raw);
  } catch (e) {
    ctx.notify(EVENTS.Error, {
      sessionId: ctx.sessionId,
      code: ERROR_CODES.PathOutsideWorkspace,
      message: e instanceof Error ? e.message : String(e),
    });
    ctx.notify(EVENTS.MessageDelta, {
      sessionId: ctx.sessionId,
      delta: `\n\n[拒绝] 目标路径 ${raw} 超出工作区范围，未执行修改。`,
    });
    return null;
  }
}

/**
 * 从 prompt 解析目标路径：绝对路径原样返回；相对路径/文件名解析到工作区内。
 * 返回 null 表示 prompt 中没有可识别的路径（交由兜底）。
 */
function resolvePromptPath(ctx: AgentContext, prompt: string): string | null {
  const extracted = extractPath(prompt);
  if (!extracted) return null;
  return path.isAbsolute(extracted) ? extracted : path.join(ctx.workspaceRoot, extracted);
}

/**
 * 提取 prompt 中的路径：
 *  - 优先绝对路径（Windows 盘符 C:\ 或 C:/、Unix 根路径 /...）。约束：路径前的
 *    分隔符不能是单词字符/点/斜杠——否则 "components/App.tsx" 中间的 "/" 会被误判
 *    为 Unix 根路径、"./conf/x.yaml" 会被误判为绝对路径；
 *  - 否则匹配相对路径或文件名（可带 ./ ../ 前缀与多层目录），如 test.txt、
 *    components/App.tsx。注意匹配必须带扩展名，避免把中文句子里普通英文词当路径。
 * 注意：相对正则无捕获组，取完整匹配用 rel[0]（曾误用 rel[1] 恒为 undefined，
 * 导致真实用户场景「请修改 test.txt」永远解析失败回退到 output.txt）。
 */
function extractPath(prompt: string): string | null {
  const m = prompt.match(/(^|[^.\w])([A-Za-z]:[\\/][^\s"']+|\/[^\s"']+)/);
  if (m) return m[2];
  const rel = prompt.match(/(?:\.{0,2}[\\/])?[\w.-]+(?:[\\/][\w.-]+)*\.\w{1,8}\b/);
  return rel ? rel[0] : null;
}

function buildNewContent(oldContent: string): string {
  const replaced = oldContent.replace(/TODO/g, 'DONE');
  const banner = `\n// edited by dsh mock agent @ ${new Date().toISOString()}\n`;
  return replaced.endsWith('\n') ? replaced + banner : replaced + '\n' + banner;
}
