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
const crypto = require('crypto');
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
  // 构建指纹：每次构建生成随机 buildId 落盘 out/buildId.json。
  // daemon 握手时上报，扩展比对发现不一致即复用到了旧构建 daemon，自动回收重启。
  const buildId = crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, 'out', 'buildId.json'),
    JSON.stringify({ id: buildId, ts: Date.now() }, null, 2)
  );
  console.log(`[esbuild] buildId=${buildId}`);

  // 扩展宿主 / daemon（node 平台）
  const nodeCtx = await esbuild.context({
    ...common,
    entryPoints: {
      extension: 'src/extension.ts',
      'daemon/index': 'src/daemon/index.ts',
      // 独立产出 model 适配层，供 scripts/smokeReal.js 真实连通验证复用（不经 daemon 入口）
      'daemon/model': 'src/daemon/model.ts',
    },
    outdir: 'out',
  });

  // 集成测试（@vscode/test-electron）：独立编译到 out/test/integration/*.js，
  // 由 Extension Development Host 加载；mocha 运行时 require（external），vscode/ws 亦然。
  const testDir = path.join(__dirname, 'src', 'test', 'integration');
  const testEntries = {};
  if (fs.existsSync(testDir)) {
    for (const f of fs.readdirSync(testDir)) {
      if (f.endsWith('.ts')) {
        testEntries[`test/integration/${f.replace(/\.ts$/, '')}`] = path.join(testDir, f);
      }
    }
  }
  const testCtx = await esbuild.context({
    bundle: true,
    sourcemap: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode', 'ws', 'mocha'],
    logLevel: 'info',
    legalComments: 'none',
    entryPoints: testEntries,
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
    await testCtx.watch();
    await webCtx.watch();
    await copyMedia();
    console.log('[esbuild] watching...');
    // watch 模式下保持进程存活
    setInterval(() => {}, 1 << 30);
  } else {
    await Promise.all([nodeCtx.rebuild(), testCtx.rebuild(), webCtx.rebuild()]);
    await nodeCtx.dispose();
    await testCtx.dispose();
    await webCtx.dispose();
    await copyMedia();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
