/**
 * `.dsh/` 自守忽略（P0-3）验证。
 *
 * 要钉住的核心行为：**只有名为 `.dsh` 的目录才写 `.gitignore`** —— 这个函数被复用在
 * "建 history.json 所在目录"这类场景，给任意临时目录塞忽略文件是越界。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DSH_DIR_NAME,
  DSH_GITIGNORE_CONTENT,
  dshDirPath,
  ensureDshDir,
} from './dshDir';

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dshdir-'));
});

afterEach(() => {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('ensureDshDir：.dsh 的自我封闭', () => {
  it('创建 .dsh 时写出 .gitignore，内容是一行 `*`（整个目录不进版本库）', () => {
    const dir = dshDirPath(base);
    ensureDshDir(dir);

    expect(fs.existsSync(dir)).toBe(true);
    const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    // 关键行：`*` 必须是真实生效的规则行（不是被注释掉的样子）
    expect(ignore.split(/\r?\n/)).toContain('*');
    expect(ignore).toBe(DSH_GITIGNORE_CONTENT);
  });

  it('目录名不是 .dsh 时不写 .gitignore（只建目录）', () => {
    const dir = path.join(base, 'nested', 'dir');
    ensureDshDir(dir);

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false);
  });

  it('已存在的 .gitignore 不被覆盖（用户可能自己加过规则）', () => {
    const dir = dshDirPath(base);
    ensureDshDir(dir);
    const ignore = path.join(dir, '.gitignore');
    fs.writeFileSync(ignore, 'custom-rule\n');

    ensureDshDir(dir);
    expect(fs.readFileSync(ignore, 'utf8')).toBe('custom-rule\n');
  });

  it('幂等：重复调用不报错、目录保持可用', () => {
    const dir = dshDirPath(base);
    ensureDshDir(dir);
    ensureDshDir(dir);
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(true);
  });

  it('目录不可建（父路径是文件）时不抛错，也不影响调用方', () => {
    const blocker = path.join(base, 'blocker');
    fs.writeFileSync(blocker, 'x');
    expect(() => ensureDshDir(path.join(blocker, DSH_DIR_NAME))).not.toThrow();
  });
});
