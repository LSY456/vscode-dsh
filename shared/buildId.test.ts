import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEV_BUILD_ID, isStaleDaemon, readBuildId } from './buildId';

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-buildid-'));
});
afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('readBuildId', () => {
  it('工作区内无 buildId.json（开发态）-> 返回 dev 指纹', () => {
    const empty = fs.mkdtempSync(path.join(tmp, 'noid-'));
    try {
      expect(readBuildId(empty)).toBe(DEV_BUILD_ID);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('向上查找命中 buildId.json（模拟 out/daemon 与 out/ 两种位置）', () => {
    const out = fs.mkdtempSync(path.join(tmp, 'out-'));
    const id = 'a1b2c3d4e5f60718';
    fs.writeFileSync(path.join(out, 'buildId.json'), JSON.stringify({ id, ts: Date.now() }));
    // daemon 位置（out/daemon）
    const daemonDir = path.join(out, 'daemon');
    fs.mkdirSync(daemonDir);
    expect(readBuildId(daemonDir)).toBe(id);
    // 扩展位置（out）
    expect(readBuildId(out)).toBe(id);
    // 更深层级也能向上命中
    const deep = path.join(out, 'daemon', 'nested');
    fs.mkdirSync(deep, { recursive: true });
    expect(readBuildId(deep)).toBe(id);
  });

  it('文件损坏时跳过并继续向上查找', () => {
    const out = fs.mkdtempSync(path.join(tmp, 'bad-'));
    fs.writeFileSync(path.join(out, 'buildId.json'), '{not-json');
    // 向上到 tmp 也没有 -> dev
    expect(readBuildId(out)).toBe(DEV_BUILD_ID);
    // 上层目录放一个，向上应命中
    fs.writeFileSync(path.join(tmp, 'buildId.json'), JSON.stringify({ id: 'from-parent' }));
    try {
      expect(readBuildId(out)).toBe('from-parent');
    } finally {
      fs.unlinkSync(path.join(tmp, 'buildId.json'));
    }
  });
});

describe('isStaleDaemon（陈旧判定边界）', () => {
  it('两侧一致 = 不陈旧', () => {
    expect(isStaleDaemon('abc123', 'abc123')).toBe(false);
  });
  it('两侧不一致 = 陈旧（升级后复用了旧构建 daemon）', () => {
    expect(isStaleDaemon('new-build-9f', 'old-build-3a')).toBe(true);
  });
  it('daemon 未上报 buildId（协议旧版本）-> 不触发回收', () => {
    expect(isStaleDaemon('abc', undefined)).toBe(false);
  });
  it('本地为 dev 指纹（开发环境）-> 不触发回收', () => {
    expect(isStaleDaemon(DEV_BUILD_ID, 'anything')).toBe(false);
    expect(isStaleDaemon('', 'anything')).toBe(false);
  });
  it('daemon 侧 dev 指纹 -> 不触发回收', () => {
    expect(isStaleDaemon('abc', DEV_BUILD_ID)).toBe(false);
  });
});