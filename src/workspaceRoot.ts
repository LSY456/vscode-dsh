/**
 * 工作区根解析：**唯一入口**。
 *
 * 为什么这是 P0 级：此前没有 `workspaceFolders` 时会回落
 * `vscode.workspace.rootPath ?? process.cwd()`，于是"Agent 的工作区"变成**扩展宿主进程的 cwd**
 * （VS Code 安装目录或用户主目录）—— 端口文件、`.dsh/` 落盘、以及路径护栏的 root 全跟着跑偏，
 * 而用户完全不知道 Agent 在操作哪个目录。
 *
 * 猜一个根不如明确拒绝：没有打开文件夹就**不启动**，并说清"为什么不能用 + 怎么解决"。
 *
 * 多根工作区只取第一个（单根语义清晰，不为此重设计），是否提示由调用方决定。
 */
export interface WorkspaceFolderLike {
  uri: { fsPath: string };
}

export type WorkspaceRootResolution =
  | { ok: true; root: string; folderCount: number }
  | { ok: false; reason: string };

/** 无文件夹时的统一文案：说清"为什么不能用"+"怎么解决" */
export const NO_WORKSPACE_REASON =
  '未打开文件夹（工作区）：Agent 需要读写工作区文件、执行命令，并在 .dsh/ 下落盘会话记录。' +
  '请先用「文件 → 打开文件夹」打开一个工作区，再使用 dsh。';

export function resolveWorkspaceRoot(
  folders: readonly WorkspaceFolderLike[] | undefined | null
): WorkspaceRootResolution {
  if (!folders || folders.length === 0) {
    return { ok: false, reason: NO_WORKSPACE_REASON };
  }
  return { ok: true, root: folders[0].uri.fsPath, folderCount: folders.length };
}
