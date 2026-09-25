/**
 * `.dsh/` 目录的唯一创建入口（扩展宿主与 daemon 共用）。
 *
 * 为什么需要它：`.dsh/` 里放的是 `history.json`（对话全文）、`trajectory/*.jsonl`（工具输入输出）、
 * `logs/daemon.log`、`trust.json` —— 全都含工作区代码片段与对话内容。这些文件若出现在用户仓库的
 * `git status` 里，轻则刷一屏未跟踪文件，重则被 `git add -A` 顺手提交进公司仓库。
 *
 * 对策：**首次创建 `.dsh/` 时写一份自守的 `.gitignore`（`*`）**，让这个目录自我封闭。
 * 单点收在这里，两个进程走同一实现，不会出现"一边写了、另一边没写"。
 *
 * 注意本仓库自己的 `.dsh/` 已由仓库根 `.gitignore` 覆盖，与本模块互不影响。
 */
import * as fs from 'fs';
import * as path from 'path';

/** 会话记录目录名（工作区根下的隐藏目录） */
export const DSH_DIR_NAME = '.dsh';

/** 自守忽略文件内容：整个目录都不进版本库 */
export const DSH_GITIGNORE_CONTENT =
  '# vscode-dsh：本目录是会话记录（对话全文 / 工具轨迹 / 日志 / 信任规则），不应进入版本库。\n' +
  '# 本文件由插件自动生成，删掉它下次启动会重建。\n' +
  '*\n';

/** 工作区根 → `.dsh` 目录路径（唯一来源，别在调用点自己拼）。 */
export function dshDirPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, DSH_DIR_NAME);
}

/**
 * 确保目录存在，并在**它确实是 `.dsh`** 时补上自守 `.gitignore`。
 *
 * 只对名为 `.dsh` 的目录写忽略文件：本函数同时被"建 `history.json` 所在目录"这类调用复用
 * （测试与降级路径里可能是任意临时目录），给那种目录塞 `.gitignore` 是越界行为。
 * 已存在的 `.gitignore` 一律不覆盖 —— 用户可能自己加过规则。
 *
 * 失败静默：`.dsh/` 是审计 / 历史用的旁路目录，它不可写不应影响 Agent 主流程。
 */
export function ensureDshDir(dir: string): string {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (path.basename(dir) !== DSH_DIR_NAME) return dir;
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) {
      fs.writeFileSync(ignore, DSH_GITIGNORE_CONTENT, { encoding: 'utf8', mode: 0o600 });
    }
  } catch {
    /* 非关键路径：忽略 */
  }
  return dir;
}
