import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventTrajectory } from '../../shared/protocol';
import { TrajectoryStore, redactSecrets } from './trajectoryStore';

function rec(step: number, detail?: string): EventTrajectory {
  return { sessionId: 's1', step, kind: 'system', detail: detail ?? `detail-${step}`, ts: Date.now() };
}

const bases: string[] = [];
function mkBase(): string {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-traj-'));
  bases.push(b);
  return b;
}

afterAll(() => {
  for (const b of bases) {
    try {
      fs.rmSync(b, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('TrajectoryStore', () => {
  it('append 后 read 可回读（保持顺序，read 内部 flush）', () => {
    const store = new TrajectoryStore(mkBase());
    store.append('s1', rec(1));
    store.append('s1', rec(2));
    const out = store.read('s1');
    expect(out.map((r) => r.step)).toEqual([1, 2]);
    expect(out[0].detail).toBe('detail-1');
  });

  it('read 不存在的会话返回空数组', () => {
    expect(new TrajectoryStore(mkBase()).read('nope')).toEqual([]);
  });

  it('命中上限时归档旧文件（轮转，flush 之间触发）', () => {
    const base = mkBase();
    const small = new TrajectoryStore(base, 1);
    small.append('s2', rec(1));
    small.flush(); // 第 1 条落盘
    small.append('s2', rec(2));
    small.flush(); // 文件已达上限 -> 轮转 -> 第 2 条落盘
    expect(small.read('s2').map((r) => r.step)).toEqual([2]);
    expect(fs.readdirSync(base).length).toBeGreaterThanOrEqual(2); // 主文件 + 归档文件
  });

  it('close 后 flush 落盘且幂等', () => {
    const base = mkBase();
    const store = new TrajectoryStore(base);
    store.append('s3', rec(1));
    store.close();
    store.close(); // 幂等，不抛错
    const raw = fs.readFileSync(path.join(base, 's3.jsonl'), 'utf8');
    expect(raw).toContain('detail-1');
  });

  it('敏感信息脱敏后再落盘', () => {
    const base = mkBase();
    const store = new TrajectoryStore(base);
    store.append('s4', rec(1, 'token=sk-ABCDEFGHIJKLMNOPQRST12345678 password=secret123'));
    store.flush();
    const raw = fs.readFileSync(path.join(base, 's4.jsonl'), 'utf8');
    expect(raw).not.toContain('sk-ABCDEFGHIJKLMNOPQRST12345678');
    expect(raw).not.toContain('secret123');
    expect(raw).toContain('[REDACTED]');
  });
});

describe('redactSecrets', () => {
  it('替换常见密钥形态', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmno')).toContain('[REDACTED]');
    expect(redactSecrets('x=sk-abcdefghijklmnop1234')).toContain('sk-[REDACTED]');
    expect(redactSecrets('api_key=1234567890')).toContain('[REDACTED]');
  });

  it('非敏感文本原样返回', () => {
    expect(redactSecrets('普通日志：npm run build 完成')).toBe('普通日志：npm run build 完成');
  });
});