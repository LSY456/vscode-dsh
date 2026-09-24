import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertPathInside, isPathInside, pathKey } from './paths';

describe('pathKey（P0-1 覆盖层键归一）', () => {
  const p = path.resolve('/workspace/project/src/a.ts');

  it('绝对化：相对路径折叠为绝对路径', () => {
    expect(pathKey('src/a.ts')).toBe(pathKey(path.resolve('src/a.ts')));
  });

  it('折叠 .. 与重复分隔符：不同写法得到同一键', () => {
    expect(pathKey('/workspace/project/src/../src/a.ts')).toBe(pathKey(p));
    expect(pathKey('/workspace/project//src///a.ts')).toBe(pathKey(p));
  });

  it('Windows 忽略大小写（同一文件的大小写差异不应漏配）', () => {
    if (process.platform !== 'win32') return;
    expect(pathKey('C:\\Work\\A.ts')).toBe(pathKey('c:\\work\\a.ts'));
  });

  it('Linux 大小写敏感（不误合并两个不同文件）', () => {
    if (process.platform === 'win32') return;
    expect(pathKey('/w/A.ts')).not.toBe(pathKey('/w/a.ts'));
  });
});

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

  it('相对路径按工作区根解析（daemon 的 cwd 未必等于工作区根）', () => {
    // 模型天然会写 `.` / `src` 这类相对路径；若按 daemon 进程的 cwd 解析，会被误判"路径越界"，
    // 逼模型改用需要审批的 bash_execute 去列目录 —— 真实会话实测：8 轮工具预算全耗在
    // "先把目录列出来"上，最后没有轮次留给结论，会话以 completed 静默收场。
    expect(assertPathInside(root, '.')).toBe(fs.realpathSync(root));
    expect(assertPathInside(root, './')).toBe(fs.realpathSync(root));
    expect(assertPathInside(root, 'inside.txt')).toBe(fs.realpathSync(path.join(root, 'inside.txt')));
    expect(assertPathInside(root, 'src')).toBe(path.join(fs.realpathSync(root), 'src'));
  });

  it('相对路径的 `..` 逃逸仍被拒绝（放宽相对路径 ≠ 放宽护栏）', () => {
    expect(() => assertPathInside(root, path.join('..', 'secret.txt'))).toThrow();
    expect(() => assertPathInside(root, path.join('src', '..', '..', 'secret.txt'))).toThrow();
  });

  it('相对路径指向工作区内的符号链接逃逸：仍被拒绝', (ctx) => {
    if (!symlinkSupported) {
      ctx.skip();
      return;
    }
    expect(() => assertPathInside(root, path.join('link-out', 'secret.txt'))).toThrow();
  });
});