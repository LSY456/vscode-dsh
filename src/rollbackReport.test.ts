import { describe, expect, it } from 'vitest';
import { ROLLBACK_LIST_LIMIT, formatRollbackReport, shortPath } from './rollbackReport';
import type { SessionRollbackResult } from '../shared/protocol';

/**
 * 回滚结果 → 用户可读文案。
 *
 * 关键取舍：**分类必须能分辨**。「全部还原成功」与「3 个文件因为编辑器里还没保存被跳过」
 * 对用户的下一步动作完全不同（后者要先去保存或放弃改动）；压成一句"回滚完成"就等于
 * 把需要用户动手的部分藏起来了。
 */

function report(over: Partial<SessionRollbackResult> = {}): SessionRollbackResult {
  return {
    total: 0,
    restored: [],
    deleted: [],
    skippedDirty: [],
    changedAfter: [],
    unrestorable: [],
    failed: [],
    unrecorded: 0,
    ...over,
  };
}

describe('formatRollbackReport', () => {
  it('本次会话没改过文件 -> 明说"无需回滚"，而不是"回滚了 0 个"', () => {
    const s = formatRollbackReport(report());
    expect(s.headline).toContain('没有改动过任何文件');
    expect(s.detail).toBe('');
  });

  it('全部成功 -> 结论给出总数，明细分列还原与删除', () => {
    const s = formatRollbackReport(
      report({
        total: 3,
        restored: ['/ws/a.ts', '/ws/b.ts'],
        deleted: ['/ws/c.ts'],
      }),
      { workspaceRoot: '/ws' }
    );
    expect(s.headline).toBe('已回滚本次会话的 3 处文件改动');
    expect(s.detail).toContain('还原为改动前：a.ts、b.ts');
    expect(s.detail).toContain('删除（本次会话新建）：c.ts');
  });

  it('有脏文档跳过 -> 结论里带上"未处理"，明细说清为什么以及怎么办', () => {
    const s = formatRollbackReport(
      report({ total: 2, restored: ['/ws/a.ts'], skippedDirty: ['/ws/b.ts'] }),
      { workspaceRoot: '/ws' }
    );
    expect(s.headline).toBe('已回滚 1 处文件改动，另有 1 处未处理');
    expect(s.detail).toContain('编辑器里有未保存的改动');
    expect(s.detail).toContain('先保存或放弃这些改动后再回滚');
  });

  it('内容已变的文件单独成行（与"脏文档跳过"是两回事：一个先保存，一个先看看改了什么）', () => {
    const s = formatRollbackReport(
      report({
        total: 2,
        restored: ['/ws/a.ts'],
        changedAfter: [{ path: '/ws/b.ts', reason: '文件内容在本次会话之后被修改过，未覆盖' }],
      }),
      { workspaceRoot: '/ws' }
    );
    expect(s.headline).toBe('已回滚 1 处文件改动，另有 1 处未处理');
    expect(s.detail).toContain('在本次会话之后又被改过');
    expect(s.detail).toContain('b.ts');
    expect(s.detail).not.toContain('编辑器里有未保存的改动');
  });

  it('不可还原 / 失败各自成行，并带上原因', () => {
    const s = formatRollbackReport(
      report({
        total: 2,
        unrestorable: [{ path: '/ws/big.ts', reason: '文件过大' }],
        failed: [{ path: '/ws/locked.ts', error: 'EBUSY' }],
      }),
      { workspaceRoot: '/ws' }
    );
    expect(s.headline).toContain('另有 2 处未处理');
    expect(s.detail).toContain('big.ts（文件过大）');
    expect(s.detail).toContain('locked.ts（EBUSY）');
  });

  it('有未记录的改动 -> 明说"回滚可能不完整"，不假装成功', () => {
    const s = formatRollbackReport(report({ total: 1, restored: ['/ws/a.ts'], unrecorded: 4 }), {
      workspaceRoot: '/ws',
    });
    expect(s.headline).toContain('另有 4 处未处理');
    expect(s.detail).toContain('4 处改动未纳入回滚');
    expect(s.detail).toContain('需自行处理');
  });

  it('路径太多时折叠，不会把面板糊满', () => {
    const many = Array.from({ length: ROLLBACK_LIST_LIMIT + 3 }, (_, i) => `/ws/f${i}.ts`);
    const s = formatRollbackReport(report({ total: many.length, restored: many }), { workspaceRoot: '/ws' });
    expect(s.detail).toContain(`等 ${many.length} 个`);
  });
});

describe('shortPath', () => {
  it('工作区内的绝对路径缩成相对路径', () => {
    expect(shortPath('/ws/src/a.ts', '/ws')).toBe('src/a.ts');
  });

  it('工作区根自身显示为 .', () => {
    expect(shortPath('/ws', '/ws')).toBe('.');
  });

  it('不在工作区内则原样返回（不猜、不硬缩）', () => {
    expect(shortPath('/other/a.ts', '/ws')).toBe('/other/a.ts');
  });

  it('没给工作区根则原样返回', () => {
    expect(shortPath('/ws/a.ts')).toBe('/ws/a.ts');
  });

  it('前缀相似但不是同一目录时不误缩', () => {
    expect(shortPath('/wsx/a.ts', '/ws')).toBe('/wsx/a.ts');
  });

  it('Windows 反斜杠路径与大小写差异都能对上', () => {
    const p = shortPath('C:\\WS\\src\\a.ts', 'C:/ws');
    if (process.platform === 'win32') {
      expect(p).toBe('src/a.ts');
    } else {
      // 非 Windows 不折叠大小写，此时前缀不匹配，原样返回即可（不做猜测）
      expect(p).toBe('C:\\WS\\src\\a.ts');
    }
  });
});
