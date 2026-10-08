import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyPatchDecision, describePatchOutcome, PatchApplyEnv } from './patchApply';

let root: string;
let target: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patchapply-'));
  target = path.join(root, 'a.txt');
});
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

interface EnvOverrides {
  dirty?: boolean;
  appliedInEditor?: boolean;
  edited?: string;
  /** P2-6：收集 recordSnapshot 的调用（顺序即调用顺序） */
  records?: Array<{ path: string; content: string | undefined }>;
}

function makeEnv(o: EnvOverrides = {}): { env: PatchApplyEnv; notices: string[] } {
  const notices: string[] = [];
  return {
    notices,
    env: {
      workspaceRoot: root,
      allowedDirs: [],
      isDirty: () => o.dirty ?? false,
      isAppliedInEditor: () => o.appliedInEditor ?? false,
      getEditedContent: () => o.edited,
      recordSnapshot: (p, c) => o.records?.push({ path: p, content: c }),
      notifyUser: (delta) => notices.push(delta),
    },
  };
}

describe('applyPatchDecision（P0-1 脏文档 / P0-2 乐观锁 / P2 编辑后应用）', () => {
  it('通路1 客户端已应用到编辑器 -> 不落盘，appliedInEditor 为真', () => {
    fs.writeFileSync(target, 'disk', 'utf8');
    const { env } = makeEnv({ appliedInEditor: true, dirty: true });
    const r = applyPatchDecision(env, {
      patchId: 'p1',
      resolvedPath: target,
      oldContent: 'disk',
      newContent: 'agent',
    });
    expect(r).toEqual({ applied: false, appliedInEditor: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('disk'); // 磁盘纹丝不动
  });

  it('通路1 优先于通路2：即使目标是脏文档也不报错（正常客户端路径）', () => {
    const { env, notices } = makeEnv({ appliedInEditor: true, dirty: true });
    const r = applyPatchDecision(env, {
      patchId: 'p1',
      resolvedPath: target,
      oldContent: 'x',
      newContent: 'y',
    });
    expect(r.error).toBeUndefined();
    expect(notices).toHaveLength(0);
  });

  it('通路2 脏文档且未走编辑器 -> 拒绝落盘并说明原因，用户有提示', () => {
    fs.writeFileSync(target, 'disk', 'utf8');
    const { env, notices } = makeEnv({ dirty: true });
    const r = applyPatchDecision(env, {
      patchId: 'p2',
      resolvedPath: target,
      oldContent: 'dirty-buffer',
      newContent: 'agent',
    });
    expect(r.applied).toBe(false);
    expect(r.appliedInEditor).toBe(false);
    expect(r.error).toContain('未保存');
    expect(notices.join('')).toContain('未保存');
    expect(fs.readFileSync(target, 'utf8')).toBe('disk'); // 未保存改动没有被覆盖
  });

  it('通路3 普通文件且快照一致 -> 落盘成功', () => {
    fs.writeFileSync(target, 'disk', 'utf8');
    const { env, notices } = makeEnv();
    const r = applyPatchDecision(env, {
      patchId: 'p3',
      resolvedPath: target,
      oldContent: 'disk',
      newContent: 'agent',
    });
    expect(r).toEqual({ applied: true, appliedInEditor: false });
    expect(fs.readFileSync(target, 'utf8')).toBe('agent');
    expect(notices).toHaveLength(0);
  });

  it('通路3 乐观锁冲突（审阅期间被外部改动）-> 拒绝并提示重新读取', () => {
    fs.writeFileSync(target, 'changed-by-others', 'utf8');
    const { env, notices } = makeEnv();
    const r = applyPatchDecision(env, {
      patchId: 'p4',
      resolvedPath: target,
      oldContent: 'disk',
      newContent: 'agent',
    });
    expect(r.applied).toBe(false);
    expect(r.error).toContain('乐观锁');
    expect(notices.join('')).toContain('乐观锁');
    expect(fs.readFileSync(target, 'utf8')).toBe('changed-by-others'); // 并发改动未被静默覆盖
  });

  it('通路3 从无到有的新建（快照 undefined 且文件仍不存在）不算冲突', () => {
    const fresh = path.join(root, 'new.txt');
    const { env } = makeEnv();
    const r = applyPatchDecision(env, {
      patchId: 'p5',
      resolvedPath: fresh,
      oldContent: undefined,
      newContent: 'hello',
    });
    expect(r.applied).toBe(true);
    expect(fs.readFileSync(fresh, 'utf8')).toBe('hello');
  });

  it('P2 编辑后应用：用户编辑内容优先于 agent 原始 newContent', () => {
    fs.writeFileSync(target, 'disk', 'utf8');
    const { env } = makeEnv({ edited: 'user-edited' });
    const r = applyPatchDecision(env, {
      patchId: 'p6',
      resolvedPath: target,
      oldContent: 'disk',
      newContent: 'agent',
    });
    expect(r.applied).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('user-edited');
  });

  it('路径越界 -> 以 error 返回（不抛异常）', () => {
    const { env } = makeEnv();
    const r = applyPatchDecision(env, {
      patchId: 'p7',
      resolvedPath: path.join(root, '..', 'outside.txt'),
      oldContent: undefined,
      newContent: 'x',
    });
    expect(r.applied).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

/**
 * P2-6 会话回滚：快照必须在**改动发生之前**记下，且只在真的改动了文件时才记。
 * 三条容易写错的边界：
 *  ① 通路 3 的记录发生在落盘**之前**（顺序反了就等于什么都没救回来）；
 *  ② 通路 2（脏文档拒绝落盘）什么都没改 —— 记了会让回滚报告凭空多出一个"改过的文件"；
 *  ③ 乐观锁冲突 / 路径越界这类**没写盘的**失败同样不记录。
 */
describe('applyPatchDecision × P2-6 快照记录', () => {
  it('通路3：记录顺序在落盘之前，内容是改动前的磁盘内容', () => {
    fs.writeFileSync(target, 'before', 'utf8');
    const records: Array<{ path: string; content: string | undefined }> = [];
    const { env } = makeEnv({ records });
    const r = applyPatchDecision(env, {
      patchId: 's1',
      resolvedPath: target,
      oldContent: 'before',
      newContent: 'after',
    });
    expect(r.applied).toBe(true);
    expect(records).toEqual([{ path: target, content: 'before' }]);
    expect(fs.readFileSync(target, 'utf8')).toBe('after');
  });

  it('通路1：改动发生在编辑器里，daemon 不落盘 —— 但快照照记', () => {
    fs.writeFileSync(target, 'disk', 'utf8');
    const records: Array<{ path: string; content: string | undefined }> = [];
    const { env } = makeEnv({ appliedInEditor: true, dirty: true, records });
    applyPatchDecision(env, {
      patchId: 's2',
      resolvedPath: target,
      oldContent: 'disk',
      newContent: 'agent',
    });
    expect(records).toEqual([{ path: target, content: 'disk' }]);
  });

  it('通路2：脏文档拒绝落盘 -> 不记录（没有任何改动发生）', () => {
    fs.writeFileSync(target, 'disk', 'utf8');
    const records: Array<{ path: string; content: string | undefined }> = [];
    const { env } = makeEnv({ dirty: true, records });
    const r = applyPatchDecision(env, {
      patchId: 's3',
      resolvedPath: target,
      oldContent: 'buffer',
      newContent: 'agent',
    });
    expect(r.applied).toBe(false);
    expect(records).toEqual([]);
  });

  it('乐观锁冲突 -> 不记录（写盘没发生，回滚不该把它算进去）', () => {
    fs.writeFileSync(target, 'changed-by-others', 'utf8');
    const records: Array<{ path: string; content: string | undefined }> = [];
    const { env } = makeEnv({ records });
    applyPatchDecision(env, {
      patchId: 's4',
      resolvedPath: target,
      oldContent: 'disk',
      newContent: 'agent',
    });
    expect(records).toEqual([]);
  });

  it('从无到有新建 -> 记录 content 为 undefined（回滚语义即"删除"）', () => {
    const fresh = path.join(root, 'snap-new.txt');
    const records: Array<{ path: string; content: string | undefined }> = [];
    const { env } = makeEnv({ records });
    applyPatchDecision(env, {
      patchId: 's5',
      resolvedPath: fresh,
      oldContent: undefined,
      newContent: 'hello',
    });
    expect(records).toEqual([{ path: fresh, content: undefined }]);
  });

  it('编辑后应用：快照仍取 oldContent，而不是用户编辑后的内容', () => {
    fs.writeFileSync(target, 'disk', 'utf8');
    const records: Array<{ path: string; content: string | undefined }> = [];
    const { env } = makeEnv({ edited: 'user-edited', records });
    applyPatchDecision(env, {
      patchId: 's6',
      resolvedPath: target,
      oldContent: 'disk',
      newContent: 'agent',
    });
    expect(records).toEqual([{ path: target, content: 'disk' }]);
    expect(fs.readFileSync(target, 'utf8')).toBe('user-edited');
  });
});

describe('describePatchOutcome', () => {
  it('三条通路的文案各自可辨', () => {
    expect(describePatchOutcome({ applied: true, appliedInEditor: false }, '/a.ts')).toBe('已写入 /a.ts');
    const editor = describePatchOutcome({ applied: false, appliedInEditor: true }, '/a.ts');
    expect(editor).toContain('编辑器缓冲区');
    expect(editor).toContain('未落盘');
    expect(describePatchOutcome({ applied: false, appliedInEditor: false, error: 'boom' }, '/a.ts')).toBe(
      '写入失败：boom'
    );
  });
});
