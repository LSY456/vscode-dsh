/**
 * 构建指纹（陈旧 daemon 防护）。
 *
 * 背景：扩展升级装新版 VSIX 后，工作区 `.dsh/daemon.json` 里旧 daemon 进程可能仍存活
 * （VSCode reload 不回收扩展拉起的 node 子进程），auto 模式探测到端口可 ping 就复用，
 * 导致跑在旧代码上（真实事故：mock 补丁路径解析修复后仍复现旧行为）。
 *
 * 版本号不能用：扩展与 daemon 打包同一份 VSD_DSH_VERSION，同一版本号下多次构建仍无法区分新旧。
 * 因此每次构建生成随机 buildId（out/buildId.json，随构建变化、跨进程固定）：
 *  - daemon 在 Initialize 握手响应里上报 buildId；
 *  - 扩展对比自己读到的 buildId，不一致 => 复用了旧构建的 daemon，主动回收重启。
 *
 * 纯逻辑、无副作用，便于单测。
 */
import * as fs from 'fs';
import * as path from 'path';

/** 开发/测试环境缺省指纹（不触发回收）。 */
export const DEV_BUILD_ID = 'dev';

const FILE_NAME = 'buildId.json';

/**
 * 从 startDir 开始向上查找并解析 buildId.json（extension 位于 out/，daemon 位于
 * out/daemon/，都会向上命中 out/buildId.json）。文件缺失/损坏返回 DEV_BUILD_ID。
 */
export function readBuildId(startDir?: string): string {
  const root = startDir ?? __dirname;
  for (let dir = root; ; dir = path.dirname(dir)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8')) as {
        id?: unknown;
      };
      if (parsed && typeof parsed.id === 'string' && parsed.id) return parsed.id;
    } catch {
      /* 文件不存在或损坏：继续向上找 */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
  }
  return DEV_BUILD_ID;
}

/**
 * 判定复用的 daemon 是否陈旧（构建不匹配）。
 * - 任一侧指纹缺失/开发态（'dev'）=> 不视为陈旧（避免误杀开发环境进程）
 * - 两侧都有且不等 => 陈旧
 */
export function isStaleDaemon(currentBuildId: string, reportedBuildId: string | undefined): boolean {
  if (!reportedBuildId) return false;
  if (!currentBuildId || currentBuildId === DEV_BUILD_ID) return false;
  if (reportedBuildId === DEV_BUILD_ID) return false;
  return reportedBuildId !== currentBuildId;
}