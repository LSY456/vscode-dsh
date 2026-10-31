/**
 * 命令执行沙箱（P3.5+ 可插拔后端 + 应用层兜底）。
 *
 * 分层设计（诚实披露，不伪隔离）：
 *  - Linux + bubblewrap 可用：BwrapSandbox —— 用 bwrap `--unshare-all` 提供
 *    网络/PID/mount 命名空间隔离、只读根视图（工作区外不可写）、干净环境。
 *  - 其余平台或 bwrap 不可用：ProcessSandbox —— 应用层兜底加固：
 *    cwd 强约束（钳制到工作区内）、环境变量最小化（剥离 token/密钥）、
 *    超时后整棵进程树终止（不再残留孙进程）。
 *
 * 检测结果通过 SandboxDetection.warnings 显式上报降级原因，便于运维审阅。
 */
import { assertPathInside } from './paths';

/** 交给 child_process.spawn 的一次完整执行规格。 */
export interface SandboxedCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** 是否再包一层 shell；spawn 侧据此决定 shell 选项。 */
  shell: boolean;
}

export interface CommandSandbox {
  readonly kind: string;
  /** 把待执行的 shell 命令包装为受限执行规格。 */
  prepare(command: string, cwd: string): SandboxedCommand;
}

/** 应用层兜底：仅保留运行必需的环境变量，剥离 token/密钥等敏感项。 */
const ENV_ALLOWLIST = new Set<string>([
  // 进程与路径
  'PATH',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  // 家目录与临时目录
  'HOME',
  'USERPROFILE',
  'TEMP',
  'TMP',
  // 区域/编码
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
]);

export function sanitizeEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && ENV_ALLOWLIST.has(k)) out[k] = v;
  }
  return out;
}

/** 将 cwd 钳制到工作区内（无法解析/越界时回退工作区根）。 */
export function confineCwd(cwd: string, workspaceRoot: string): string {
  if (!cwd) return workspaceRoot;
  try {
    return assertPathInside(workspaceRoot, cwd);
  } catch {
    return workspaceRoot;
  }
}

/** 按平台选择 shell 二分（Windows cmd / POSIX sh），显式二进程序列而非 `shell:true`。 */
function platformShell(command: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { command: '/bin/sh', args: ['-c', command] };
}

export class ProcessSandbox implements CommandSandbox {
  readonly kind = 'process';
  private readonly workspaceRoot: string;

  constructor(opts: { workspaceRoot: string }) {
    this.workspaceRoot = opts.workspaceRoot;
  }

  prepare(command: string, cwd: string): SandboxedCommand {
    return {
      ...platformShell(command),
      cwd: confineCwd(cwd, this.workspaceRoot),
      env: sanitizeEnv(),
      shell: false,
    };
  }
}

/** Linux bubblewrap：命名空间隔离 + 只读根 + 工作区外不可写 + 干净环境。 */
export class BwrapSandbox implements CommandSandbox {
  readonly kind = 'bwrap';
  private readonly workspaceRoot: string;

  constructor(opts: { workspaceRoot: string }) {
    this.workspaceRoot = opts.workspaceRoot;
  }

  prepare(command: string, cwd: string): SandboxedCommand {
    const safeCwd = confineCwd(cwd, this.workspaceRoot);
    return {
      command: 'bwrap',
      args: [
        '--unshare-all',
        '--die-with-parent',
        '--clearenv',
        '--setenv',
        'PATH',
        '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        '--ro-bind',
        '/',
        '/',
        // 挂载顺序即语义：bwrap 按参数顺序逐个挂载，后者覆盖前者。
        // `--tmpfs /tmp` 必须排在 `--bind <工作区>` 之前 —— 反过来（先 bind 再 tmpfs）
        // 会把刚 bind 进来的工作区整块盖成空目录；工作区恰好落在 /tmp 下时 `--chdir`
        // 就找不到目录，报 `bwrap: Can't chdir to /tmp/…: No such file or directory`。
        // 真实触发：CI runner 镜像装上 bwrap 后，smoke 的临时工作区（/tmp/dsh-smoke-XXXX）
        // 让这条路径从"从未被执行"变成"每次必失败"—— 而在此之前一律走的是
        // ProcessSandbox（runner 上没有 bwrap），所以这个顺序错误潜伏了很久。
        '--tmpfs',
        '/tmp',
        '--dev',
        '/dev',
        '--proc',
        '/proc',
        '--bind',
        this.workspaceRoot,
        this.workspaceRoot,
        '--chdir',
        safeCwd,
        '/bin/sh',
        '-c',
        command,
      ],
      cwd: safeCwd,
      env: {},
      shell: false,
    };
  }
}

export interface SandboxDetection {
  sandbox: CommandSandbox;
  /** 降级/受限原因，供运维与审计审阅（诚实披露）。 */
  warnings: string[];
}

/**
 * 检测可用沙箱后端；后端检测可注入（单测无需真实 spawn）。
 * 缺省按平台 + 是否具备 bwrap 判断，不可用时显式降级到应用层兜底。
 */
export function detectSandbox(
  workspaceRoot: string,
  opts: { hasBwrap?: () => boolean; platform?: NodeJS.Platform } = {}
): SandboxDetection {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'linux') {
    return {
      sandbox: new ProcessSandbox({ workspaceRoot }),
      warnings: ['当前平台无可用的 OS 级沙箱后端，命令执行已降级为应用层加固（cwd 约束 + 环境最小化 + 进程树终止）'],
    };
  }

  let has = false;
  try {
    has = opts.hasBwrap ? opts.hasBwrap() : detectBwrapViaCls();
  } catch {
    has = false;
  }

  if (has) {
    return {
      sandbox: new BwrapSandbox({ workspaceRoot }),
      warnings: [],
    };
  }
  return {
    sandbox: new ProcessSandbox({ workspaceRoot }),
    warnings: ['未检测到 bubblewrap（bwrap），命令执行已降级为应用层加固（cwd 约束 + 环境最小化 + 进程树终止）'],
  };
}

function detectBwrapViaCls(): boolean {
  // 延迟 require，避免测试环境无 child_process 场景被加载
  const cp = require('child_process') as typeof import('child_process');
  const r = cp.spawnSync('bwrap', ['--version'], { stdio: 'pipe', windowsHide: true });
  return (r.status ?? 1) === 0;
}