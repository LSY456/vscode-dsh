'use strict';

/**
 * 真实模型连通冒烟（可选，需真实 apiKey；不参与 npm test / CI）。
 *
 * 目的（测试守则：真实场景，不凑数）：单元测试用 stub fetch，本脚本用真实
 * endpoint + 真实 SSE 流验证两条适配链（OpenAI 兼容 / Anthropic）确实能
 * 解析出非空正文，并确认流式 onChunk 在真实响应下被触发。
 *
 * 场景一（硬断言）：单轮 chat 连通——正文非空且流式增量到达。
 * 场景二（软探针）：fenced 工具调用——引导模型输出 fenced JSON 工具调用，再用
 *   parseToolCalls 解析并报告结果（真实模型行为不完全可控，故只报告、不硬失败）。
 * 场景三（软探针）：原生 function calling——给 chat 传 tools，检查返回的
 *   result.toolCalls 是否解析出原生工具调用（OpenAI tool_calls / Anthropic tool_use）。
 *
 * 运行：node scripts/smokeReal.js（先执行 npm run build 产出 out/daemon/model.js 与 toolcall.js）
 * 环境变量（不硬编码、不写盘、不打印 key）：
 *   - DSH_OPENAI_API_KEY / DSH_OPENAI_BASE_URL / DSH_OPENAI_MODEL
 *   - DSH_ANTHROPIC_API_KEY / DSH_ANTHROPIC_BASE_URL / DSH_ANTHROPIC_MODEL
 * 缺 key 的路直接跳过；全部缺 key 时提示后退出 0（诚实跳过，不视为失败）。
 */
const { createModel } = require('../out/daemon/model.js');
const { parseToolCalls } = require('../out/daemon/toolcall.js');

const PROMPT = '请只回复两个字：在呀';

const TOOL_SYSTEM = [
  '你是 dsh 编程助手，通过工具与工作区交互。需要读取文件时，只输出一个 fenced JSON 块',
  '（```toolcall 或 ```json，块内为 JSON 对象，不要附加任何说明文字）：',
  '```toolcall',
  '{"tool":"read_file","input":{"path":"<绝对路径>"}}',
  '```',
].join('\n');

const TOOL_USER = '请读取当前工作区文件 README.md 的内容（用工具调用格式回复，不要直接回答内容）。';

/** 场景三（原生 function calling）：暴露给模型的工具 schema（与 realAgent 的 read_file 一致）。 */
const NATIVE_TOOLS = [
  {
    name: 'read_file',
    description: '读取工作区内的文本文件',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '工作区内的绝对路径' } },
      required: ['path'],
    },
  },
];

const NATIVE_USER = '请读取工作区 README.md 的内容（用 read_file 工具，不要直接回答内容）。';

function errMsg(e) {
  return e && e.message ? e.message : String(e);
}

function makeModel(t) {
  return createModel({ provider: t.provider, baseURL: t.baseURL, apiKey: t.apiKey, model: t.model });
}

/** 软探针统一报告：不硬失败，按 parsed 打印 ok / 提示，异常打印并吞掉。 */
async function reportProbe(t, label, probe) {
  try {
    const p = await probe(t);
    if (p.parsed) {
      console.log(`[smokeReal] ${label} ok     ${t.name}  ${p.okDetail}`);
    } else {
      console.log(`[smokeReal] ${label} 提示   ${t.name}  ${p.hintDetail}`);
    }
  } catch (e) {
    console.log(`[smokeReal] ${label} 异常   ${t.name}: ${errMsg(e)}`);
  }
}

function resolveTargets() {
  const targets = [];
  if (process.env.DSH_OPENAI_API_KEY) {
    targets.push({
      name: 'openai-compat',
      provider: 'openai',
      apiKey: process.env.DSH_OPENAI_API_KEY,
      baseURL: process.env.DSH_OPENAI_BASE_URL || 'https://api.deepseek.com/v1',
      model: process.env.DSH_OPENAI_MODEL || 'deepseek-flash',
    });
  }
  if (process.env.DSH_ANTHROPIC_API_KEY) {
    targets.push({
      name: 'anthropic',
      provider: 'anthropic',
      apiKey: process.env.DSH_ANTHROPIC_API_KEY,
      baseURL: process.env.DSH_ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      model: process.env.DSH_ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
    });
  }
  return targets;
}

async function runOne(t) {
  const model = makeModel(t);
  let reasoningChunks = 0;
  let contentChunks = 0;
  const res = await model.chat([{ role: 'user', content: PROMPT }], {
    temperature: 0,
    onChunk: (c) => {
      if (c.type === 'reasoning') reasoningChunks++;
      else contentChunks++;
    },
  });
  return {
    ...t,
    contentLength: res.content.length,
    reasoningLength: res.reasoning.length,
    reasoningChunks,
    contentChunks,
    // 真实场景判定：请求成功且正文非空、流式增量确实到达
    ok: res.content.trim().length > 0 && contentChunks > 0,
  };
}

async function runToolProbe(t) {
  const model = makeModel(t);
  const res = await model.chat(
    [
      { role: 'system', content: TOOL_SYSTEM },
      { role: 'user', content: TOOL_USER },
    ],
    { temperature: 0 }
  );
  const calls = parseToolCalls(res.content);
  return {
    parsed: calls.length > 0,
    okDetail: `解析出 ${calls.length} 个调用，首个=${calls[0]?.tool}`,
    hintDetail: `模型未输出可解析的工具调用；正文前 240 字：${JSON.stringify(res.content.slice(0, 240))}`,
  };
}

async function runNativeToolProbe(t) {
  const model = makeModel(t);
  const res = await model.chat([{ role: 'user', content: NATIVE_USER }], {
    temperature: 0,
    tools: NATIVE_TOOLS,
  });
  const calls = res.toolCalls ?? [];
  return {
    parsed: calls.length > 0,
    okDetail: `原生 tool_calls 解析出 ${calls.length} 个，首个=${calls[0]?.tool}`,
    hintDetail: `模型未返回原生 tool_calls；正文前 240 字：${JSON.stringify(res.content.slice(0, 240))}`,
  };
}

async function main() {
  const targets = resolveTargets();
  if (targets.length === 0) {
    console.log(
      '[smokeReal] 未设置 DSH_OPENAI_API_KEY / DSH_ANTHROPIC_API_KEY，跳过真实连通（诚实跳过，不视为失败）。'
    );
    console.log('[smokeReal] 用法：设置上述环境变量后 node scripts/smokeReal.js');
    return;
  }

  let failures = 0;
  for (const t of targets) {
    // 场景一：连通（硬断言）
    try {
      const r = await runOne(t);
      if (r.ok) {
        console.log(
          `[smokeReal] 连通 ok     ${t.name}  正文${r.contentLength}字/思维链${r.reasoningLength}字/流块 content ${r.contentChunks} + reasoning ${r.reasoningChunks}`
        );
      } else {
        failures++;
        console.error(
          `[smokeReal] 连通 FAIL   ${t.name}  正文为空或流式未触发（content=${r.contentLength}字, chunks=${r.contentChunks}）`
        );
      }
    } catch (e) {
      failures++;
      console.error(`[smokeReal] 连通 FAIL   ${t.name}  异常: ${errMsg(e)}`);
    }

    // 场景二：fenced 工具调用探针（软报告，不硬失败）
    await reportProbe(t, '工具探针', runToolProbe);

    // 场景三：原生 function calling 探针（软报告，不硬失败）
    await reportProbe(t, '原生探针', runNativeToolProbe);
  }

  if (failures > 0) {
    console.error(`[smokeReal] 连通失败 ${failures} 项`);
    process.exit(1);
  }
  console.log('[smokeReal] 连通冒烟全部通过 ✅（工具探针结果见上方，仅供人工判断）');
}

main().catch((e) => {
  console.error('[smokeReal] 异常:', e);
  process.exit(1);
});