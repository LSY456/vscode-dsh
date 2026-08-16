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
  fs.cpSync(path.join(__dirname, 'media'), path.join(__dirname, 'out', 'media'), {
    recursive: true,
    force: true,
  });
  console.log('[esbuild] media -> out/media');
}

async function main() {
  const ctx = await esbuild.context({
    ...common,
    entryPoints: {
      extension: 'src/extension.ts',
      'daemon/index': 'src/daemon/index.ts',
    },
    outdir: 'out',
  });

  if (watch) {
    await ctx.watch();
    await copyMedia();
    console.log('[esbuild] watching...');
    // watch 模式下保持进程存活
    setInterval(() => {}, 1 << 30);
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    await copyMedia();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
