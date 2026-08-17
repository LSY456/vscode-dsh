import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventTrajectory } from '../../shared/protocol';
import { TrajectoryStore } from './trajectoryStore';

function rec(step: number): EventTrajectory {
  return { sessionId: 's1', step, kind: 'system', detail: `detail-${step}`, ts: Date.now() };
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
  it('append 后 read 可回读（保持顺序）', () => {
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

  it('命中上限时归档旧文件（轮转）', () => {
    const base = mkBase();
    const small = new TrajectoryStore(base, 1); // 第二次 append 即触发轮转
    small.append('s2', rec(1));
    small.append('s2', rec(2));
    // 当前文件只保留最新一条（旧文件已被归档）
    expect(small.read('s2').map((r) => r.step)).toEqual([2]);
    expect(fs.readdirSync(base).length).toBeGreaterThanOrEqual(2); // 主文件 + 归档文件
  });
});