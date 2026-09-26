/**
 * daemon 状态的**唯一文案来源**（扩展侧状态栏 / 通知 与 webview 状态行共用）。
 *
 * 为什么抽出来：此前状态栏直接拼内部枚举（界面上会出现 `dsh: connected`），而面板里另有一份
 * 中文映射（`media/webview.js` 的 `STATUS_LABEL`）—— 同一件事两处维护，且对用户暴露英文枚举。
 *
 * 本模块刻意**不 import vscode**，所以两处都能用：扩展侧直接 import，webview 侧经 esbuild 内联。
 * 排障信息（原始枚举、`detail` 原文）不进状态栏正文，留在 tooltip 与 OutputChannel。
 */
export type DaemonState =
  | 'stopped'
  | 'starting'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disabled'
  | 'restricted';

export const DAEMON_STATE_LABEL: Record<DaemonState, string> = {
  connected: '已连接',
  connecting: '连接中…',
  starting: '启动中…',
  stopped: '未启动',
  // 工作区未被信任：daemon 刻意不启动，是安全默认值而非故障
  restricted: '受限模式',
  // 没有打开文件夹 / daemon.mode = none：能力被有意关掉
  disabled: '仅 UI 模式',
  error: '错误',
};

/**
 * 状态 → 用户可读文案。
 * 未知取值原样透出（便于发现协议新增了状态），空值给「未知」。
 */
export function daemonStateLabel(state: string | undefined | null): string {
  if (!state) return '未知';
  return DAEMON_STATE_LABEL[state as DaemonState] ?? state;
}
