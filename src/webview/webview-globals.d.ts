/**
 * VS Code 注入到 webview 的全局函数声明。
 *
 * 它不属于任何 npm 包（运行时由宿主注入），所以 tsc 检查 panelCore.js 时会报
 * "Cannot find name 'acquireVsCodeApi'"。这里只补一个名字，不参与打包，
 * 也不改变运行时行为 —— 打包时 esbuild 直接忽略 .d.ts。
 */
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
