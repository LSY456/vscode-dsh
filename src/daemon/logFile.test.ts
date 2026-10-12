import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { attachStreamLog, createFileLog } from './logFile';

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-'));
});
afterAll(() => {
  try {
    // `maxRetries`：Windows 上刚写过的文件常被杀软 / 索引器短暂占用，rmSync 会重试而不是立刻放弃。
    // 显式给 hook 30s：默认 10s 曾在机器负载高时把整个文件判成 fail —— 4 个用例全过也没用，
    // 失败点是清理钩子（2026-10-12 实测遇到一次）。清理慢不该让"测试是否通过"变成随机数。
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* ignore */
  }
}, 30_000);

describe('daemon 日志落盘（C2）', () => {
  it('createFileLog.write 落盘字符串与中文（UTF-8）', () => {
    const logFile = path.join(tmp, '.dsh', 'logs', 'daemon.log');
    const log = createFileLog(logFile);
    log.write('DSH_DAEMON_PORT=12345\n');
    log.write('[dsh-daemon] 缺少 token：缺少令牌\n');
    log.close();

    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('DSH_DAEMON_PORT=12345');
    expect(content).toContain('缺少 token：缺少令牌');
  });

  it('attachStreamLog 镜像 getStream stdout.write（tee 原样透传 + 落盘），restore 后解除', () => {
    const logFile = path.join(tmp, 'tee.log');
    const restore = attachStreamLog(logFile);
    const wrote = process.stdout.write('tee-direct\n');
    expect(wrote).toBe(true); // 原 write 仍正常返回
    restore();

    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('tee-direct');

    process.stdout.write('after-restore\n'); // 不再落盘
    expect(fs.readFileSync(logFile, 'utf8')).not.toContain('after-restore');
  });

  it('命中大小上限时轮转为带时间戳的历史文件', () => {
    const logFile = path.join(tmp, 'rotate.log');
    const log = createFileLog(logFile, 64); // 小上限触发轮转
    for (let i = 0; i < 20; i++) {
      log.write('rotate-marker-' + i + '-' + 'x'.repeat(16) + '\n');
    }
    log.close();

    const dir = path.dirname(logFile);
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('rotate'));
    // 应产生当前文件 + 至少一个轮转归档
    expect(files.length).toBeGreaterThanOrEqual(2);
    const rotated = files.filter((f) => /rotate-\d+\.log$/.test(f));
    expect(rotated.length).toBeGreaterThanOrEqual(1);
  });

  it('写失败静默（指向不存在父目录的非法路径不抛异常）', () => {
    // 传入一个指向文件的"目录"作为父路径，制造写入失败但不抛
    const blocker = path.join(tmp, 'blocker');
    fs.writeFileSync(blocker, 'x'); // 让 dirname 变成文件，mkdir 失败
    const logFile = path.join(blocker, 'sub', 'daemon.log');
    const log = createFileLog(logFile);
    expect(() => log.write('should-not-throw\n')).not.toThrow();
  });
});