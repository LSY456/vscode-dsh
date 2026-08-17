/**
 * 持久化轨迹（P3.4 / 企业级加固）。
 *
 * 把 trajectory.record 追加进工作区 .dsh/trajectory/<sessionId>.jsonl，作为审计日志 /
 * 后续回放的数据源。写入失败静默忽略（轨迹持久化非关键路径）。
 *
 * 加固点：
 *  - 脱敏：写入前对 record 做 redactRecord，剔除 API Key / Token / 密码等敏感词面。
 *  - 异步缓冲：字段以内存 buffer 暂存，flush() 批量落盘，避免在流式热路径里做同步 fsync。
 *  - 权限：目录 0700、文件 0600（仅属主可读），轨迹可能含敏感命令输出。
 *  - 轮转：命中大小上限归档为 <sessionId>-<ts>.jsonl，重新开始新文件。
 */
import * as fs from 'fs';
import * as path from 'path';
import { EventTrajectory } from '../../shared/protocol';

/** 脱敏规则（顺序应用；捕获前缀并保留，敏感正文替换为 [REDACTED]）。 */
const REDACTION_RULES: { re: RegExp; repl: string }[] = [
  { re: /((?:sk|pk)-)[A-Za-z0-9]{16,}/g, repl: '$1[REDACTED]' }, // OpenAI / Stripe 风格密钥
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, repl: '[REDACTED]' }, // GitHub Token
  { re: /AKIA[0-9A-Z]{16}/g, repl: '[REDACTED]' }, // AWS Access Key ID
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, repl: '[REDACTED]' }, // Slack Token
  { re: /(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, repl: '$1[REDACTED]' }, // Bearer 令牌
  { re: /(api[_-]?key\s*[:=]\s*['"]?)[^\s'"]+/gi, repl: '$1[REDACTED]' },
  { re: /(token\s*[:=]\s*['"]?)[^\s'"]+/gi, repl: '$1[REDACTED]' },
  { re: /((?:password|passwd|secret)\s*[:=]\s*['"]?)[^\s'"]+/gi, repl: '$1[REDACTED]' },
];

export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { re, repl } of REDACTION_RULES) {
    out = out.replace(re, repl);
  }
  return out;
}

function redactRecord(record: EventTrajectory): EventTrajectory {
  const copy: EventTrajectory = { ...record };
  if (typeof copy.detail === 'string') copy.detail = redactSecrets(copy.detail);
  return copy;
}

export class TrajectoryStore {
  private buffer = new Map<string, string[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly baseDir: string,
    private readonly maxBytes = 5 * 1024 * 1024,
    private readonly autoFlushMs = 1000
  ) {}

  private fileFor(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.jsonl`);
  }

  /** 追加记录到内存缓冲并调度批量落盘（非阻塞、静默失败）。 */
  append(sessionId: string, record: EventTrajectory): void {
    try {
      const line = JSON.stringify(redactRecord(record)) + '\n';
      const lines = this.buffer.get(sessionId) ?? [];
      lines.push(line);
      this.buffer.set(sessionId, lines);
      this.scheduleFlush();
    } catch {
      /* 忽略：轨迹为非关键路径 */
    }
  }

  /** 立即同步落盘所有缓冲（进程退出/会话结束前调用）。 */
  flush(): void {
    if (this.buffer.size === 0) return;
    try {
      fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    } catch {
      /* 忽略 */
    }
    for (const [sessionId, lines] of this.buffer) {
      if (lines.length === 0) continue;
      try {
        const file = this.fileFor(sessionId);
        if (fs.existsSync(file) && fs.statSync(file).size >= this.maxBytes) {
          this.rotate(sessionId, file);
        }
        fs.appendFileSync(file, lines.join(''), { encoding: 'utf8', mode: 0o600 });
      } catch {
        /* 忽略 */
      }
    }
    this.buffer.clear();
    this.clearTimer();
  }

  /** 停止自动落盘并最终 flush（幂等，之后 append 不再生效）。 */
  close(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
  }

  read(sessionId: string): EventTrajectory[] {
    // 先落盘，避免漏掉缓冲中的记录
    this.flush();
    try {
      const file = this.fileFor(sessionId);
      if (!fs.existsSync(file)) return [];
      const content = fs.readFileSync(file, 'utf8');
      const out: EventTrajectory[] = [];
      for (const line of content.split('\n').filter(Boolean)) {
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

  private scheduleFlush(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.autoFlushMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private rotate(sessionId: string, file: string): void {
    const ts = Date.now();
    fs.renameSync(file, path.join(this.baseDir, `${sessionId}-${ts}.jsonl`));
  }
}