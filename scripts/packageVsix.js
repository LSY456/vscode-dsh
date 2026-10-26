/**
 * 打包 VSIX 的唯一入口（本地 `npm run package`、ci.yml 的 package job、release.yml 共用）。
 *
 * 收口的原因是一个踩过的坑：**`vsce package --out` 认的是「文件路径」，不是「目录」**。
 * 写成 `--out dist` 不会报错，而是产出一个**名叫 `dist`、没有扩展名**的文件；
 * 于是下游的 `dist/*.vsix` 通配一个都匹配不到 —— 步骤照样显示成功，artifact / Release
 * 附件却空空如也，全程没有任何告警。三处（本地脚本 + 两条工作流）各写一遍，就是三份
 * 迟早不一致的知识，所以只留这一份。
 *
 * 第二个坑：`vsce package` **不创建父目录**，只 open 目标文件。`dist/` 在 .gitignore 里，
 * CI 的干净检出根本没有它 → `ENOENT: ... dist/checkPackage.vsix`。那个报错只说打不开文件，
 * 看起来像打包坏了，实际是目录不存在。这里顺手 mkdir。
 *
 * 用法：`node scripts/packageVsix.js [--out <文件路径>]`
 *   缺省输出 `dist/vscode-dsh-<package.json 的 version>.vsix`。
 *   `--out` 供测试用（不必为了验证覆盖掉 dist/ 里的正式产物）。
 *
 * 注意 `vsce package` 会触发 `vscode:prepublish`（= `npm run build`），所以不需要先手动 build。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VSCE = path.join(ROOT, 'node_modules', '@vscode', 'vsce', 'vsce');

function resolveOut(argv) {
  const i = argv.indexOf('--out');
  if (i >= 0) {
    const v = argv[i + 1];
    if (!v) {
      console.error('[package] --out 后面必须跟一个文件路径（不是目录）');
      process.exit(1);
    }
    return path.resolve(v);
  }
  const { version } = require(path.join(ROOT, 'package.json'));
  return path.join(ROOT, 'dist', `vscode-dsh-${version}.vsix`);
}

const out = resolveOut(process.argv.slice(2));
if (!out.toLowerCase().endsWith('.vsix')) {
  // 目录被当路径传进来时 vsce 只会默默产出无扩展名文件，在这里先拦住
  console.error(`[package] 输出路径必须以 .vsix 结尾（--out 是文件路径，不是目录）：${out}`);
  process.exit(1);
}

// vsce 不创建父目录；CI 干净检出没有 dist/
fs.mkdirSync(path.dirname(out), { recursive: true });

// 异步 spawn：同步版在本机沙箱里一律 EBUSY（同 checkPackage.js）
const child = spawn(process.execPath, [VSCE, 'package', '--out', out], {
  cwd: ROOT,
  stdio: 'inherit',
});
child.on('error', (e) => {
  console.error('[package] 无法启动 vsce：', e);
  process.exit(1);
});
child.on('close', (code) => {
  if (code !== 0) {
    console.error(`[package] vsce 退出码 ${code}，未生成 ${path.relative(ROOT, out)}`);
    process.exit(code ?? 1);
  }
  const { size } = fs.statSync(out);
  console.log(`[package] 已生成 ${path.relative(ROOT, out)}（${(size / 1024).toFixed(1)} KB）`);
});
