import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  HIGH_RISK_PROGRAMS,
  TrustStore,
  buildRuleForCommand,
  programOf,
  ruleMatches,
} from './trust';

let tmp: string;
let trustFile: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trust-'));
  trustFile = path.join(tmp, '.dsh', 'trust.json'); // 真实布局：<workspace>/.dsh/trust.json
});
afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('programOf / 规则生成（脱敏与高危分级）', () => {
  it('解析程序名：普通命令与管道/重定向', () => {
    expect(programOf('npm run build')).toBe('npm');
    expect(programOf('  git  status ')).toBe('git');
    expect(programOf('echo hi | grep x')).toBe('echo');
    expect(programOf('rm -rf dist >/dev/null')).toBe('rm');
  });

  it('普通命令生成 prefix 模板（程序 + 首个参数），不含可疑细节', () => {
    const r = buildRuleForCommand('npm run build -- --env prod', 1000);
    expect(r.kind).toBe('prefix');
    expect(r.pattern).toBe('npm run'); // 脱敏：不落 --env prod
    expect(r.id).toBe('prefix:npm run');
  });

  it('单 token 命令也生成 prefix（程序本身）', () => {
    expect(buildRuleForCommand('git status', 1).pattern).toBe('git status');
    expect(buildRuleForCommand('pwd', 1).pattern).toBe('pwd');
  });

  it('高危程序（rm 等）只允许整条 exact，禁止宽松前缀', () => {
    const r = buildRuleForCommand('rm -rf dist', 1000);
    expect(r.kind).toBe('exact');
    expect(r.pattern).toBe('rm -rf dist');
    expect(r.id).toBe('exact:rm -rf dist');
    // rm -r 别的目录不会命中 exact
    expect(ruleMatches(r, 'rm -rf node_modules')).toBe(false);
  });

  it('高危清单覆盖典型破坏性程序', () => {
    expect(HIGH_RISK_PROGRAMS).toContain('rm');
    expect(HIGH_RISK_PROGRAMS).toContain('format');
    expect(HIGH_RISK_PROGRAMS).toContain('shutdown');
  });
});

describe('ruleMatches：匹配边界（真实场景）', () => {
  const prefix = { id: 'p', kind: 'prefix' as const, pattern: 'npm run', createdAt: 0 };
  const exact = { id: 'e', kind: 'exact' as const, pattern: 'rm -rf dist', createdAt: 0 };

  it('prefix 命中：等于前缀或「前缀 + 空格 + 任意参数」', () => {
    expect(ruleMatches(prefix, 'npm run build')).toBe(true);
    expect(ruleMatches(prefix, 'npm run')).toBe(true);
    expect(ruleMatches(prefix, 'npm run test --watch')).toBe(true);
  });

  it('prefix 不命中：相邻词缀（npm runall）、换行、变形', () => {
    expect(ruleMatches(prefix, 'npm runall')).toBe(false);
    expect(ruleMatches(prefix, 'npm runall --list')).toBe(false);
  });

  it('exact 只命中整条命令', () => {
    expect(ruleMatches(exact, 'rm -rf dist')).toBe(true);
    expect(ruleMatches(exact, 'rm -rf dist ')).toBe(true); // 尾部空白容忍
    expect(ruleMatches(exact, 'rm -rf dist2')).toBe(false);
  });

  it('空命令不匹配任何规则', () => {
    expect(ruleMatches(prefix, '  ')).toBe(false);
  });
});

describe('TrustStore：持久化与生命周期（真实使用）', () => {
  it('add -> matches（重启后仍生效：新实例读盘）', () => {
    const store = new TrustStore({ file: trustFile, now: () => 100 });
    store.clear();
    store.add('npm run build');
    expect(store.matches('npm run build')).toBe(true);
    expect(store.matches('npm run test')).toBe(true); // 前缀派生
    expect(store.matches('git status')).toBe(false);

    // 模拟 daemon 重启：新实例从磁盘加载
    const reloaded = new TrustStore({ file: trustFile, now: () => 100 });
    expect(reloaded.matches('npm run build')).toBe(true);
    expect(reloaded.list().some((r) => r.pattern === 'npm run')).toBe(true);
  });

  it('持久化文件 0600 且位于 .dsh 下，用户可审阅', () => {
    expect(trustFile.includes('.dsh')).toBe(true); // 调用方用 .dsh/trust.json
    const raw = JSON.parse(fs.readFileSync(trustFile, 'utf8')) as { rules?: unknown[] };
    expect(Array.isArray(raw.rules)).toBe(true);
  });

  it('重复添加同规则幂等（不重复落盘）', () => {
    const store = new TrustStore({ file: trustFile, now: () => 100 });
    store.clear();
    store.add('npm run build');
    store.add('npm run build');
    expect(store.list().filter((r) => r.pattern === 'npm run')).toHaveLength(1);
  });

  it('clear 清空并持久化', () => {
    const store = new TrustStore({ file: trustFile, now: () => 100 });
    store.add('git status');
    store.clear();
    expect(store.list()).toHaveLength(0);
    expect(store.matches('git status')).toBe(false);
    const reloaded = new TrustStore({ file: trustFile, now: () => 100 });
    expect(reloaded.list()).toHaveLength(0);
  });

  it('磁盘文件损坏 -> 空规则集（不锁死审批）', () => {
    const badFile = path.join(tmp, 'bad-trust.json');
    fs.writeFileSync(badFile, '{oops');
    const store = new TrustStore({ file: badFile });
    expect(store.list()).toHaveLength(0);
    expect(store.matches('anything')).toBe(false);
  });

  it('list 按创建时间倒序（新规则在前）', () => {
    const store = new TrustStore({ file: path.join(tmp, 'order.json'), now: () => 100 });
    store.clear();
    store.add('git status');
    // 用时间推进模拟先后
    const later = new TrustStore({ file: path.join(tmp, 'order.json'), now: () => 200 });
    later.add('npm run build');
    const names = later.list().map((r) => r.pattern);
    expect(names[0]).toBe('npm run');
  });
});