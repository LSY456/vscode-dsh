'use strict';

/**
 * 端到端冒烟测试（不依赖 VSCode）：
 *  - 拉起参考 daemon（out/daemon/index.js，随机端口 + token）
 *  - 校验安全握手：无 token / 带浏览器 Origin 均被拒绝
 *  - initialize -> session.create -> session.send
 *  - 补丁流程：file.patch.pending -> 接受 -> file.patch.result -> 磁盘内容已变更
 *  - 审批流程：approval.request -> 批准 -> tool.executed
 *  - 取消流程：slow 输出中 session.cancel -> session.ended(canceled)
 *  - ping / shutdown
 *
 * 运行：node scripts/smoke.js（需先 npm run build）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const DAEMON_SCRIPT = path.join(ROOT, 'out', 'daemon', 'index.js');
const TOKEN = 'smoke-token-' + Math.random().toString(36).slice(2);

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error('  FAIL: ' + msg);
  } else {
    console.log('  ok:   ' + msg);
  }
}

function connect(url, opts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('connect timeout'));
    }, 8000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function expectHandshakeFailure(url, opts, label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, opts);
    let failed = false;
    ws.on('error', () => {
      failed = true;
      resolve();
    });
    ws.on('close', () => {
      if (!failed) resolve();
    });
    ws.on('open', () => {
      assert(false, label + '（意外连接成功）');
      ws.close();
      resolve();
    });
    setTimeout(resolve, 8000);
  });
}

function makeRpc(ws) {
  let id = 0;
  const pending = new Map();
  const events = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message + ' (code ' + msg.error.code + ')'));
        else p.resolve(msg.result);
      }
    } else {
      events.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(msg)) {
          waiters[i].resolve(msg);
          waiters.splice(i, 1);
        }
      }
    }
  });
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const rid = ++id;
        pending.set(rid, { resolve, reject });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }));
      });
    },
    events,
    /** 清空已收到的事件（每个流程前调用，避免跨会话误匹配） */
    resetEvents() {
      events.length = 0;
    },
    waitFor(pred, label, timeoutMs) {
      return new Promise((resolve, reject) => {
        const found = events.find(pred);
        if (found) return resolve(found);
        const entry = { pred, resolve };
        waiters.push(entry);
        setTimeout(() => {
          const i = waiters.indexOf(entry);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('等待事件超时: ' + label));
        }, timeoutMs || 15000);
      });
    },
  };
}

async function main() {
  if (!fs.existsSync(DAEMON_SCRIPT)) {
    console.error('未找到 ' + DAEMON_SCRIPT + '，请先运行 npm run build');
    process.exit(1);
  }

  // ---- 0. 准备工作区与样例文件
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-'));
  const samplePath = path.join(tmpDir, 'sample.txt');
  const original = 'line1\nTODO: fix bug\nline3\n';
  fs.writeFileSync(samplePath, original, 'utf8');
  console.log('[smoke] 临时目录:', tmpDir);

  // ---- 1. 拉起 daemon
  console.log('[smoke] 拉起 daemon…');
  const child = spawn(process.execPath, [DAEMON_SCRIPT, '--port', '0', '--workspace', tmpDir], {
    env: { ...process.env, DSH_DAEMON_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('daemon 端口超时: ' + stderr)), 15000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/DSH_DAEMON_PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('daemon 退出 code=' + code + ': ' + stderr));
    });
  });
  console.log('[smoke] daemon 端口:', port);
  const url = 'ws://127.0.0.1:' + port;

  // ---- 2. 安全握手校验
  console.log('[smoke] 安全校验…');
  await expectHandshakeFailure(url, {}, '无 token 连接应被拒绝');
  await expectHandshakeFailure(
    url,
    { headers: { Authorization: 'Bearer ' + TOKEN, Origin: 'http://evil.example' } },
    '带浏览器 Origin 应被拒绝'
  );

  // ---- 3. 正常连接 + initialize
  console.log('[smoke] 握手…');
  const ws = await connect(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
  const rpc = makeRpc(ws);
  const init = await rpc.request('initialize', {
    workspaceRoot: tmpDir,
    preset: 'default',
    client: { name: 'smoke', version: '0.0.0' },
  });
  assert(init && init.protocolVersion === '1.0', 'initialize 返回协议版本 1.0');
  assert(init && init.capabilities.streaming && init.capabilities.filePatches, '能力声明完整');

  const created = await rpc.request('session.create', {});
  assert(created && typeof created.sessionId === 'string' && created.sessionId, 'session.create 返回 sessionId');
  const sessionId = created.sessionId;

  // ---- 4. 补丁流程
  console.log('[smoke] 补丁流程…');
  rpc.resetEvents();
  await rpc.request('session.send', {
    sessionId,
    prompt: '请修改文件内容，把 TODO 替换为 DONE（write edit）',
    attachments: [
      {
        kind: 'file',
        uri: 'file://' + samplePath.replace(/\\/g, '/'),
        path: samplePath,
        language: 'plaintext',
        name: 'sample.txt',
        content: original,
      },
    ],
  });
  const patchPending = await rpc.waitFor((m) => m.method === 'file.patch.pending', 'file.patch.pending');
  assert(patchPending.params.path === samplePath, '补丁目标路径正确');
  assert(patchPending.params.newContent.includes('DONE'), '补丁新内容包含 DONE');

  await rpc.request('file.patch.respond', { sessionId, patchId: patchPending.params.patchId, accept: true });
  const patchResult = await rpc.waitFor(
    (m) => m.method === 'file.patch.result' && m.params.patchId === patchPending.params.patchId,
    'file.patch.result'
  );
  assert(patchResult.params.accepted && patchResult.params.applied, '补丁被接受并应用');
  const onDisk = fs.readFileSync(samplePath, 'utf8');
  assert(onDisk.includes('DONE') && !onDisk.includes('TODO'), '磁盘文件已按新内容更新');
  const trajPatch = rpc.events.find((m) => m.method === 'trajectory.record' && m.params.kind === 'patch');
  assert(!!trajPatch, '迹线记录包含 patch 步骤');
  await rpc.waitFor((m) => m.method === 'session.ended', '补丁流程结束', 10000);

  // ---- 5. 审批流程
  console.log('[smoke] 审批流程…');
  rpc.resetEvents();
  await rpc.request('session.send', {
    sessionId,
    prompt: '危险操作：请运行 bash 命令 rm -rf build（danger）',
  });
  const approval = await rpc.waitFor((m) => m.method === 'approval.request', 'approval.request');
  assert(approval.params.tool === 'bash_execute', '审批对象为 bash_execute');
  assert(approval.params.risk === 'high', '风险级别 high');

  await rpc.request('approval.respond', {
    sessionId,
    approvalId: approval.params.approvalId,
    approved: true,
  });
  const toolDone = await rpc.waitFor(
    (m) => m.method === 'tool.executed' && m.params.tool === 'bash_execute',
    'tool.executed(bash_execute)'
  );
  assert(toolDone.params.ok === true, '批准后工具执行成功');
  await rpc.waitFor((m) => m.method === 'session.ended', '审批流程结束', 10000);

  // ---- 6. 取消流程
  console.log('[smoke] 取消流程…');
  rpc.resetEvents();
  await rpc.request('session.send', { sessionId, prompt: 'slow 输出测试，请慢慢回复（slow）' });
  await rpc.waitFor((m) => m.method === 'message.delta', '首条 message.delta');
  await rpc.request('session.cancel', { sessionId });
  const ended = await rpc.waitFor((m) => m.method === 'session.ended', 'session.ended', 10000);
  if (ended.params.reason !== 'canceled') {
    console.error('[smoke] DEBUG session.ended params:', JSON.stringify(ended.params));
    console.error('[smoke] DEBUG events:', JSON.stringify(rpc.events.map((e) => e.method)));
  }
  assert(ended.params.reason === 'canceled', '取消后 session.ended(reason=canceled)');

  // ---- 7. ping / shutdown
  const pong = await rpc.request('ping', {});
  assert(pong && typeof pong.pong === 'number', 'ping/pong 正常');
  await rpc.request('shutdown', {});
  ws.close();

  // ---- 8. 清理
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  console.log('');
  if (failures > 0) {
    console.error('[smoke] 失败 ' + failures + ' 项');
    process.exit(1);
  }
  console.log('[smoke] 全部通过 ✅');
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] 异常:', err);
  process.exit(1);
});
