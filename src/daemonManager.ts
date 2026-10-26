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
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_MAX_TOOL_ROUNDS,
  DEFAULT_MAX_WRITE_FAILURES,
  ERROR_CODES,
  InitializeResult,
  METHODS,
  SessionResumeResult,
} from '../shared/protocol';
import { VSD_DSH_VERSION } from '../shared/version';
import type { ConfigAccessor } from './configAccessor';
import { logger } from './logger';
import { DaemonState } from './statusLabel';
import { DshClient } from './wsClient';
import { resolveWorkspaceRoot } from './workspaceRoot';
import { resolveTrustGate } from './workspaceTrust';

/**
 * daemon 状态机。
 * `restricted` 是安全态而非故障：工作区未被信任时**连子进程都不拉起**，
 * 因为要执行的命令来自配置项（见 src/workspaceTrust.ts 的三层防护说明）。
 *
 * 取值与中文文案的唯一来源是 `src/statusLabel.ts`（那里刻意不 import vscode，
 * 所以扩展侧与 webview 能共用一份，不会两处漂移）。
 */
export type DaemonStatus = DaemonState;

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
  /**
   * 进程身份探针（`recycleStaleDaemon` 回收前校验用）。
   *
   * 可注入的原因：缺省实现要 spawn 一个查询进程（Windows 走 PowerShell/CIM、POSIX 走 ps），
   * 而单测环境不允许同步 spawn —— 注入假探针才能把"身份不匹配就不杀"这条逻辑测成断言。
   */
  readProcessCommandLine?: (pid: number) => string | undefined;
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

/**
 * 把命令模板切分为 `[可执行文件, ...参数]`，识别单/双引号。
 *
 * 为什么不按空白 split：`dsh.daemon.command` 里带空格的可执行路径或参数是常见写法
 * （`"C:\Program Files\nodejs\node.exe" out/daemon/index.js`），`split(/\s+/)` 会把它切成两段，
 * `spawn` 随即 ENOENT —— 而报错只会说"找不到 C:\Program"，用户根本看不出是切分出了问题。
 *
 * 两条刻意的取舍：
 * ① **反斜杠不当转义符**：Windows 路径里 `\` 是分隔符，当转义符会吃掉一层目录
 *    （`C:\Program Files` → `C:Program Files`）。
 * ② 引号只做成对切换；**未闭合的引号**按"延续到结尾"处理（宽松而非抛错）—— 这是用户配置项，
 *    能跑起来比给出精确的语法错误更有用。
 */
export function splitCommandLine(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true; // `""` 是合法的空参数，不能被丢掉
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (started) {
        out.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/**
 * 读取指定进程的命令行；拿不到一律返回 `undefined`（**不抛错**）。
 *
 * Linux 走 `/proc`（最可靠）；Windows 走 CIM（`wmic` 在新系统上已移除）；
 * 其余 POSIX 走 `ps`。任何失败都归一到 `undefined`，由调用方按"身份不明"处理。
 */
export function readProcessCommandLine(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const text = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\u0000/g, ' ').trim();
      return text || undefined;
    }
    if (process.platform === 'win32') {
      const out = cp.execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 3000 }
      );
      const text = String(out).trim();
      return text || undefined;
    }
    const out = cp.execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 3000,
    });
    const text = String(out).trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 判定某进程命令行是否确实是"本扩展拉起的 dsh daemon"。
 *
 * 为什么需要它：`recycleStaleDaemon` 会 `process.kill(pid)`，而 pid 的唯一来源是
 * `<workspace>/.dsh/daemon.json` —— 一个**本机任意进程都能写**的文件。pid 复用（旧 pid 已被
 * 无关进程占用）或该文件被篡改，都会让"回收陈旧 daemon"变成"杀掉别人的进程"。
 * `SECURITY.md` 的威胁模型明确把"同机其他进程"算进攻击面，所以这里必须校验身份。
 *
 * 匹配入口脚本名而非完整路径：扩展升级后目录名会变（`…-0.7.0` → `…-0.8.0`），
 * 而"陈旧 daemon"恰恰就是那种跑在旧目录里的进程 —— 只比完整路径会漏掉它。
 * 配合"pid 取自我们自己写的端口文件"这一前提，`daemon/index.js` 已足以排除无关进程。
 */
export function isDshDaemonCommandLine(cmdline: string | undefined, extensionPath: string): boolean {
  if (!cmdline) return false;
  const norm = cmdline.replace(/\\/g, '/').toLowerCase();
  const ext = extensionPath.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  if (ext && norm.includes(`${ext}/out/daemon/index.js`)) return true;
  return norm.includes('daemon/index.js');
}

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
  /** 本次启动解析出的工作区根（`start()` 单点写入；握手 / 端口文件 / 陈旧回收都读它） */
  private workspaceRoot = '';

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
    // ① 信任门禁必须在读配置**之前**：要执行的命令来自 `dsh.daemon.command`，
    // 而未受信任时它可能由工作区提供（即便有 package.json 的声明，这里也要能兜住）。
    const gate = resolveTrustGate(this.opts.isTrusted ? this.opts.isTrusted() : true);
    if (gate.blocked) {
      logger.warn(`工作区未受信任，不启动 daemon：${gate.statusDetail}`);
      this.workspaceRoot = '';
      this.setStatus('restricted', gate.statusDetail);
      return;
    }
    // ② 没有打开文件夹时**不猜根**：旧实现回落 `rootPath ?? process.cwd()`，会让 daemon 的
    // 工作区变成扩展宿主的 cwd（端口文件、.dsh/、路径护栏 root 全跟着跑偏）。宁可不启动。
    const ws = resolveWorkspaceRoot(vscode.workspace.workspaceFolders);
    if (!ws.ok) {
      logger.warn(`未打开文件夹，不启动 daemon：${ws.reason}`);
      this.workspaceRoot = '';
      this.setStatus('disabled', ws.reason);
      return;
    }
    if (ws.folderCount > 1) {
      logger.info(`多根工作区：dsh 只作用于第一个文件夹 ${ws.root}（共 ${ws.folderCount} 个）`);
    }
    this.workspaceRoot = ws.root;
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
          // Agent 循环预算（P2-2）：这两个值此前只有 daemon 侧读得到 —— 扩展不下发、设置里也没有，
          // 于是"最多 8 轮工具 / 48K 上下文"用户永远改不动，而 CHANGELOG 却写着"可配"。
          maxToolRounds: cfg.get<number>('agent.maxToolRounds', DEFAULT_MAX_TOOL_ROUNDS),
          maxContextTokens: cfg.get<number>('agent.maxContextTokens', DEFAULT_MAX_CONTEXT_TOKENS),
          // 批次 11-2：写入类连续失败阈值。**不进面板** —— 沿用批次 10 撤下「上下文预算 /
          // 输出上限」两个数字项的同一理由：用户不知道这个数该填多少。只在原生设置里可配。
          maxWriteFailures: cfg.get<number>('agent.maxWriteFailures', DEFAULT_MAX_WRITE_FAILURES),
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
    // 三处都必须是 replaceAll：同一占位符可能在模板里出现多次（如既给 --port-file 又给日志路径），
    // 而 `String.replace(string, …)` **只替换第一处**，剩下的会以字面量 `{token}` 进入 argv。
    // 替换值用函数形式（而非字符串）：`replaceAll` 对字符串替换值会解释 `$&`/`$1` 这类模式，
    // 路径或 token 里一旦出现 `$` 就会被静默改写。
    //
    // 路径用**普通引号**包而非 `JSON.stringify`：后者会把 `\` 转义成 `\\`，而 splitCommandLine
    // 刻意不把反斜杠当转义符（Windows 路径里它是分隔符），转义码会原样留在参数里。
    const quote = (s: string) => `"${s}"`;
    const cmd = template
      .replaceAll('{portFile}', () => quote(portFile))
      .replaceAll('{workspace}', () => quote(workspaceRoot))
      .replaceAll('{token}', () => token);
    const [exe, ...args] = splitCommandLine(cmd);
    if (!exe) throw new Error('dsh.daemon.command 未解析出可执行文件（检查该配置是否为空）');
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
      // 身份校验（失败关闭）：pid 取自 `.dsh/daemon.json`，而这个文件本机任意进程都能写 ——
      // pid 复用或文件被篡改时，无条件 kill 会杀掉无关进程。核对命令行里确有 dsh daemon 的
      // 入口脚本才动手；读不到命令行（探针不可用/权限不足）同样按"身份不明"处理，宁可不杀。
      // 不杀的代价很小：端口文件随即被删除，新的 daemon 会在新端口上照常拉起，
      // 只是那个旧进程变成孤儿（会随其自身空闲逻辑退出），远比误杀别人的进程可接受。
      const probe = this.opts.readProcessCommandLine ?? readProcessCommandLine;
      let cmdline: string | undefined;
      try {
        cmdline = probe(pid);
      } catch {
        cmdline = undefined;
      }
      if (!isDshDaemonCommandLine(cmdline, this.opts.extensionPath)) {
        logger.warn(
          `跳过回收 pid=${pid}：无法确认为 dsh daemon 进程` +
            (cmdline ? `（实际命令行：${cmdline.slice(0, 200)}）` : '（读不到该进程的命令行）')
        );
      } else {
        try {
          // Windows 下 process.kill 直接终止进程（无优雅信号）
          process.kill(pid);
          logger.info(`已结束陈旧 daemon 进程 pid=${pid}`);
        } catch (e) {
          logger.warn(`结束陈旧 daemon 失败（可能已退出）: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    try {
      fs.unlinkSync(portFile);
      logger.info(`已移除端口文件 ${portFile}`);
    } catch {
      /* 无文件 */
    }
  }

  /**
   * 当前 daemon 的工作区根。
   *
   * 由 `start()` 经 `resolveWorkspaceRoot()` 解析并缓存（唯一来源），这里只读不再自己判断 ——
   * 之前这里会回落 `vscode.workspace.rootPath ?? process.cwd()`（P0-2），而 `rootPath` 也早已废弃。
   */
  private getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  private setStatus(status: DaemonStatus, detail: string): void {
    this.status = status;
    this.detail = detail;
    const info: StatusInfo = { status, detail };
    this.statusListeners.forEach((l) => l(info));
  }
}
