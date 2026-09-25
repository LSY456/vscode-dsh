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
import { isStaleDaemon, readBuildId } from '../shared/buildId';
import { ERROR_CODES, InitializeResult, METHODS, SessionResumeResult } from '../shared/protocol';
import { VSD_DSH_VERSION } from '../shared/version';
import type { ConfigAccessor } from './configAccessor';
import { logger } from './logger';
import { DshClient } from './wsClient';
import { resolveTrustGate } from './workspaceTrust';

/**
 * daemon 状态机。
 * `restricted` 是安全态而非故障：工作区未被信任时**连子进程都不拉起**，
 * 因为要执行的命令来自配置项（见 src/workspaceTrust.ts 的三层防护说明）。
 */
export type DaemonStatus =
  | 'stopped'
  | 'starting'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disabled'
  | 'restricted';

export interface StatusInfo {
  status: DaemonStatus;
  detail: string;
}

export interface DaemonManagerOptions {
  extensionPath: string;
  /** 注入后 apiKey 经 SecretStorage 读取（A4 安全化）；缺省回退 settings.json（兼容裸用） */
  configAccessor?: ConfigAccessor;
  /**
   * 工作区信任探针（缺省视为已信任，便于裸用与测试）。
   *
   * 放在这里而不是各个调用点：`start()` 是唯一的拉起入口（`restart()` 也走它），
   * 于是命令、状态栏、面板「重启 daemon」、断线重连全都被同一道门覆盖，不会有绕行路径。
   */
  isTrusted?: () => boolean;
}

/** 握手后 daemon 回报的运行信息（UI 用：当前是 mock 还是真实模型）。 */
export interface AgentInfo {
  agent?: 'mock' | 'real';
  /** agent=mock 的成因（UI 据此提示「演示模式」并给出配置入口） */
  agentReason?: 'no-api-key' | 'forced-mock';
  model?: string;
  daemonVersion?: string;
}

const PORT_FILE_REL = path.join('.dsh', 'daemon.json');

export class DaemonManager {
  readonly client = new DshClient({ url: '', token: '' });
  private status: DaemonStatus = 'stopped';
  private detail = '未启动';
  private statusListeners: ((info: StatusInfo) => void)[] = [];
  private resumeListeners: ((sessionId: string) => void)[] = [];
  private agentInfoListeners: ((info: AgentInfo) => void)[] = [];

  private child: cp.ChildProcess | null = null;
  private token = '';
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly opts: DaemonManagerOptions;

  private sessionId = '';
  private agentInfo: AgentInfo = {};

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

  /**
   * 订阅「即将重放会话事件」时机（断线重连时）。
   * 重放会把该会话的历史事件重新投递一遍，UI 需先清空、历史存储需抑制重复落库。
   */
  onBeforeResume(listener: (sessionId: string) => void): void {
    this.resumeListeners.push(listener);
  }

  /**
   * 订阅「Agent 实现信息变化」（每次握手成功后）。
   *
   * 目的：用户配好 Key → 重启 daemon → 面板必须能**撤下**"演示模式"横幅。
   * 只在 surface 就绪时推一次 init 是不够的（那时可能还没握手完成）。
   */
  onAgentInfo(listener: (info: AgentInfo) => void): void {
    this.agentInfoListeners.push(listener);
  }

  getStatus(): StatusInfo {
    return { status: this.status, detail: this.detail };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** 当前 daemon 的 Agent 实现信息（未握手成功时为空对象）。 */
  getAgentInfo(): AgentInfo {
    return this.agentInfo;
  }

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  async start(): Promise<void> {
    // 信任门禁必须在读配置**之前**：要执行的命令来自 `dsh.daemon.command`，
    // 而未受信任时它可能由工作区提供（即便有 package.json 的声明，这里也要能兜住）。
    const gate = resolveTrustGate(this.opts.isTrusted ? this.opts.isTrusted() : true);
    if (gate.blocked) {
      logger.warn(`工作区未受信任，不启动 daemon：${gate.statusDetail}`);
      this.setStatus('restricted', gate.statusDetail);
      return;
    }
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
      // apiKey 优先经 SecretStorage（A4）；未注入时回退旧明文 settings（向后兼容）
      const apiKey = this.opts.configAccessor
        ? await this.opts.configAccessor.getApiKey()
        : cfg.get<string>('apiKey', '');
      const result = await this.client.request<InitializeResult>(METHODS.Initialize, {
        workspaceRoot,
        apiKey,
        preset: cfg.get<string>('preset', 'default'),
        model: {
          baseURL: cfg.get<string>('model.baseURL', ''),
          model: cfg.get<string>('model.model', ''),
          apiKey,
          agent: 'auto',
          provider: cfg.get<string>('model.provider', 'auto') as 'openai' | 'anthropic' | 'auto',
          // P0-3 空闲超时：秒 -> 毫秒；0 透传为"关闭"，daemon 侧据此不再兜底中断
          idleTimeoutMs: Math.round(cfg.get<number>('model.idleTimeoutSeconds', 60) * 1000),
        },
        capabilities: {
          allowedTools: cfg.get<string[]>('capabilities.allowedTools', []),
          maxConcurrency: cfg.get<number>('capabilities.maxConcurrency', 0),
          // 挂起项（审批 / 补丁）超时：秒 -> 毫秒；daemon 端再做区间钳制
          approvalTtlMs: Math.round(cfg.get<number>('approval.ttlSeconds', 60) * 1000),
        },
        client: {
          name: 'vscode-dsh',
          version: VSD_DSH_VERSION,
        },
      });

      // 会话续跑（P1.2）：同一 daemon 进程内断线重连，恢复会话状态与未消费事件
      const prevSessionId = this.sessionId;
      if (prevSessionId) {
        try {
          for (const l of this.resumeListeners) l(prevSessionId);
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

      // UI 提示用：本次生效的 Agent 实现与模型名（mock / real）
      this.agentInfo = {
        agent: result.agent,
        agentReason: result.agentReason,
        model: cfg.get<string>('model.model', '') || undefined,
        daemonVersion: result.daemonVersion,
      };
      for (const l of this.agentInfoListeners) {
        try {
          l(this.agentInfo);
        } catch (err) {
          logger.warn(`agentInfo 监听器抛错: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 陈旧 daemon 防护：升级装新版扩展后，工作区里可能还有旧构建的 daemon 进程存活，
      // auto 探测会直接复用（真实事故：修复后的逻辑因复用旧进程而不生效）。
      // 构建指纹（buildId）每次构建变化，比对不一致 => 回收旧进程并重新拉起。
      if (isStaleDaemon(readBuildId(), result.buildId)) {
        logger.warn(
          `复用 daemon 构建过旧（报告 ${result.buildId}，期望 ${readBuildId()}），回收并重启`
        );
        this.setStatus('starting', '回收陈旧 daemon，正在重启…');
        await this.recycleStaleDaemon();
        await this.start();
        return;
      }

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

  /**
   * 回收陈旧 daemon（升级后工作区里残留的旧构建进程）：
   * 断开连接 -> 读端口文件拿 pid 强杀 -> 删除端口文件，为重新 start 清场。
   */
  private async recycleStaleDaemon(): Promise<void> {
    const portFile = path.join(this.getWorkspaceRoot(), PORT_FILE_REL);
    let pid: number | undefined;
    try {
      const info = JSON.parse(fs.readFileSync(portFile, 'utf8')) as { pid?: unknown };
      if (typeof info.pid === 'number') pid = info.pid;
    } catch {
      /* 端口文件缺失/损坏：无需回收 */
    }

    this.client.close(); // status 已是 starting，onClose 不会触发重连

    if (pid) {
      try {
        // Windows 下 process.kill 直接终止进程（无优雅信号）
        process.kill(pid);
        logger.info(`已结束陈旧 daemon 进程 pid=${pid}`);
      } catch (e) {
        logger.warn(`结束陈旧 daemon 失败（可能已退出）: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try {
      fs.unlinkSync(portFile);
      logger.info(`已移除端口文件 ${portFile}`);
    } catch {
      /* 无文件 */
    }
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
