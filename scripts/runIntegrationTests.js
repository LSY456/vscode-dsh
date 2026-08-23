'use strict';

/**
 * 集成测试 runner（方案 C：@vscode/test-electron）。
 *
 * 启动真实 VSCode Extension Development Host，加载 out/test/integration/index.js，
 * 用临时工作区跑扩展宿主层 ↔ daemon 的完整闭环（T1/T2/T3/T4/T5）。
 *
 * 运行：npm run test:integration（需先 npm run build）
 * VSCode 可用时复用本机安装（跳过 ~数百 MB 下载），否则下载 stable（CI 走此路径）。
 */
const { runTests } = require('@vscode/test-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

function detectLocalVSCode() {
  if (process.env.VSCODE_TEST_EXE && fs.existsSync(process.env.VSCODE_TEST_EXE)) {
    return process.env.VSCODE_TEST_EXE;
  }
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    'C:\\vscode\\Microsoft VS Code\\Code.exe',
    path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    '/usr/bin/code',
    '/usr/local/bin/code',
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return undefined;
}

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const extensionTestsPath = path.resolve(extensionDevelopmentPath, 'out', 'test', 'integration', 'index.js');
  if (!fs.existsSync(extensionTestsPath)) {
    throw new Error(`未找到集成测试入口: ${extensionTestsPath}（请先 npm run build）`);
  }

  // 临时工作区：daemon 的 workspaceRoot 与测试落盘都限制在其内，隔离不污染项目
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-it-'));

  const exe = detectLocalVSCode();
  const opts = {
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspaceDir, '--disable-extensions', '--disable-workspace-trust'],
  };
  if (exe) {
    opts.vscodeExecutablePath = exe;
    console.log(`[integration] 使用本机 VSCode: ${exe}`);
  } else {
    opts.version = 'stable';
    console.log('[integration] 未检测到本机 VSCode，将下载 stable 版本');
  }

  let exitCode = 1;
  try {
    exitCode = await runTests(opts);
  } finally {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('[integration] 异常:', err);
  process.exit(1);
});