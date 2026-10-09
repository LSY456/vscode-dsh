/**
 * 会话回滚结果 → 用户可读文案（纯函数，便于单测）。
 *
 * 为什么单独成模块：回滚结果有七类，压成一句"回滚完成"会把真正有用的信息埋掉 ——
 * 「3 个文件因为编辑器里还没保存，跳过了」与「全部还原成功」对用户的下一步动作完全不同
 * （前者要用户先去保存或放弃改动，后者什么也不用做）。这里负责把它们排成人话，
 * UI 只负责显示；也因此可以脱离 vscode 直接测。
 */
import type { SessionRollbackResult } from '../shared/protocol';

export interface RollbackSummary {
  /** 一句话结论（通知弹窗 / 系统消息首行用） */
  headline: string;
  /** 明细（无补充信息时为空串） */
  detail: string;
}

/** 单类明细最多列出的路径条数，其余折叠成「等 N 个」—— 一次回滚几十个文件时别糊满屏幕。 */
export const ROLLBACK_LIST_LIMIT = 5;

export interface RollbackFormatOptions {
  /** 工作区根：给出时把绝对路径缩成相对路径（通知里绝对路径太长）。 */
  workspaceRoot?: string;
}

/**
 * 把回滚结果整理成「结论 + 明细」。
 *
 * 分类顺序刻意如此：先说做成了什么（还原 / 删除），再说**需要用户动手**的部分
 * （脏文档跳过 → 去保存；不可还原 / 未记录 → 手工处理），最后才是失败。
 */
export function formatRollbackReport(
  report: SessionRollbackResult,
  opts: RollbackFormatOptions = {}
): RollbackSummary {
  const short = (p: string) => shortPath(p, opts.workspaceRoot);
  // 防御 `undefined`：扩展可能连着一个"升级前就已在跑"的 daemon（进程存活期内不会重载代码），
  // 那种 daemon 不认识本字段。缺字段当成空数组，而不是让整个回滚汇报抛异常。
  const changedAfter = report.changedAfter ?? [];
  const done = report.restored.length + report.deleted.length;
  const unhandled =
    report.skippedDirty.length +
    changedAfter.length +
    report.unrestorable.length +
    report.failed.length +
    report.unrecorded;

  if (report.total === 0 && report.unrecorded === 0) {
    return { headline: '本次会话没有改动过任何文件，无需回滚', detail: '' };
  }

  const headline =
    unhandled === 0
      ? `已回滚本次会话的 ${done} 处文件改动`
      : `已回滚 ${done} 处文件改动，另有 ${unhandled} 处未处理`;

  const lines: string[] = [];
  if (report.restored.length > 0) {
    lines.push(`- 还原为改动前：${list(report.restored.map(short))}`);
  }
  if (report.deleted.length > 0) {
    lines.push(`- 删除（本次会话新建）：${list(report.deleted.map(short))}`);
  }
  if (report.skippedDirty.length > 0) {
    lines.push(
      `- 跳过 ${report.skippedDirty.length} 个（编辑器里有未保存的改动，回滚不会覆盖它们）：` +
        `${list(report.skippedDirty.map(short))}。请先保存或放弃这些改动后再回滚。`
    );
  }
  if (changedAfter.length > 0) {
    lines.push(
      `- 跳过 ${changedAfter.length} 个（在本次会话之后又被改过，回滚不覆盖它们）：` +
        `${list(changedAfter.map((c) => short(c.path)))}。请先确认这些改动是否要保留，再决定如何回退。`
    );
  }
  if (report.unrestorable.length > 0) {
    lines.push(
      `- 无法还原 ${report.unrestorable.length} 个（改动前的内容没能留存快照）：` +
        report.unrestorable
          .map((u) => `${short(u.path)}（${u.reason}）`)
          .slice(0, ROLLBACK_LIST_LIMIT)
          .join('、')
    );
  }
  if (report.failed.length > 0) {
    lines.push(
      `- 失败 ${report.failed.length} 个：` +
        report.failed
          .map((f) => `${short(f.path)}（${f.error}）`)
          .slice(0, ROLLBACK_LIST_LIMIT)
          .join('、')
    );
  }
  if (report.unrecorded > 0) {
    lines.push(
      `- 有 ${report.unrecorded} 处改动未纳入回滚（快照条目已达上限），这些改动仍留在工作区，需自行处理。`
    );
  }

  return { headline, detail: lines.join('\n') };
}

/** 列表：超出上限时折叠为「前 N 个 等 M 个」。 */
function list(items: string[]): string {
  if (items.length <= ROLLBACK_LIST_LIMIT) return items.join('、');
  const head = items.slice(0, ROLLBACK_LIST_LIMIT - 1).join('、');
  return `${head} 等 ${items.length} 个`;
}

/**
 * 绝对路径 → 相对工作区的可读路径。
 *
 * 只做**展示层**缩短：前缀不匹配（或没给工作区根）时原样返回，绝不猜。
 * 比较前统一分隔符并忽略 Windows 大小写，否则 `D:\ws` 与 `d:\ws\a.ts` 会匹配不上。
 */
export function shortPath(absPath: string, workspaceRoot?: string): string {
  if (!workspaceRoot) return absPath;
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const root = norm(workspaceRoot);
  const p = norm(absPath);
  const cmpRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const cmpPath = process.platform === 'win32' ? p.toLowerCase() : p;
  if (cmpPath === cmpRoot) return '.';
  if (cmpPath.startsWith(cmpRoot + '/')) return p.slice(root.length + 1);
  return absPath;
}
