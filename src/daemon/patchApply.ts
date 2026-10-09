/**
 * 补丁落地决策（P0-1 脏文档一致性 + P0-2 乐观并发 + P2 编辑后应用）。
 *
 * mock agent 与 real agent 原先各写一遍「accept 后写盘」的逻辑，三处语义（乐观锁、脏文档、
 * 编辑后内容）叠加后极易漂移，故收敛到此处统一裁决。落地通路有三条，判定优先级从高到低：
 *
 * 1. **已由客户端应用到编辑器缓冲区**（`applyInEditor`）——脏文档的正解。daemon 一律不落盘：
 *    目标文件在编辑器里有未保存改动时，写盘会让缓冲区与磁盘「分叉」，用户下次 Ctrl+S 就会
 *    用旧缓冲区把 Agent 的结果覆盖掉。改走编辑器 WorkspaceEdit 后两边重新对齐，且改动仍保持
 *    未保存态，用户可自行复核。
 * 2. **目标是脏文档、但客户端没走编辑器** —— 安全默认是**拒绝落盘**并说明原因，绝不静默
 *    覆盖用户未保存的改动。（正常客户端不会走到这里。）
 * 3. **普通文件** —— 沿用 P0-2 乐观锁：快照与当前磁盘不一致即判冲突拒绝，防止审阅期间被
 *    外部改动（编辑器保存 / 另一会话 / 外部工具）静默覆盖。
 *
 * 脏文档通路**不做**乐观锁磁盘比对：此时 `oldContent` 取自缓冲区而非磁盘，比对磁盘必然误判；
 * 「审阅期间缓冲区又被改过」由客户端在应用前自校验（见 `diffProvider`）。
 *
 * P2-6 会话回滚：**两条真正改动工作区的通路（1 与 3）都会先调 `recordSnapshot`**，把改动前的
 * 内容留给影子快照，并附上本次写入的内容（供还原前做指纹比对）。通路 2 什么都没改，故不记录
 * —— 记了会让回滚报告凭空多出一个文件。
 */
import { checkPatchConflict, writeTextFile } from './tools';

export interface PatchApplyEnv {
  workspaceRoot: string;
  allowedDirs: string[];
  /** 目标文件当前是否为「编辑器未保存」状态（daemon 脏文档覆盖层命中） */
  isDirty(resolvedPath: string): boolean;
  /** 客户端是否已把本补丁应用到编辑器缓冲区 */
  isAppliedInEditor(patchId: string): boolean;
  /** P2：用户编辑后的内容（无则用 agent 原始 newContent） */
  getEditedContent(patchId: string): string | undefined;
  /**
   * P2-6 会话回滚：在**真正改动发生之前**记下改动前的内容，并附上**本次写入的内容**
   * （供还原前做指纹比对，见 `sessionSnapshot.ts` 文件头 ⑤）。
   *
   * 必须由本模块调用而不是调用方各写一遍 —— 两条落地通路（写盘 / 交由编辑器）都会改动
   * 工作区，漏记任何一条，回滚就会少还一个文件，而用户无从察觉。
   * 实现侧须保证「改动前内容首写优先」「写入指纹末次覆盖」与「失败不抛」（见 `sessionSnapshot.ts`）。
   */
  recordSnapshot?(resolvedPath: string, originalContent: string | undefined, writtenContent?: string): void;
  /** 向用户播报（映射到 message.delta） */
  notifyUser(delta: string): void;
}

export interface PatchApplyRequest {
  patchId: string;
  /** canonical 绝对路径 */
  resolvedPath: string;
  /** 补丁发出时的基准内容（文件原本不存在则 undefined） */
  oldContent?: string;
  /** agent 计算出的新内容 */
  newContent: string;
}

export interface PatchApplyResult {
  /** daemon 是否已落盘 */
  applied: boolean;
  /** 改动是否已由客户端应用到编辑器缓冲区（此时 applied 为 false） */
  appliedInEditor: boolean;
  error?: string;
}

/** 按上述优先级裁决一次补丁落地；不抛异常，失败一律以 `error` 返回。 */
export function applyPatchDecision(env: PatchApplyEnv, patch: PatchApplyRequest): PatchApplyResult {
  const { patchId, resolvedPath, oldContent, newContent } = patch;

  // 通路 1：客户端已应用到编辑器缓冲区 —— daemon 不得写盘
  if (env.isAppliedInEditor(patchId)) {
    // 改动**确实发生了**（发生在编辑器缓冲区里），只是不由 daemon 执行 —— 回滚快照照记。
    // 写入内容按"编辑器里最终应用的那份"记账：daemon 看不到缓冲区，只能取用户编辑后的内容
    // （无编辑则取 agent 的 newContent）。这一份若与真实缓冲区不符，只会让还原变成**保守跳过**
    // （报"内容已变"），不会造成覆盖 —— 宁可少还原，也不覆盖用户的东西。
    // 还原时该文件多半仍是脏的，届时按「脏文档跳过」如实回报。
    const appliedInBuffer = env.getEditedContent(patchId) ?? newContent;
    env.recordSnapshot?.(resolvedPath, oldContent, appliedInBuffer);
    return { applied: false, appliedInEditor: true };
  }

  // 通路 2：脏文档但未走编辑器 —— 拒绝写盘，避免覆盖用户未保存的改动
  if (env.isDirty(resolvedPath)) {
    const error =
      '目标文件在编辑器中有未保存的改动，补丁未写入磁盘。' +
      '若改动发生在补丁审阅期间，请重新发起修改；' +
      '否则请在面板或 Diff 标题栏点「应用」（会写入编辑器缓冲区），或先保存文件后重试。';
    env.notifyUser(`\n\n[补丁] ${error}\n`);
    return { applied: false, appliedInEditor: false, error };
  }

  // 通路 3：普通文件 —— P0-2 乐观锁 + 落盘
  try {
    const conflict = checkPatchConflict(env.workspaceRoot, env.allowedDirs, resolvedPath, oldContent);
    if (!conflict.ok) {
      const error =
        `文件已被外部修改，补丁未应用（乐观锁冲突）。` +
        `请重新读取 ${resolvedPath.split(/[\\/]/).pop()} 后再次发起修改。`;
      env.notifyUser(`\n\n[补丁] ${error}\n`);
      return { applied: false, appliedInEditor: false, error };
    }
    const finalContent = env.getEditedContent(patchId) ?? newContent;
    // P2-6：先留快照再落盘 —— 顺序反了就什么都救不回来了
    env.recordSnapshot?.(resolvedPath, oldContent, finalContent);
    writeTextFile(env.workspaceRoot, env.allowedDirs, resolvedPath, finalContent);
    return { applied: true, appliedInEditor: false };
  } catch (e) {
    return { applied: false, appliedInEditor: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 组装给 agent 看的落地结论文案。 */
export function describePatchOutcome(result: PatchApplyResult, resolvedPath: string): string {
  if (result.applied) return `已写入 ${resolvedPath}`;
  if (result.appliedInEditor) return `已应用到编辑器缓冲区 ${resolvedPath}（文件有未保存改动，未落盘；保存后生效）`;
  return `写入失败：${result.error}`;
}
