/**
 * daemon 日志落盘（C2）。
 *
 * 目标：真机排查时 daemon 的 stdout/stderr（启动、握手、异常、信任规则等）此前只被扩展
 * 捕获进 OutputChannel，进程退出/重启即丢失。现通过 tee 把 process.stdout/stderr 镜像写入
 * <workspace>/.dsh/logs/daemon.log：
 *
 *  - 零侵入：无需逐个替换 console 调用，daemon 内全部输出自动双写；
 *  - 轮转：单文件达到上限后归档为 daemon-<ts>.log；
 *  - 权限：日志目录 0700、文件 0600（可能含命令输出/路径）；
 *  - 失败静默：落盘非关键路径，写失败不影响 daemon 运行。
 */
import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface FileLog {
  write(chunk: unknown): void;
  close(): void;
}

/** 轮转：命中上限归档为带时间戳的历史文件。 */
function rotateIfNeeded(file: string, maxBytes: number): void {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size >= maxBytes) {
      const ts = Date.now();
      const dir = path.dirname(file);
      const base = path.basename(file);
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : '';
      fs.renameSync(file, path.join(dir, `${stem}-${ts}${ext}`));
    }
  } catch {
    /* 轮转失败忽略 */
  }
}

/** 追加写入一块输出（string / Buffer / Uint8Array），带权限与轮转。 */
function appendChunk(file: string, maxBytes: number, chunk: unknown): void {
  if (chunk === undefined || chunk === null) return;
  try {
    const buf =
      typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
          ? Buffer.from(chunk as Uint8Array)
          : Buffer.from(String(chunk), 'utf8');
    if (buf.length === 0) return;
    rotateIfNeeded(file, maxBytes);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, buf, { mode: 0o600 });
  } catch {
    /* 落盘失败静默 */
  }
}

/** 创建独立可测的日志写入器。 */
export function createFileLog(logFile: string, maxBytes = DEFAULT_LOG_MAX_BYTES): FileLog {
  return {
    write(chunk: unknown): void {
      appendChunk(logFile, maxBytes, chunk);
    },
    close(): void {
      /* 追加写无缓冲，无需 close */
    },
  };
}

/** 镜像 stdout/stderr 到日志文件，返回解除镜像的还原函数（退出/测试前调用）。 */
export function attachStreamLog(logFile: string, maxBytes = DEFAULT_LOG_MAX_BYTES): () => void {
  const log = createFileLog(logFile, maxBytes);
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);

  const tee = (orig: typeof origOut) =>
    function (this: unknown, chunk: unknown, ...rest: unknown[]) {
      log.write(chunk);
      return (orig as (...a: unknown[]) => boolean).apply(this, [chunk, ...rest]);
    };

  process.stdout.write = tee(origOut) as typeof process.stdout.write;
  process.stderr.write = tee(origErr) as typeof process.stderr.write;

  return () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  };
}