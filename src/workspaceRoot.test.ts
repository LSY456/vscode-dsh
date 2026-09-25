/**
 * 工作区根解析（P0-2）验证。
 *
 * 要钉住的核心行为：**没有文件夹时明确返回"不可用 + 原因"，而不是猜一个根**。
 * 猜根的真实代价见模块头注释（Agent 的工作区会变成扩展宿主的 cwd）。
 */
import { describe, expect, it } from 'vitest';
import { NO_WORKSPACE_REASON, WorkspaceFolderLike, resolveWorkspaceRoot } from './workspaceRoot';

function folder(fsPath: string): WorkspaceFolderLike {
  return { uri: { fsPath } };
}

describe('resolveWorkspaceRoot：没有文件夹就不猜根', () => {
  it('workspaceFolders 为 undefined → 不可用，且原因是"请先打开文件夹"', () => {
    const r = resolveWorkspaceRoot(undefined);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('打开文件夹');
    expect(r.reason).toBe(NO_WORKSPACE_REASON);
  });

  it('空数组（打开了空的窗口）同样不可用', () => {
    expect(resolveWorkspaceRoot([]).ok).toBe(false);
  });

  it('单个文件夹 → 取它作为根', () => {
    const r = resolveWorkspaceRoot([folder('/repo')]);
    expect(r).toEqual({ ok: true, root: '/repo', folderCount: 1 });
  });

  it('多根 → 取第一个，并如实报出总数（供调用方决定是否提示）', () => {
    const r = resolveWorkspaceRoot([folder('/a'), folder('/b')]);
    expect(r).toEqual({ ok: true, root: '/a', folderCount: 2 });
  });

  it('返回值里不含任何"回落目录"的痕迹（旧实现会退到 process.cwd()）', () => {
    const r = resolveWorkspaceRoot(undefined);
    expect(r).not.toHaveProperty('root');
    expect(JSON.stringify(r)).not.toContain(process.cwd());
  });
});
