import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BwrapSandbox,
  confineCwd,
  detectSandbox,
  ProcessSandbox,
  sanitizeEnv,
} from './sandbox';

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sb-'));
}

describe('sanitizeEnv', () => {
  it('仅保留白名单环境变量，剥离 token 与密钥', () => {
    const env = sanitizeEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/home/u',
      SystemRoot: 'C:\\Windows',
      DSH_DAEMON_TOKEN: 'secret-token',
      DEEPSEEK_API_KEY: 'sk-deep-secret',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      OPENAI_API_KEY: 'sk-open-secret',
      MY_APP_SECRET: 'x',
    });

    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.SystemRoot).toBe('C:\\Windows');
    // 敏感项必须被剥离
    expect(env.DSH_DAEMON_TOKEN).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.MY_APP_SECRET).toBeUndefined();
  });
});

describe('confineCwd', () => {
  it('空值与越界路径回退工作区根，工作区内路径保留', () => {
    const ws = tempWorkspace();
    const inside = path.join(ws, 'sub');
    fs.mkdirSync(inside, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-out-'));
    try {
      expect(confineCwd('', ws)).toBe(ws);
      expect(confineCwd(inside, ws)).toBe(inside); // 工作区内保留（realpath）
      expect(confineCwd(outside, ws)).toBe(ws); // 越界回退
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('ProcessSandbox', () => {
  it('prepare 产出显式 shell 二分、cwd 受约束且环境已清洗', () => {
    const ws = tempWorkspace();
    const sb = new ProcessSandbox({ workspaceRoot: ws });
    const spec = sb.prepare('echo hi', ws);
    try {
      expect(spec.shell).toBe(false);
      expect(spec.cwd).toBe(ws);
      expect(spec.env.DSH_DAEMON_TOKEN).toBeUndefined();
      expect(spec.env.PATH).toBeDefined();
      if (process.platform === 'win32') {
        expect(spec.command.toLowerCase()).toContain('cmd.exe');
        expect(spec.args).toEqual(['/d', '/s', '/c', 'echo hi']);
      } else {
        expect(spec.command).toBe('/bin/sh');
        expect(spec.args).toEqual(['-c', 'echo hi']);
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('BwrapSandbox', () => {
  it('prepare 用 bwrap 命名空间隔离包住命令（只读根 + 工作区可写 + 干净环境）', () => {
    const ws = '/workspace';
    const sb = new BwrapSandbox({ workspaceRoot: ws });
    const spec = sb.prepare('rm -rf x', ws);

    expect(spec.command).toBe('bwrap');
    expect(spec.args).toContain('--unshare-all');
    expect(spec.args).toContain('--die-with-parent');
    expect(spec.args).toContain('--ro-bind');
    expect(spec.args).toContain('--clearenv');
    // 工作区目录以可写 bind 暴露
    expect(spec.args[spec.args.indexOf('--bind') + 1]).toBe(ws);
    // 末尾是 /bin/sh -c <command>
    expect(spec.args.slice(-3)).toEqual(['/bin/sh', '-c', 'rm -rf x']);
    expect(spec.env).toEqual({});
  });
});

describe('detectSandbox', () => {
  it('非 Linux 平台降级为应用层兜底并告警', () => {
    const d = detectSandbox('/ws', { platform: 'win32' });
    expect(d.sandbox).toBeInstanceOf(ProcessSandbox);
    expect(d.warnings.length).toBeGreaterThan(0);
    expect(d.warnings[0]).toContain('应用层加固');
  });

  it('Linux + bwrap 可用时启用 BwrapSandbox（无告警）', () => {
    const d = detectSandbox('/ws', { platform: 'linux', hasBwrap: () => true });
    expect(d.sandbox).toBeInstanceOf(BwrapSandbox);
    expect((d.sandbox as BwrapSandbox).kind).toBe('bwrap');
    expect(d.warnings).toEqual([]);
  });

  it('Linux 但 bwrap 缺失时降级为应用层兜底并告警', () => {
    const d = detectSandbox('/ws', { platform: 'linux', hasBwrap: () => false });
    expect(d.sandbox).toBeInstanceOf(ProcessSandbox);
    expect(d.warnings.length).toBeGreaterThan(0);
    expect(d.warnings[0]).toContain('bubblewrap');
  });
});