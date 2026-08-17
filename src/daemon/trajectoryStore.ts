/**
 * 持久化轨迹（P3.4）：把 trajectory.record 追加进工作区 .dsh/trajectory/<sessionId>.jsonl，
 * 作为审计日志 / 后续回放的数据源。写入失败静默忽略（轨迹持久化非关键路径）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { EventTrajectory } from '../../shared/protocol';

export class TrajectoryStore {
  constructor(private readonly baseDir: string, private readonly maxBytes = 5 * 1024 * 1024) {}

  private fileFor(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.jsonl`);
  }

  append(sessionId: string, record: EventTrajectory): void {
    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
      const file = this.fileFor(sessionId);
      if (fs.existsSync(file) && fs.statSync(file).size >= this.maxBytes) {
        this.rotate(sessionId, file);
      }
      fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      /* 忽略：轨迹为非关键路径 */
    }
  }

  read(sessionId: string): EventTrajectory[] {
    try {
      const file = this.fileFor(sessionId);
      if (!fs.existsSync(file)) return [];
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const out: EventTrajectory[] = [];
      for (const line of lines) {
        try {
          out.push(JSON.parse(line) as EventTrajectory);
        } catch {
          /* 忽略坏行 */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private rotate(sessionId: string, file: string): void {
    // 命中上限：归档为 <sessionId>-<ts>.jsonl，重新开始新文件
    const ts = Date.now();
    fs.renameSync(file, path.join(this.baseDir, `${sessionId}-${ts}.jsonl`));
  }
}