import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertPathInside, isPathInside } from './paths';

describe('isPathInside 词法护栏', () => {
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
});

describe('assertPathInside canonical 护栏（防符号链接/联结逃逸）', () => {
  let root = '';
  let outside = '';
  let symlinkSupported = false;

  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-paths-'));
    root = path.join(base, 'workspace');
    outside = path.join(base, 'outside');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOPSECRET', 'utf8');
    fs.writeFileSync(path.join(root, 'inside.txt'), 'ok', 'utf8');

    // 探测本机是否允许建符号链接（Windows 需 Developer Mode / 管理员，junction 目录链接通常免提权）
    try {
      fs.symlinkSync(outside, path.join(root, 'link-out'), 'junction');
      symlinkSupported = true;
    } catch {
      symlinkSupported = false;
    }
  });

  afterAll(() => {
    try {
      fs.rmSync(path.dirname(root), { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  });

  it('工作区内现有文件：返回 canonical 绝对路径', () => {
    const target = path.join(root, 'inside.txt');
    const resolved = assertPathInside(root, target);
    expect(resolved).toBe(fs.realpathSync(target));
  });

  it('工作区内不存在的写入目标：返回 canonical 父目录 + 相对名', () => {
    const resolved = assertPathInside(root, path.join(root, 'nested', 'new.txt'));
    expect(resolved).toBe(path.join(fs.realpathSync(root), 'nested', 'new.txt'));
  });

  it('越界：抛 PathError(-32012)', () => {
    expect(() => assertPathInside(root, path.join(outside, 'secret.txt'))).toThrow();
    try {
      assertPathInside(root, path.join(outside, 'secret.txt'));
      expect.unreachable('应当抛出异常');
    } catch (err) {
      expect((err as { code?: number }).code).toBe(-32012);
    }
  });

  it('`..` 逃逸：抛 PathError(-32012)', () => {
    expect(() => assertPathInside(root, path.join(root, '..', 'secret.txt'))).toThrow();
  });

  it('符号链接/联结逃逸：工作区内链接指向外部，须拒绝', (ctx) => {
    if (!symlinkSupported) {
      ctx.skip();
      return;
    }
    const linkToSecret = path.join(root, 'link-out', 'secret.txt');
    expect(() => assertPathInside(root, linkToSecret)).toThrow();
    try {
      assertPathInside(root, linkToSecret);
      expect.unreachable('应当抛出异常');
    } catch (err) {
      expect((err as { code?: number }).code).toBe(-32012);
    }
  });
});