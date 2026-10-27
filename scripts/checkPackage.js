/**
 * 打包清单守卫（零第三方依赖，本地与 CI 共用）。
 *
 * 为什么需要它：`.vscodeignore` 是**黑名单** —— 漏一条就是"内部文件跟着发布出去"，
 * 而且不会有任何提示（vsce 不告警、本地也没人会去看清单）。此前真实发生过：
 * `.workbuddy/memory/*.md`（本地工作记录）、全部 `*.map`、两份内部评审文档混进 VSIX，
 * 体积从 214 KB 虚涨到 573 KB。
 *
 * 所以把"包里有什么"变成**可断言的清单**：跑真实的 `vsce ls`（而不是读 `.vscodeignore` 猜
 * —— 那两个正则的递归语义历史上就对不上），禁入项出现 / 必需项缺失 / 文件数或体积越过门槛
 * → 非零退出。
 *
 * 用法：`node scripts/checkPackage.js`（`npm run check:package`）。需要先 `npm run build`。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VSCE = path.join(ROOT, 'node_modules', '@vscode', 'vsce', 'vsce');

/** 绝不能出现在 VSIX 里的东西。以 `/` 结尾 = 前缀匹配，否则精确匹配。 */
const FORBIDDEN = [
  ['.workbuddy/', '本地 AI 工作记录，不该对外'],
  ['.dsh/', '本地会话与轨迹'],
  ['src/', 'TypeScript 源码（包里只需要 out/ 的构建产物）'],
  ['shared/', '同上'],
  ['media/', '源样式与源脚本（包里只需要 out/media/）'],
  ['scripts/', '开发脚本'],
  ['.github/', 'CI 配置'],
  ['.vscode/', '编辑器调试配置'],
  ['out/test/', '集成测试产物'],
  ['test/', '测试源码'],
  ['docs/project-review.md', '内部评审文档'],
  ['docs/strategy-agent-kernel.md', '内部设计文档'],
  ['docs/vscode-platform-audit.md', '内部平台审计'],
  ['package-lock.json', '锁文件对使用者无意义'],
  ['esbuild.js', '构建脚本'],
  ['tsconfig.json', '构建配置'],
  ['vitest.config.ts', '测试配置'],
  ['.editorconfig', '编辑器配置，对使用者无意义'],
];

/** 少了就说明打包真的坏了 —— 那不是"规则收紧"，而是"扩展缺件"。 */
const REQUIRED = [
  'package.json',
  'out/extension.js',
  'out/daemon/index.js',
  'out/daemon/toolcall.js',
  'out/media/webview.js',
  'out/media/webview.html',
  'out/media/webview.css',
  'LICENSE',
  'README.md',
  'node_modules/ws/package.json',
];

const MAX_FILES = 45;
const MAX_BYTES = 320 * 1024;

/** 跑子进程并收集输出。刻意用异步 spawn：同步版在本机沙箱里一律 EBUSY。 */
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function matchedRule(entry) {
  for (const [rule] of FORBIDDEN) {
    if (rule.endsWith('/') ? entry.startsWith(rule) : entry === rule) return rule;
  }
  // 任意位置的 sourcemap 都不该进包（`.vscodeignore` 里必须写 `**/*.map` 而不是 `*.map`）
  if (entry.endsWith('.map')) return '*.map';
  return undefined;
}

(async () => {
  const failures = [];

  const ls = await run([VSCE, 'ls']);
  if (ls.code !== 0) {
    console.error('[checkPackage] 无法执行 vsce ls：\n' + (ls.err || ls.out).trim());
    process.exit(1);
  }
  const files = ls.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const f of files) {
    const rule = matchedRule(f);
    if (rule) failures.push(`禁入项：${f}（命中规则 ${rule}）`);
  }
  for (const r of REQUIRED) {
    if (!files.includes(r)) failures.push(`缺少必需项：${r}`);
  }
  if (files.length > MAX_FILES) {
    failures.push(`文件数 ${files.length} 超过门槛 ${MAX_FILES} —— .vscodeignore 是不是被放宽了？`);
  }

  // 清单看不出压缩后的体积，故实打一次包再量（产物是临时的，量完即删）
  const out = path.join(ROOT, 'dist', 'checkPackage.vsix');
  // 必须自己建目录：`dist` 在 .gitignore 里，CI 的干净检出**没有这个目录**，
  // 而 `vsce package --out` 只 open 目标文件、不创建父目录 → ENOENT。
  // 那个报错只说"打不开 dist/checkPackage.vsix"，看着像打包坏了，实际是目录不存在；
  // 本地一直是绿的，纯粹因为 dist/ 早被真包占着（本地与 CI 的差异全在这种地方）。
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const pack = await run([VSCE, 'package', '--out', out]);
  let bytes = 0;
  if (pack.code === 0 && fs.existsSync(out)) {
    bytes = fs.statSync(out).size;
    fs.rmSync(out, { force: true });
    if (bytes > MAX_BYTES) {
      failures.push(
        `VSIX 体积 ${(bytes / 1024).toFixed(1)} KB 超过门槛 ${(MAX_BYTES / 1024).toFixed(0)} KB`
      );
    }
  } else {
    failures.push('vsce package 失败，无法核对体积：\n' + (pack.err || pack.out).trim());
  }

  console.log(`[checkPackage] 清单 ${files.length} 个文件，VSIX ${(bytes / 1024).toFixed(1)} KB`);
  if (failures.length) {
    console.error('\n[checkPackage] 未通过：');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[checkPackage] 通过：无禁入项、必需项齐全、体积在门槛内 ✅');
})().catch((e) => {
  console.error('[checkPackage] 异常：', e);
  process.exit(1);
});
