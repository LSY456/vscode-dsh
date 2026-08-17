/**
 * daemon 进程生命周期管理（方案流程一）。
 *
 * 职责：
 *  - 探测：读取工作区 .dsh/daemon.json（或 external 模式配置的端口），
 *    尝试 ping 判断是否已有可用 daemon。
 *  - 拉起：无 daemon 时以静默模式 spawn 内置参考 daemon
 *    （node out/daemon/index.js），绑定 127.0.0.1 随机端口，token 走环境变量。
 *  - 连接：建立 WebSocket，发送 initialize 握手（workspaceRoot/apiKey/preset）。
 *  - 断线重连：指数退避，直到进程退出或被 dispose。
 *  - 生命周期：deactivate 时回收子进程。
 */
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ERROR_CODES, InitializeResult, METHODS, SessionResumeResult } from '../shared/protocol';
import { logger } from './logger';
import { DshClient } from './wsClient';

export type DaemonStatus = 'stopped' | 'starting' | 'connecting' | 'connected' | 'error' | 'disabled';

export interface StatusInfo {
  status: DaemonStatus;
  detail: string;
}

export interface DaemonManagerOptions {
  extensionPath: string;
}

const PORT_FILE_REL = path.join('.dsh', 'daemon.json');

export class DaemonManager {
  readonly client = new DshClient({ url: '', token: '' });
  private status: DaemonStatus = 'stopped';
  private detail = '未启动';
  private statusListeners: ((info: StatusInfo) => void)[] = [];

  private child: cp.ChildProcess | null = null;
  private token = '';
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly opts: DaemonManagerOptions;

  private sessionId = '';

  constructor(opts: DaemonManagerOptions) {
    this.opts = opts;
    this.client.onClose(() => {
      if (this.status === 'connected') {
        this.setStatus('connecting', '连接断开，正在重连…');
        this.scheduleReconnect();
      }
    });
    this.client.onOpen(() => {
      void this.handshake();
    });
  }

  /** 订阅 daemon 状态变化（Webview 状态栏、扩展状态栏等）。 */
  onStatus(listener: (info: StatusInfo) => void): void {
    this.statusListeners.push(listener);
  }

  getStatus(): StatusInfo {
    return { status: this.status, detail: this.detail };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  async start(): Promise<void> {
    const mode = vscode.workspace.getConfiguration('dsh').get<string>('daemon.mode', 'auto');
    logger.info(`daemon.start: mode=${mode}`);
    if (mode === 'none') {
      this.setStatus('disabled', 'daemon.mode = none（仅 UI 模式）');
      return;
    }
    this.setStatus('starting', '正在启动 daemon…');
    try {
      const { port, token } = await this.resolveDaemon(mode);
      this.token = token;
      this.setStatus('connecting', `正在连接 ws://127.0.0.1:${port} …`);
      this.connectTo(port);
    } catch (err) {
      this.setStatus('error', err instanceof Error ? err.message : String(err));
    }
  }

  /** 重启：停止子进程与连接，然后重新 start。 */
  async restart(): Promise<void> {
    this.disposeRuntime();
    this.disposed = false;
    this.reconnectAttempt = 0;
    await this.start();
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.request(METHODS.Ping, undefined, 3000);
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.disposeRuntime();
  }

  // -------------------------------------------------------------------------

  private connectTo(port: number): void {
    if (this.disposed) return;
    // 复用同一个 DshClient 实例（事件监听者保持不变），仅更新连接地址与令牌
    this.client.url = `ws://127.0.0.1:${port}`;
    this.client.setToken(this.token);
    void this.client
      .connect()
      .catch((err: Error) => {
        this.setStatus('error', `连接失败: ${err.message}`);
        this.scheduleReconnect();
      });
  }

  private async handshake(): Promise<void> {
    try {
      const workspaceRoot = this.getWorkspaceRoot();
      const cfg = vscode.workspace.getConfiguration('dsh');
      const result = await this.client.request<InitializeResult>(METHODS.Initialize, {
        workspaceRoot,
        apiKey: cfg.get<string>('apiKey', ''),
        preset: cfg.get<string>('preset', 'default'),
        model: {
          baseURL: cfg.get<string>('model.baseURL', ''),
          model: cfg.get<string>('model.model', ''),
          apiKey: cfg.get<string>('apiKey', ''),
          agent: 'auto',
        },
        capabilities: {
          allowedTools: cfg.get<string[]>('capabilities.allowedTools', []),
          maxConcurrency: cfg.get<number>('capabilities.maxConcurrency', 0),
        },
        client: {
          name: 'vscode-dsh',
          version: '0.2.0',
        },
      });

      // 会话续跑（P1.2）：同一 daemon 进程内断线重连，恢复会话状态与未消费事件
      const prevSessionId = this.sessionId;
      if (prevSessionId) {
        try {
          const resumed = await this.client.request<SessionResumeResult>(METHODS.SessionResume, {
            sessionId: prevSessionId,
          });
          this.sessionId = resumed.sessionId;
          logger.info(`会话续跑成功: ${this.sessionId}（state=${resumed.state}）`);
        } catch (err) {
          const code = (err as { code?: number } | null)?.code;
          if (code === ERROR_CODES.NotFound) {
            // daemon 进程已重启，旧会话丢失，回退到 initialize 分配的新会话
            logger.info('旧会话不存在（daemon 已重启），使用新会话');
            this.sessionId = result.sessionId ?? '';
          } else {
            throw err;
          }
        }
      } else {
        this.sessionId = result.sessionId ?? '';
      }

      this.reconnectAttempt = 0;
      this.setStatus(
        'connected',
        `已连接 daemon v${result.daemonVersion}（协议 ${result.protocolVersion}，会话 ${this.sessionId || '—'}）`
      );
      // 心跳（P1.2）：连续 3 次 ping 失败判定链路死亡并重连
      this.client.startHeartbeat({
        intervalMs: 15_000,
        timeoutMs: 3000,
        maxMisses: 3,
        onDead: () => {
          logger.warn('心跳连续失败，判定链路死亡，强制重连');
          this.setStatus('connecting', '心跳超时，正在重连…');
          this.client.close();
          this.scheduleReconnect();
        },
      });
    } catch (err) {
      this.setStatus('error', `握手失败: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 10_000);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      const mode = vscode.workspace.getConfiguration('dsh').get<string>('daemon.mode', 'auto');
      void this.resolveDaemon(mode)
        .then(({ port }) => {
          this.setStatus('connecting', `重连 ws://127.0.0.1:${port}（第 ${this.reconnectAttempt} 次）…`);
          this.connectTo(port);
        })
        .catch((err: Error) => {
          this.setStatus('error', err.message);
          this.scheduleReconnect();
        });
    }, delay);
  }

  /** 返回 { port, token }：探测现有 daemon，否则拉起新进程。 */
  private async resolveDaemon(mode: string): Promise<{ port: number; token: string }> {
    const cfg = vscode.workspace.getConfiguration('dsh');
    const workspaceRoot = this.getWorkspaceRoot();
    const externalToken = cfg.get<string>('daemon.token', '');
    const token = externalToken || this.token || crypto.randomBytes(24).toString('hex');

    if (mode === 'external') {
      const port = cfg.get<number>('daemon.port', 0);
      if (!port) throw new Error('external 模式需要配置 dsh.daemon.port');
      return { port, token };
    }

    // auto：先探测端口文件
    const portFile = path.join(workspaceRoot, PORT_FILE_REL);
    if (fs.existsSync(portFile)) {
      try {
        const info = JSON.parse(fs.readFileSync(portFile, 'utf8')) as { port: number };
        if (info.port && (await this.probePort(info.port, token))) {
          return { port: info.port, token };
        }
      } catch {
        /* 端口文件损坏，忽略并重新拉起 */
      }
    }

    // 配置了自定义命令则用之，否则用内置参考 daemon
    const commandTemplate = cfg.get<string>('daemon.command', '');
    if (commandTemplate) {
      return await this.spawnExternal(commandTemplate, token, workspaceRoot);
    }
    return await this.spawnBundled(token, workspaceRoot);
  }

  private async probePort(port: number, token: string): Promise<boolean> {
    // 使用一个临时客户端做 ping，避免干扰主客户端状态机
    const probe = new DshClient({ url: `ws://127.0.0.1:${port}`, token, timeoutMs: 2500 });
    try {
      await probe.connect();
      await probe.request(METHODS.Ping, undefined, 2000);
      return true;
    } catch {
      return false;
    } finally {
      probe.close();
    }
  }

  private async spawnBundled(token: string, workspaceRoot: string): Promise<{ port: number; token: string }> {
    const daemonScript = path.join(this.opts.extensionPath, 'out', 'daemon', 'index.js');
    if (!fs.existsSync(daemonScript)) {
      throw new Error(`未找到内置 daemon: ${daemonScript}（请先运行 npm run build）`);
    }
    const portFile = path.join(workspaceRoot, PORT_FILE_REL);
    return await new Promise<{ port: number; token: string }>((resolve, reject) => {
      const child = cp.spawn(
        process.execPath,
        [daemonScript, '--port', '0', '--port-file', portFile, '--workspace', workspaceRoot],
        {
          env: { ...process.env, DSH_DAEMON_TOKEN: token },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }
      );
      this.child = child;
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('等待 daemon 端口超时（15s）'));
      }, 15_000);

      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
        const m = stdout.match(/DSH_DAEMON_PORT=(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve({ port: Number(m[1]), token });
        }
      });
      child.stderr?.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        if (line) {
          logger.debug(`daemon stderr: ${line}`);
          this.detail = `daemon stderr: ${line}`;
        }
      });
      child.on('exit', (code) => {
        if (code !== 0 && !stdout.includes('DSH_DAEMON_PORT=')) {
          clearTimeout(timer);
          reject(new Error(`daemon 进程退出（code=${code}）: ${stdout.slice(-300)}`));
        }
        if (this.child === child) this.child = null;
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async spawnExternal(
    template: string,
    token: string,
    workspaceRoot: string
  ): Promise<{ port: number; token: string }> {
    const portFile = path.join(workspaceRoot, PORT_FILE_REL);
    const cmd = template
      .replace('{portFile}', JSON.stringify(portFile))
      .replace('{workspace}', JSON.stringify(workspaceRoot))
      .replace('{token}', token);
    // 简单拆分：第一个空格前为可执行文件，其余为参数
    const idx = cmd.indexOf(' ');
    const exe = idx === -1 ? cmd : cmd.slice(0, idx);
    const args = idx === -1 ? [] : cmd.slice(idx + 1).split(/\s+/).filter(Boolean);
    return await new Promise<{ port: number; token: string }>((resolve, reject) => {
      const child = cp.spawn(exe, args, {
        env: { ...process.env, DSH_DAEMON_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('等待外部 daemon 端口超时（15s）'));
      }, 15_000);
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
        const m = stdout.match(/DSH_DAEMON_PORT=(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve({ port: Number(m[1]), token });
        }
      });
      child.on('exit', (code) => {
        if (code !== 0 && !stdout.includes('DSH_DAEMON_PORT=')) {
          clearTimeout(timer);
          reject(new Error(`外部 daemon 退出（code=${code}）`));
        }
        if (this.child === child) this.child = null;
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private disposeRuntime(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.client.close();
    if (this.child && !this.child.killed) {
      try {
        logger.debug('终止 daemon 子进程');
        this.child.kill();
      } catch {
        /* ignore */
      }
      this.child = null;
    }
    this.setStatus('stopped', '已停止');
  }

  private getWorkspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath;
    }
    return vscode.workspace.rootPath ?? process.cwd();
  }

  private setStatus(status: DaemonStatus, detail: string): void {
    this.status = status;
    this.detail = detail;
    const info: StatusInfo = { status, detail };
    this.statusListeners.forEach((l) => l(info));
  }
}
