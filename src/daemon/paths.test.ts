import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { assertPathInside, isPathInside } from './paths';

describe('isPathInside 路径护栏', () => {
  const root = path.resolve('/workspace/project');

  it('目标等于根目录：允许', () => {
    expect(isPathInside(root, root)).toBe(true);
  });

  it('根目录内子路径：允许', () => {
    expect(isPathInside(root, path.join(root, 'src', 'a.ts'))).toBe(true);
  });

  it('兄弟目录：拒绝', () => {
    expect(isPathInside(root, path.join(path.dirname(root), 'other', 'b.ts'))).toBe(false);
  });

  it('`..` 逃逸：拒绝', () => {
    expect(isPathInside(root, path.join(root, '..', 'secret.txt'))).toBe(false);
  });

  it('同名前缀目录：拒绝（/a/b vs /a/bc）', () => {
    expect(isPathInside(path.resolve('/a/b'), path.resolve('/a/bc/file.txt'))).toBe(false);
  });

  it('assertPathInside 越界时抛错并携带协议错误码', () => {
    expect(() => assertPathInside(root, path.join(root, '..', 'secret.txt'))).toThrow();
    try {
      assertPathInside(root, path.join(root, '..', 'secret.txt'));
      expect.unreachable('应当抛出异常');
    } catch (err) {
      expect((err as { code?: number }).code).toBe(-32012);
    }
  });
});
