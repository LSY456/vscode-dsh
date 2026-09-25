/**
 * 工作区信任（Workspace Trust）门禁：**唯一判定入口**。
 *
 * 为什么需要它：本插件会拉起一个能读写工作区文件、执行命令的子进程，而"要执行的命令"来自配置项
 * `dsh.daemon.command`。若该配置可被工作区设置覆盖，那么打开一个恶意仓库、点开 dsh 面板
 * 就等于让它在本机执行任意进程。VS Code 的对抗手段就是工作区信任。
 *
 * 三层防护，缺任何一层都能被绕过：
 *   ① `package.json` 的 `capabilities.untrustedWorkspaces.restrictedConfigurations`
 *      —— 这些项在工作区设置里**不生效**（由 VS Code 强制，我们声明即可）；
 *   ② 会执行代码的配置项钉成机器作用域（`"scope": "machine"`，同样不可被工作区覆盖）；
 *   ③ 本模块 + `DaemonManager.start()` 的运行期门禁 —— 未信任时**连子进程都不拉起**。
 * ①②是"声明"，只有 ③ 能给出"为什么不能用"的可读反馈，也能兜住声明被误删的情况
 * （声明本身由 `src/manifest.test.ts` 钉住）。
 *
 * 本模块刻意保持**纯函数**（不 import vscode），所以它可被单测直接覆盖；
 * 真正会碰 vscode API 的那一小段在 `src/trustCommands.ts`。
 */

/** VS Code 内置命令：打开「工作区信任」管理界面（UI 上的"信任此工作区"按钮走它） */
export const TRUST_MANAGE_COMMAND = 'workbench.trust.manage';

/** 状态横幅内容（与「演示模式」共用同一块 UI，见 media/webview.js 的 renderStateBanner） */
export interface TrustBanner {
  tag: string;
  text: string;
  actionLabel: string;
}

export interface TrustGate {
  /** true = 本次不启动 daemon */
  blocked: boolean;
  /** 状态行/状态栏用的短标签（仅 blocked 时有意义） */
  statusLabel: string;
  /** 完整说明：状态栏 tooltip、发送被拒时的错误文案都用它 */
  statusDetail: string;
  /** 受限模式横幅；已信任时为 null */
  banner: TrustBanner | null;
}

/**
 * 解析信任门禁。
 *
 * 文案刻意写成"说清为什么 + 给出下一步"，而不是"操作被禁止"：
 * 受限模式是安全默认值，不是错误，用户需要知道点哪里能解除。
 */
export function resolveTrustGate(isTrusted: boolean): TrustGate {
  if (isTrusted) {
    return { blocked: false, statusLabel: '', statusDetail: '', banner: null };
  }
  return {
    blocked: true,
    statusLabel: '受限模式',
    statusDetail:
      '当前工作区未被信任（受限模式），Agent 未启动：它需要读写工作区文件、执行命令，' +
      '并在 .dsh/ 下写入会话记录。信任此工作区后即可正常使用。',
    banner: {
      tag: '受限模式',
      text:
        '当前工作区未被信任，Agent 未启动 —— 它需要读写工作区文件、执行命令，' +
        '并在 .dsh/ 下写入会话记录。',
      actionLabel: '信任此工作区',
    },
  };
}
