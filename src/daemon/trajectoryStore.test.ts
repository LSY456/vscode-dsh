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

/**
 * P2-8：结构化字段也要脱敏，且不能破坏历史记录的可读性。
 *
 * 旧实现只对 `detail` 调 redactSecrets —— 每加一个字段就多一条未经脱敏的明文通道。
 * 因此这里**在非 detail 字段里塞密钥**，而不是只测 detail：只测 detail 的话，
 * 将来加字段仍然会漏，而漏掉的后果是把凭据写进审计日志。
 */
describe('轨迹结构化字段（P2-8）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-traj-meta-'));
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  /** 落盘 -> 回读 -> 清掉该会话文件（各用例互不干扰）。 */
  function roundTrip(record: EventTrajectory): EventTrajectory {
    const store = new TrajectoryStore(base, 10 * 1024 * 1024, 60 * 60 * 1000);
    store.append(record.sessionId, record);
    const out = store.read(record.sessionId);
    store.close(); // 清掉自动落盘定时器，避免测试进程被挂住
    fs.rmSync(path.join(base, `${record.sessionId}.jsonl`), { force: true });
    return out[out.length - 1];
  }

  const SECRET_TAIL = 'abcdefghijklmnop1234';

  it('结构化字段原样落盘（tool / ok / durationMs / errorKind / tokens 不被丢弃）', () => {
    const last = roundTrip({
      sessionId: 'meta-keep',
      step: 1,
      kind: 'tool',
      detail: 'read_file 完成',
      ts: 1700000000000,
      tool: 'read_file',
      ok: false,
      durationMs: 123,
      errorKind: 'exec-failed',
      tokens: { prompt: 10, completion: 5, total: 15, estimated: true },
    });
    expect(last.tool).toBe('read_file');
    expect(last.ok).toBe(false);
    expect(last.durationMs).toBe(123);
    expect(last.errorKind).toBe('exec-failed');
    expect(last.tokens).toEqual({ prompt: 10, completion: 5, total: 15, estimated: true });
  });

  it('非 detail 的字符串字段同样脱敏（新字段不是明文的旁路）', () => {
    const last = roundTrip({
      sessionId: 'meta-redact',
      step: 2,
      kind: 'tool',
      detail: '普通输出，无需脱敏',
      ts: 1700000000000,
      tool: `token=sk-${SECRET_TAIL}`,
    });
    expect(last.detail).toBe('普通输出，无需脱敏');
    expect(last.tool).toContain('[REDACTED]');
    expect(JSON.stringify(last)).not.toContain(SECRET_TAIL);
  });

  it('结构化字段里的密钥也不会漏（detail 干净时同样要脱敏）', () => {
    const last = roundTrip({
      sessionId: 'meta-redact-detail',
      step: 3,
      kind: 'approval',
      detail: `git push 使用 Bearer ${SECRET_TAIL}`,
      ts: 1700000000000,
      tool: 'bash_execute',
      ok: true,
    });
    expect(JSON.stringify(last)).not.toContain(SECRET_TAIL);
    expect(last.detail).toContain('[REDACTED]');
  });

  it('旧记录（无任何结构化字段）仍可原样回读 —— 加字段不破坏历史数据', () => {
    const last = roundTrip({
      sessionId: 'meta-legacy',
      step: 4,
      kind: 'system',
      detail: 'session 开始',
      ts: 1700000000000,
    });
    expect(last).toEqual({
      sessionId: 'meta-legacy',
      step: 4,
      kind: 'system',
      detail: 'session 开始',
      ts: 1700000000000,
    });
  });
});