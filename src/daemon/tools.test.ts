import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkPatchConflict,
  classifyCommandRisk,
  createWalkState,
  DEFAULT_WALK_LIMITS,
  evaluateCommandPolicy,
  executeCommand,
  globFiles,
  grepFiles,
  listDirectory,
  PathError,
  readFileRange,
  readTextFile,
  resolveTarget,
  riskReason,
  sliceLines,
  tryReadFile,
  walkFiles,
  writeTextFile,
  type WalkLimits,
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

describe('行号范围精读（sliceLines / readFileRange）', () => {
  const lines = ['L1', 'L2', 'L3', 'L4', 'L5'];

  it('sliceLines：缺省返回全文，行号前缀为 1-based', () => {
    const r = sliceLines(lines);
    expect(r.startLine).toBe(1);
    expect(r.endLine).toBe(5);
    expect(r.totalLines).toBe(5);
    expect(r.content).toBe('1| L1\n2| L2\n3| L3\n4| L4\n5| L5');
  });

  it('sliceLines：startLine/endLine 为 1-based 且含端点', () => {
    const r = sliceLines(lines, { startLine: 2, endLine: 4 });
    expect(r.startLine).toBe(2);
    expect(r.endLine).toBe(4);
    expect(r.totalLines).toBe(5);
    expect(r.content).toBe('2| L2\n3| L3\n4| L4');
  });

  it('sliceLines：非法/越界行号被钳制，单次行数受 maxLines 限制', () => {
    expect(sliceLines(lines, { startLine: 0 }).startLine).toBe(1);
    const beyond = sliceLines(lines, { startLine: 4, endLine: 999 });
    expect([beyond.startLine, beyond.endLine]).toEqual([4, 5]);
    expect(sliceLines(lines, { maxLines: 2 }).endLine).toBe(2);
    // 区间倒置时退化为只返回 start 所在的一行，而不是空串
    const inverted = sliceLines(lines, { startLine: 5, endLine: 2 });
    expect([inverted.startLine, inverted.endLine]).toEqual([5, 5]);
    expect(inverted.content).toBe('5| L5');
  });

  it('readFileRange：磁盘直读与对同一文本 sliceLines 等价', () => {
    const target = path.join(root, 'range.txt');
    fs.writeFileSync(target, lines.join('\n'), 'utf8');
    expect(readFileRange(root, [], target, { startLine: 2, endLine: 3 })).toEqual(
      sliceLines(lines, { startLine: 2, endLine: 3 })
    );
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

  it('grep：pattern 按正则解析（| 多选一），不再是字面量匹配', () => {
    // 回归：早期实现只做 includes，模型写 `foo|bar` 时一律无匹配，
    // 于是误判"代码里没有这个符号"并反复换模式重试，把过程面板刷满。
    const res = grepFiles(base, [], 'foo|bar');
    expect(res.matches.length).toBeGreaterThan(0);
    expect(res.matches.some((m) => path.basename(m.file) === 'src.ts')).toBe(true);
  });

  it('grep：非法正则回退字面量匹配（不抛错，且确实是字面量语义）', () => {
    // 'foo(' 不是合法正则（未闭合分组）-> 回退到 includes('foo(')
    // fixtures 里 `function foo() {}` 恰含该字面量，故应命中 src.ts 第 1 行。
    // 用"应当命中"而不是"应当为空"来断言，才真正证明回退走的是字面量语义。
    expect(() => grepFiles(base, [], 'foo(')).not.toThrow();
    const res = grepFiles(base, [], 'foo(');
    expect(res.matches).toHaveLength(1);
    expect(path.basename(res.matches[0].file)).toBe('src.ts');
    expect(res.matches[0].line).toBe(1);
    // 字面量里没有的串一律不命中（若被当成正则会误报）
    expect(grepFiles(base, [], '[[[').matches).toHaveLength(0);
  });

  it('grep：pattern 超长被拒绝（挡 ReDoS 型输入）', () => {
    expect(() => grepFiles(base, [], 'a'.repeat(1001))).toThrow();
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

describe('walkFiles 预算与去重（P1-2：别让一次搜索卡死事件循环）', () => {
  /** 宽而平：一层 40 个文件 —— 用来触发「条目数」上限 */
  let wide: string;
  /** 深而窄：a/b/c/leaf.txt —— 用来触发「深度」上限 */
  let deepDir: string;
  let wideCanon: string;
  let deepCanon: string;

  const limits = (over: Partial<WalkLimits>): WalkLimits => ({ ...DEFAULT_WALK_LIMITS, ...over });

  beforeAll(() => {
    wide = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-walk-wide-'));
    for (let i = 0; i < 40; i += 1) fs.writeFileSync(path.join(wide, `w${i}.txt`), 'x', 'utf8');
    wideCanon = fs.realpathSync(wide);

    deepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-walk-deep-'));
    let cur = deepDir;
    for (const name of ['a', 'b', 'c']) {
      cur = path.join(cur, name);
      fs.mkdirSync(cur);
    }
    fs.writeFileSync(path.join(cur, 'leaf.txt'), 'x', 'utf8');
    deepCanon = fs.realpathSync(deepDir);
  });

  afterAll(() => {
    for (const dir of [wide, deepDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('缺省预算：完整走完，不发 exhausted 信号', () => {
    const state = createWalkState();
    const files = [...walkFiles(wide, wideCanon, DEFAULT_WALK_LIMITS, state)];
    expect(files).toHaveLength(40);
    expect(state.exhausted).toBe(false);
  });

  it('条目数上限：到点即停并置 exhausted（宽目录不再拖死整轮）', () => {
    const l = limits({ maxEntries: 5 });
    const state = createWalkState(l);
    const files = [...walkFiles(wide, wideCanon, l, state)];
    expect(state.exhausted).toBe(true);
    expect(files).toHaveLength(5);
  });

  it('深度上限：到点即停并置 exhausted（深目录树不会走到天涯）', () => {
    const l = limits({ maxDepth: 1 });
    const state = createWalkState(l);
    const files = [...walkFiles(deepDir, deepCanon, l, state)];
    expect(state.exhausted).toBe(true);
    // leaf.txt 位于第 3 层，被深度预算挡在外面 —— 这正是"没有静默给半份结果"的反面：
    // 调用方拿到的是 exhausted=true，可以如实告诉模型"没搜完"
    expect(files).toEqual([]);
  });

  it('时间预算用尽：立刻停止并不产出（墙钟是最后一道保险）', () => {
    const l = limits({ timeBudgetMs: -1 }); // deadline 落在过去，等价于"预算已耗尽"
    const state = createWalkState(l);
    const files = [...walkFiles(wide, wideCanon, l, state)];
    expect(files).toEqual([]);
    expect(state.exhausted).toBe(true);
  });

  it('共享 state 的多次调用：第一次耗尽后第二次直接返回（预算不被重置）', () => {
    const l = limits({ maxEntries: 3 });
    const state = createWalkState(l);
    expect([...walkFiles(wide, wideCanon, l, state)]).toHaveLength(3);
    expect(state.exhausted).toBe(true);
    // 同一个 state 再走：不再产出，也不会"续着走"绕开预算
    expect([...walkFiles(wide, wideCanon, l, state)]).toEqual([]);
  });

  it('符号链接自指不造成无限递归（realpath 去重切断环）', () => {
    const cycle = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-walk-cycle-'));
    const canon = fs.realpathSync(cycle);
    fs.writeFileSync(path.join(cycle, 'a.txt'), 'x', 'utf8');
    try {
      // 指向自身的 junction：没有 visited 去重的话这里会无限递归
      fs.symlinkSync(cycle, path.join(cycle, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      fs.rmSync(cycle, { recursive: true, force: true });
      return; // 环境不允许建链接（无权限）时跳过，不制造假失败
    }
    try {
      const state = createWalkState();
      const files = [...walkFiles(cycle, canon, DEFAULT_WALK_LIMITS, state)];
      // 环只被忽略，不产出额外项，也不触发 exhausted（它是"已访问"，不是"超预算"）
      expect(files.map((f) => path.basename(f))).toEqual(['a.txt']);
      expect(state.exhausted).toBe(false);
    } finally {
      try {
        fs.rmSync(path.join(cycle, 'loop'), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      fs.rmSync(cycle, { recursive: true, force: true });
    }
  });

  it('grep / glob 把遍历状态带出来（walkExhausted 恒为布尔，不再是 undefined）', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-walk-out-'));
    fs.writeFileSync(path.join(base, 'x.ts'), 'needle\n', 'utf8');
    try {
      const g = grepFiles(base, [], 'needle');
      expect(g.walkExhausted).toBe(false);
      expect(typeof g.walkExhausted).toBe('boolean');
      const gl = globFiles(base, [], '*.ts');
      expect(gl.walkExhausted).toBe(false);
      expect(typeof gl.walkExhausted).toBe('boolean');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

/**
 * P2-9 审批风险分级。
 *
 * 分级的用途是**让 UI 差异化呈现**，不是放宽审批 —— 因此这里除了分级本身，
 * 还要钉住"低危不等于免审批"这条边界在文案里被说出来。
 */
describe('classifyCommandRisk（P2-9 风险分级）', () => {
  it('删除类 -> high（本分级独立于策略拒绝，rm -rf 即便被策略拦下也仍是 high）', () => {
    for (const cmd of [
      'rm -rf build/',
      'rm -fr build/',
      'rm -f a.txt',
      'rm --recursive dir',
      'del /f /s /q dist',
      'rd /s /q dist',
      'git reset --hard HEAD~1',
      'git clean -fdx',
      'git push origin main --force',
      'taskkill /f /im node.exe',
      'dd if=/dev/zero of=x',
      'shutdown /r',
    ]) {
      expect(classifyCommandRisk(cmd), cmd).toBe('high');
    }
  });

  it('写文件 / 网络 / 版本库状态变更 -> medium', () => {
    for (const cmd of [
      'mv a.txt b.txt',
      'cp -r src dst',
      'mkdir -p out',
      'sed -i "s/a/b/" f.ts',
      'chmod 755 run.sh',
      'git commit -m "x"',
      'npm install lodash',
      'pip install requests',
      'curl -s https://example.com',
      'wget https://example.com/a.zip',
      'echo hi > out.txt',
      'echo hi >> out.txt',
    ]) {
      expect(classifyCommandRisk(cmd), cmd).toBe('medium');
    }
  });

  it('只读命令 -> low', () => {
    for (const cmd of [
      'ls -la',
      'cat package.json',
      'grep -rn TODO src',
      'git status',
      'git log --oneline -5',
      'node --version',
      'pwd',
      'wc -l README.md',
      'find . -name "*.ts"',
    ]) {
      expect(classifyCommandRisk(cmd), cmd).toBe('low');
    }
  });

  it('未知命令按保守值 medium（把未知当 low 会让没见过的写法获得更弱提示）', () => {
    expect(classifyCommandRisk('frobnicate --all')).toBe('medium');
    expect(classifyCommandRisk('npm run build')).toBe('medium'); // 跑构建脚本可能写盘
    expect(classifyCommandRisk('python train.py')).toBe('medium'); // 执行任意代码
  });

  it('复合命令取最高等级（不能只看首片段）', () => {
    expect(classifyCommandRisk('ls && rm -rf x')).toBe('high');
    expect(classifyCommandRisk('cat a.txt | tee b.txt')).toBe('medium');
    expect(classifyCommandRisk('npm run build && git push origin main')).toBe('medium');
    expect(classifyCommandRisk('git status; rm -f x')).toBe('high');
    // 演示场景里的那条命令：首片段 rm -rf 必须把整体拉到 high
    expect(classifyCommandRisk('rm -rf build/ && npm run build')).toBe('high');
  });

  it('只读命令 + 破坏性重定向 -> medium（不能因首词是 cat/ls 就判 low）', () => {
    expect(classifyCommandRisk('cat src.txt > dest.txt')).toBe('medium');
    expect(classifyCommandRisk('ls -la > listing.txt')).toBe('medium');
  });

  it('空命令 -> medium（无从判断，按保守值）', () => {
    expect(classifyCommandRisk('')).toBe('medium');
    expect(classifyCommandRisk('   ')).toBe('medium');
    expect(classifyCommandRisk(undefined as unknown as string)).toBe('medium');
  });

  it('大小写不敏感', () => {
    expect(classifyCommandRisk('RM -RF X')).toBe('high');
    expect(classifyCommandRisk('Git Reset --hard')).toBe('high');
  });

  it('riskReason：三个等级文案互不相同，且都点明"仍需审批"的事实', () => {
    const high = riskReason('high', 'rm -rf x');
    const medium = riskReason('medium', 'mv a b');
    const low = riskReason('low', 'ls');
    expect(new Set([high, medium, low]).size).toBe(3);
    expect(high).toContain('高危');
    expect(medium).toContain('人工批准');
    expect(low).toContain('仍需人工批准'); // 低危不等于免审批
    // 命令原文要出现（截断后），用户才能核对是哪条
    expect(high).toContain('rm -rf x');
  });

  it('riskReason：超长命令截断到 200 字符以内，不把整条命令灌进审批卡', () => {
    const long = 'a'.repeat(1000);
    const reason = riskReason('medium', long);
    expect(reason.length).toBeLessThanOrEqual(300);
    expect(reason).not.toContain('a'.repeat(201));
  });
});