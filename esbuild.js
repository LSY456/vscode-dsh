'use strict';

/**
 * esbuild 构建脚本：
 *  - 扩展宿主：src/extension.ts            -> out/extension.js      (node, external: vscode/ws)
 *  - 参考 daemon：src/daemon/index.ts      -> out/daemon/index.js   (node, external: ws)
 *  - webview 静态资源：media/               -> out/media/
 *
 * 用法：node esbuild.js [--watch]
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: true,
  platform: 'node',
  target: 'node18',
  external: ['vscode', 'ws'],
  logLevel: 'info',
  legalComments: 'none',
};

async function copyMedia() {
  // 跳过 webview.js：该文件由 esbuild 的 webview entry 打包产出（而非源文件拷贝）
  fs.cpSync(path.join(__dirname, 'media'), path.join(__dirname, 'out', 'media'), {
    recursive: true,
    force: true,
    filter: (src) => !src.endsWith('webview.js'),
  });
  console.log('[esbuild] media -> out/media (webview.js excluded, bundled separately)');
}

async function main() {
  // 扩展宿主 / daemon（node 平台）
  const nodeCtx = await esbuild.context({
    ...common,
    entryPoints: {
      extension: 'src/extension.ts',
      'daemon/index': 'src/daemon/index.ts',
    },
    outdir: 'out',
  });

  // Webview（browser 平台：marked + highlight.js + dompurify 全部内联，外链为零，符合 CSP）
  const webCtx = await esbuild.context({
    bundle: true,
    sourcemap: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    logLevel: 'info',
    legalComments: 'none',
    entryPoints: { 'webview': 'media/webview.js' },
    outdir: 'out/media',
  });

  if (watch) {
    await nodeCtx.watch();
    await webCtx.watch();
    await copyMedia();
    console.log('[esbuild] watching...');
    // watch 模式下保持进程存活
    setInterval(() => {}, 1 << 30);
  } else {
    await Promise.all([nodeCtx.rebuild(), webCtx.rebuild()]);
    await nodeCtx.dispose();
    await webCtx.dispose();
    await copyMedia();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
