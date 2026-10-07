/**
 * 「工具调用围栏不进答案区」的前后对比预览（2026-10-07 修复的验证辅助）。
 *
 * 背景：模型按约定把工具调用写在正文里（```toolcall / ```json），而修复前 daemon 把模型原始正文
 * **原样**当作 `message.delta` 推给面板 —— 于是每轮调用的原始 JSON 都固化在答案气泡里，
 * 并被扩展写进 `.dsh/history.json`。
 *
 * 这里刻意不手写"修复后应该长什么样"，而是：
 *  - 「修复前」= 同一段模型输出原样累积（即旧的推送内容）；
 *  - 「修复后」= 把同一段输出**按 4 字符一批**喂给**构建产物里真实的**
 *    `createToolCallFenceFilter`（`out/daemon/toolcall.js`），并列出每一批实际推出的增量。
 *  所以右侧不是文档，是行为；同时也是"围栏被切在 chunk 之间"这一难点的工作证据。
 *
 * 用法：node scripts/fencePreview.mjs   （需先 node esbuild.js）
 * 产物：scripts/fence-preview.html
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createToolCallFenceFilter } = require(join(here, '..', 'out', 'daemon', 'toolcall.js'));

/** 一段典型的一轮模型输出：说明文字 + 两个工具调用块 + 收尾文字。 */
const MODEL_OUTPUT = [
  '我先读取该文件确认结构。',
  '',
  '```toolcall',
  '{"tool":"read_file","input":{"path":"src/daemon/tools.ts","startLine":200,"endLine":230}}',
  '```',
  '',
  '顺便看下目录里还有哪些模块。',
  '',
  '```json',
  '{"tool":"list_dir","input":{"path":"src/daemon"}}',
  '```',
  '',
  '以上是两个只读调用。',
].join('\n');

const CHUNK = 4;
const filter = createToolCallFenceFilter();
const deltas = [];
for (let at = 0; at < MODEL_OUTPUT.length; at += CHUNK) {
  const visible = filter.push(MODEL_OUTPUT.slice(at, at + CHUNK));
  if (visible) deltas.push(visible);
}
const tail = filter.flush();
if (tail) deltas.push(tail);
const after = deltas.join('');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** 「修复前」里把注定要被吞掉的块标出来（本样本两个块都命中）。 */
const beforeHtml = esc(MODEL_OUTPUT).replace(
  /```[\s\S]*?```/g,
  (block) => `<mark class="gone">${block}</mark>`
);

const deltaRows = deltas
  .map((d, i) => `<tr><td>${i + 1}</td><td><code>${esc(JSON.stringify(d))}</code></td></tr>`)
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>修复前后对比：工具调用围栏不再进答案区</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 28px 32px 48px; background: #ffffff; color: #3b3b3b;
         font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.6; }
  h1 { font-size: 19px; margin: 0 0 6px; }
  .sub { color: #717171; margin: 0 0 22px; }
  .cols { display: flex; gap: 20px; align-items: flex-start; }
  .col { flex: 1 1 0; min-width: 0; }
  .col h2 { font-size: 13px; font-weight: 600; margin: 0 0 8px; letter-spacing: .02em; }
  .bad h2 { color: #b42318; }
  .good h2 { color: #067647; }
  pre { margin: 0; padding: 14px 16px; border: 1px solid #e5e5e5; border-radius: 8px;
        background: #fafafa; white-space: pre-wrap; word-break: break-word;
        font-family: ui-monospace, Consolas, "Cascadia Mono", monospace; font-size: 12.5px; line-height: 1.55; }
  mark.gone { background: #ffe0dd; color: #8a1c12; border-radius: 3px; }
  .stat { margin: 10px 0 0; color: #717171; font-size: 12px; }
  table { border-collapse: collapse; margin-top: 26px; font-size: 12.5px; }
  caption { text-align: left; color: #717171; padding-bottom: 8px; }
  th, td { border: 1px solid #e5e5e5; padding: 4px 10px; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; font-weight: 600; }
  code { font-family: ui-monospace, Consolas, "Cascadia Mono", monospace; }
  .note { margin-top: 24px; padding: 12px 14px; border-left: 3px solid #005fb8; background: #f4f8fd;
          color: #33475b; font-size: 12.5px; border-radius: 0 6px 6px 0; }
</style></head>
<body>
<h1>工具调用围栏不再进答案区 —— 修复前后对比</h1>
<p class="sub">同一段模型输出，按 4 字符一批推送。右侧是<strong>构建产物里真实过滤器</strong>的输出，不是手写的预期值。</p>
<div class="cols">
  <div class="col bad">
    <h2>修复前 · 答案气泡累积的内容</h2>
    <pre>${beforeHtml}</pre>
    <p class="stat">共 ${MODEL_OUTPUT.length} 字符；<mark class="gone">粉色</mark>是被原始 JSON 占掉的区域。</p>
  </div>
  <div class="col good">
    <h2>修复后 · 答案气泡累积的内容</h2>
    <pre>${esc(after)}</pre>
    <p class="stat">共 ${after.length} 字符；工具调用照常分派，只是不再展示原始 JSON。</p>
  </div>
</div>
<table>
  <caption>逐批推送的实际增量（围栏必然被切在 chunk 之间）</caption>
  <tr><th>#</th><th>message.delta</th></tr>
  ${deltaRows}
</table>
<div class="note">
  剥离是<strong>精准</strong>的：只吞「确实解析成工具调用」的 fenced 块。别种语言标签的代码块
  （<code>python</code> 里恰好有 <code>"tool"</code> 字段）、不含工具调用形状的 JSON、
  未闭合的围栏一律保留 —— 用户可能就是要看那段 JSON，而未闭合的是模型的坏输出，藏起来只会让人无从诊断。
  另外，过滤只发生在「推给人看的增量」上：回灌给模型的 <code>content</code> 保持原样，
  否则它下一轮会看到一段自己没说过的话。
</div>
</body></html>
`;

const out = join(here, 'fence-preview.html');
writeFileSync(out, html, 'utf8');
console.log(`[fencePreview] 已生成 ${out}`);
console.log(`[fencePreview] 修复前 ${MODEL_OUTPUT.length} 字符 -> 修复后 ${after.length} 字符，共推出 ${deltas.length} 批增量`);
