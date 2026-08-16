/**
 * dsh 参考 daemon 入口。
 *
 * 用法：
 *   node out/daemon/index.js \
 *     [--port <n>] [--port-file <path>] [--workspace <path>] \
 *     [--preset <name>] [--api-key <key>]
 *
 * Token 优先取环境变量 DSH_DAEMON_TOKEN，其次 --token 参数。
 * 端口就绪后向 stdout 输出一行 `DSH_DAEMON_PORT=<port>`，便于父进程捕获。
 */
import * as fs from 'fs';
import * as path from 'path';
import { startDaemonServer } from './server';

interface CliArgs {
  port: number;
  portFile?: string;
  workspace: string;
  preset: string;
  apiKey?: string;
  token: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    port: 0,
    workspace: process.cwd(),
    preset: 'default',
    token: process.env.DSH_DAEMON_TOKEN ?? '',
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
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.token) {
    console.error('[dsh-daemon] 缺少 token：请通过环境变量 DSH_DAEMON_TOKEN 或 --token 提供。');
    process.exit(1);
  }

  const handle = await startDaemonServer({
    token: args.token,
    workspaceRoot: args.workspace,
    preset: args.preset,
    apiKey: args.apiKey,
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
