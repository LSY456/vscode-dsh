/**
 * dsh 参考 daemon 入口。
 *
 * 用法：
 *   node out/daemon/index.js \
 *     [--port <n>] [--port-file <path>] [--workspace <path>] \
 *     [--preset <name>] [--api-key <key>] \
 *     [--agent mock|real|auto] [--fake-model]
 *
 * Token 优先取环境变量 DSH_DAEMON_TOKEN，其次 --token 参数。
 * 端口就绪后向 stdout 输出一行 `DSH_DAEMON_PORT=<port>`，便于父进程捕获。
 */
import * as fs from 'fs';
import * as path from 'path';
import { startDaemonServer } from './server';
import { attachStreamLog } from './logFile';
import { dshDirPath, ensureDshDir } from '../../shared/dshDir';

interface CliArgs {
  port: number;
  portFile?: string;
  workspace: string;
  preset: string;
  apiKey?: string;
  token: string;
  agent: 'mock' | 'real' | 'auto';
  provider: 'openai' | 'anthropic' | 'auto';
  fakeModel: boolean;
  /** C2：日志落盘路径（缺省 <workspace>/.dsh/logs/daemon.log） */
  logFile: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    port: 0,
    workspace: process.cwd(),
    preset: 'default',
    token: process.env.DSH_DAEMON_TOKEN ?? '',
    agent: 'auto',
    provider: 'auto',
    fakeModel: false,
    logFile: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--port':
        args.port = Number(next());
        break;
      case '--port-file':
        args.portFile = next();
        break;
      case '--workspace':
        args.workspace = next();
        break;
      case '--preset':
        args.preset = next();
        break;
      case '--api-key':
        args.apiKey = next();
        break;
      case '--token':
        args.token = next();
        break;
      case '--agent':
        args.agent = next() as CliArgs['agent'];
        break;
      case '--provider':
        args.provider = next() as CliArgs['provider'];
        break;
      case '--fake-model':
        args.fakeModel = true;
        break;
      case '--log-file':
        args.logFile = next();
        break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // P0-3：`.dsh/` 单点创建 —— 先建目录并写下自守的 .gitignore，之后 logFile / trajectory /
  // trustStore 才往里写，不会留下"目录已存在但没有忽略规则"的窗口。
  ensureDshDir(dshDirPath(args.workspace));

  // C2 日志落盘：tee stdout/stderr 到日志文件（缺省 <workspace>/.dsh/logs/daemon.log），
  // 覆盖 daemon 全生命周期输出（启动、握手、异常、信任规则等），进程退出后仍可排查。
  const logFile = args.logFile || path.join(args.workspace, '.dsh', 'logs', 'daemon.log');
  const restoreLog = attachStreamLog(logFile);

  if (!args.token) {
    console.error('[dsh-daemon] 缺少 token：请通过环境变量 DSH_DAEMON_TOKEN 或 --token 提供。');
    restoreLog();
    process.exit(1);
  }

  const handle = await startDaemonServer({
    token: args.token,
    workspaceRoot: args.workspace,
    preset: args.preset,
    apiKey: args.apiKey,
    agent: args.agent,
    provider: args.provider,
    fakeModel: args.fakeModel,
    port: args.port,
    onPort: (port) => {
      console.log(`DSH_DAEMON_PORT=${port}`);
      console.log(`[dsh-daemon] listening on ws://127.0.0.1:${port} (workspace: ${args.workspace}, preset: ${args.preset})`);
      if (args.portFile) {
        fs.mkdirSync(path.dirname(args.portFile), { recursive: true });
        fs.writeFileSync(args.portFile, JSON.stringify({ port, pid: process.pid, workspace: args.workspace }, null, 2));
      }
    },
  });

  const shutdown = async (signal: string) => {
    console.log(`[dsh-daemon] received ${signal}, shutting down`);
    if (args.portFile) {
      try {
        fs.unlinkSync(args.portFile);
      } catch {
        /* ignore */
      }
    }
    await handle.close();
    restoreLog();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 保持进程存活
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error('[dsh-daemon] fatal:', err);
  process.exit(1);
});
