'use strict';

/**
 * 端到端冒烟测试（不依赖 VSCode）。
 *
 * 覆盖（P0/P1）：
 *  - 安全握手：无 token / 带浏览器 Origin 均被拒绝
 *  - initialize 返回 sessionId 与能力声明（resume/fileRead）
 *  - 能力分级：allowedTools 为空时高危工具直接禁用（不发审批）
 *  - 补丁流程：file.patch.pending -> 接受 -> file.patch.result -> 磁盘已变更
 *  - 审批流程：approval.request -> 批准 -> tool.executed
 *  - 多会话并发：同一连接两个会话并行（不再 -32009）
 *  - 取消流程：slow 中 session.cancel -> session.ended(canceled)
 *  - 断线续跑：断开后 session.resume 重放事件并返回状态
 *  - file.read：工作区内可读 / 越界返回 -32012
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
        if (msg.error) {
          const err = new Error(msg.error.message + ' (code ' + msg.error.code + ')');
          err.code = msg.error.code;
          p.reject(err);
        } else {
          p.resolve(msg.result);
        }
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
    /** 从指定索引之后等待事件（续跑场景避免匹配重放的历史事件）。 */
    waitFor(pred, label, timeoutMs, startIndex) {
      const minIndex = startIndex || 0;
      return new Promise((resolve, reject) => {
        const found = events.slice(minIndex).find(pred);
        if (found) return resolve(found);
        const entry = { pred, resolve, minIndex };
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

/** 建立连接 + rpc，并完成 initialize 握手。 */
async function openSession(port, initializeParams) {
  const ws = await connect('ws://127.0.0.1:' + port, {
    headers: { Authorization: 'Bearer ' + TOKEN },
  });
  const rpc = makeRpc(ws);
  const init = await rpc.request('initialize', initializeParams);
  return { ws, rpc, init };
}

/** 拉起 daemon 进程，返回 { child, port }（port 为 Promise）。 */
function spawnDaemon(extraArgs) {
  const child = spawn(process.execPath, [DAEMON_SCRIPT, ...extraArgs], {
    env: { ...process.env, DSH_DAEMON_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));
  const port = new Promise((resolve, reject) => {
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
  return { child, port };
}

async function main() {
  if (!fs.existsSync(DAEMON_SCRIPT)) {
    console.error('未找到 ' + DAEMON_SCRIPT + '，请先运行 npm run build');
    process.exit(1);
  }

  // ---- 0. 准备工作区与样例文件
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-'));
  const samplePath = path.join(tmpDir, 'sample.txt');
  const sample2Path = path.join(tmpDir, 'sample2.txt');
  const original = 'line1\nTODO: fix bug\nline3\n';
  fs.writeFileSync(samplePath, original, 'utf8');
  fs.writeFileSync(sample2Path, original, 'utf8');
  console.log('[smoke] 临时目录:', tmpDir);

  // ---- 1. 拉起 daemon
  console.log('[smoke] 拉起 daemon…');
  const port = await spawnDaemon(['--port', '0', '--workspace', tmpDir]).port;
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

  // ---- 3. 能力分级：仅允许 read_file（bash_execute 被禁用）
  console.log('[smoke] 能力分级…');
  const connDisabled = await openSession(port, {
    workspaceRoot: tmpDir,
    capabilities: { allowedTools: ['read_file'] },
    client: { name: 'smoke', version: '0.0.0' },
  });
  assert(connDisabled.init.sessionId, 'initialize 返回 sessionId');
  assert(connDisabled.init.capabilities.resume === true, '能力声明包含 resume');
  assert(connDisabled.init.capabilities.fileRead === true, '能力声明包含 fileRead');
  connDisabled.rpc.resetEvents();
  await connDisabled.rpc.request('session.send', {
    sessionId: connDisabled.init.sessionId,
    prompt: '危险操作：bash rm -rf（danger）',
  });
  const disabledTool = await connDisabled.rpc.waitFor(
    (m) => m.method === 'tool.executed' && m.params.tool === 'bash_execute',
    '禁用工具 tool.executed'
  );
  assert(disabledTool.params.ok === false, '禁用工具执行失败（ok:false）');
  assert(
    !connDisabled.rpc.events.some((m) => m.method === 'approval.request'),
    '禁用工具不发起审批'
  );
  await connDisabled.rpc.waitFor((m) => m.method === 'session.ended', '禁用流程结束');
  connDisabled.ws.close();

  // ---- 4. 主连接：默认能力
  console.log('[smoke] 握手…');
  const { rpc, ws, init } = await openSession(port, {
    workspaceRoot: tmpDir,
    preset: 'default',
    client: { name: 'smoke', version: '0.0.0' },
  });
  const sessionId = init.sessionId;

  // ---- 5. 补丁流程
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

  // ---- 6. 审批流程
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

  // ---- 7. 多会话并发（P1.5）：同一连接两个会话并行
  console.log('[smoke] 多会话并发…');
  rpc.resetEvents();
  await rpc.request('session.send', { sessionId, prompt: 'slow 输出测试（slow）' });
  const sessionB = (await rpc.request('session.create', {})).sessionId;
  assert(sessionB && sessionB !== sessionId, '创建第二个会话');
  await rpc.request('session.send', {
    sessionId: sessionB,
    prompt: '请修改 sample2 中的 TODO（write edit）',
    attachments: [
      {
        kind: 'file',
        path: sample2Path,
        name: 'sample2.txt',
        content: original,
      },
    ],
  });
  const patchB = await rpc.waitFor(
    (m) => m.method === 'file.patch.pending' && m.params.path === sample2Path,
    '会话B补丁'
  );
  await rpc.request('file.patch.respond', { sessionId: sessionB, patchId: patchB.params.patchId, accept: true });
  await rpc.waitFor(
    (m) => m.method === 'session.ended' && m.params.sessionId === sessionB,
    '会话B结束'
  );
  assert(fs.readFileSync(sample2Path, 'utf8').includes('DONE'), '会话B补丁已落盘');
  await rpc.request('session.cancel', { sessionId });
  const endedA = await rpc.waitFor(
    (m) => m.method === 'session.ended' && m.params.sessionId === sessionId,
    '会话A取消结束'
  );
  assert(endedA.params.reason === 'canceled', '并发场景下会话A取消成功');

  // ---- 8. 断线续跑（P1.2）：session.resume 重放事件
  console.log('[smoke] 断线续跑…');
  rpc.resetEvents();
  await rpc.request('session.send', { sessionId, prompt: 'slow 输出测试（slow）' });
  await rpc.waitFor((m) => m.method === 'message.delta', '首条 message.delta');
  ws.close(); // 模拟断线（daemon 侧会话继续运行并缓冲事件）

  const conn2 = await openSession(port, {
    workspaceRoot: tmpDir,
    client: { name: 'smoke', version: '0.0.0' },
  });
  const resumed = await conn2.rpc.request('session.resume', { sessionId });
  assert(resumed.sessionId === sessionId, 'resume 返回原会话');
  assert(['running', 'idle'].includes(resumed.state), 'resume 返回有效状态: ' + resumed.state);
  assert(
    conn2.rpc.events.some((m) => m.method === 'session.started' && m.params.sessionId === sessionId),
    'resume 重放包含 session.started'
  );
  if (resumed.state === 'running') {
    // 重放已在 resume 响应前完成；从当前索引之后等待"实时"事件，避免匹配历史 session.ended
    const base = conn2.rpc.events.length;
    await conn2.rpc.request('session.cancel', { sessionId });
    const endedResume = await conn2.rpc.waitFor(
      (m) => m.method === 'session.ended' && m.params.sessionId === sessionId,
      '续跑会话取消',
      10000,
      base
    );
    assert(endedResume.params.reason === 'canceled', '续跑会话可正常取消');
  }

  // ---- 9. file.read（P1.6）：工作区内可读 / 越界拒绝
  console.log('[smoke] file.read…');
  const readOk = await conn2.rpc.request('file.read', { path: samplePath });
  assert(readOk.content.includes('line1'), 'file.read 工作区内读取成功');
  let readRejected = false;
  try {
    await conn2.rpc.request('file.read', { path: path.join(tmpDir, '..', 'secret.txt') });
  } catch (err) {
    readRejected = err.code === -32012;
  }
  assert(readRejected, 'file.read 越界返回 -32012');

  // ---- 10. 真实 Agent 流水线（--agent real --fake-model，不起网络）
  console.log('[smoke] 真实 Agent（假模型）…');
  const realPort = await spawnDaemon(['--port', '0', '--workspace', tmpDir, '--agent', 'real', '--fake-model']).port;
  const rconn = await openSession(realPort, {
    workspaceRoot: tmpDir,
    client: { name: 'smoke', version: '0.0.0' },
  });
  assert(rconn.init.agent === 'real', 'initialize 返回 agent=real');
  const rsessionId = rconn.init.sessionId;

  // read_file 工具（假模型按 prompt 关键字派发）
  fs.writeFileSync(samplePath, original, 'utf8');
  rconn.rpc.resetEvents();
  await rconn.rpc.request('session.send', {
    sessionId: rsessionId,
    prompt: '请查看 sample.txt（read）',
    attachments: [{ kind: 'file', path: samplePath, name: 'sample.txt', content: original }],
  });
  await rconn.rpc.waitFor((m) => m.method === 'tool.executed' && m.params.tool === 'read_file', '真实 read_file 执行');
  const rread = rconn.rpc.events.find((m) => m.method === 'tool.executed' && m.params.tool === 'read_file');
  assert(rread.params.ok === true, '真实 read_file ok');
  await rconn.rpc.waitFor((m) => m.method === 'session.ended', '真实 read 会话结束');

  // write_file 工具：补丁审查 → 接受 → 落盘
  rconn.rpc.resetEvents();
  await rconn.rpc.request('session.send', {
    sessionId: rsessionId,
    prompt: '请修改 sample.txt（write edit）',
    attachments: [{ kind: 'file', path: samplePath, name: 'sample.txt', content: fs.readFileSync(samplePath, 'utf8') }],
  });
  const rpatch = await rconn.rpc.waitFor((m) => m.method === 'file.patch.pending', '真实 file.patch.pending');
  await rconn.rpc.request('file.patch.respond', { sessionId: rsessionId, patchId: rpatch.params.patchId, accept: true });
  await rconn.rpc.waitFor(
    (m) => m.method === 'file.patch.result' && m.params.patchId === rpatch.params.patchId,
    '真实 file.patch.result'
  );
  assert(fs.readFileSync(samplePath, 'utf8').includes('REAL-DAEMON-WRITE'), '真实 Agent 补丁已落盘');
  await rconn.rpc.waitFor((m) => m.method === 'session.ended', '真实写会话结束');

  // bash_execute 工具：审批 → 真实 spawn 执行（验证命令沙箱 cwd 约束 + 环境清洗）
  console.log('[smoke] 真实 bash_execute（命令沙箱）…');
  rconn.rpc.resetEvents();
  await rconn.rpc.request('session.send', {
    sessionId: rsessionId,
    prompt: '请执行命令（bash）',
  });
  const rbashApproval = await rconn.rpc.waitFor((m) => m.method === 'approval.request', '真实 bash_execute 审批');
  assert(rbashApproval.params.tool === 'bash_execute', '真实 bash_execute 发起审批');
  await rconn.rpc.request('approval.respond', {
    sessionId: rsessionId,
    approvalId: rbashApproval.params.approvalId,
    approved: true,
  });
  const rbashDone = await rconn.rpc.waitFor(
    (m) => m.method === 'tool.executed' && m.params.tool === 'bash_execute',
    '真实 bash_execute 完成'
  );
  assert(rbashDone.params.ok === true, '真实 bash_execute 执行成功');
  assert(rbashDone.params.output.includes('SMOKE_BASH_OK'), '命令输出含 SMOKE_BASH_OK');
  assert(rbashDone.params.output.includes(path.basename(tmpDir)), '命令 cwd 被约束到工作区');
  await rconn.rpc.waitFor((m) => m.method === 'session.ended', '真实 bash 会话结束');

  // 验证轨迹已持久化到 .dsh/trajectory
  const trajFile = path.join(tmpDir, '.dsh', 'trajectory', rsessionId + '.jsonl');
  assert(fs.existsSync(trajFile) && fs.statSync(trajFile).size > 0, '轨迹已持久化（.dsh/trajectory/*.jsonl）');

  // C3：trajectory.list 协议回放（替代直接读 JSONL 文件）
  const trajList = await rconn.rpc.request('trajectory.list', { sessionId: rsessionId });
  assert(
    Array.isArray(trajList.records) && trajList.records.length > 0,
    'trajectory.list 返回语义化轨迹'
  );
  assert(
    trajList.records.some((r) => r.kind === 'tool'),
    'trajectory.list 含 tool 步骤（脱敏轨迹）'
  );

  // C2：daemon 日志落盘（tee stdout/stderr 到 .dsh/logs/daemon.log）
  const daemonLog = path.join(tmpDir, '.dsh', 'logs', 'daemon.log');
  assert(
    fs.existsSync(daemonLog) && fs.readFileSync(daemonLog, 'utf8').includes('DSH_DAEMON_PORT='),
    'daemon 日志已落盘（.dsh/logs/daemon.log）'
  );

  await rconn.rpc.request('shutdown', {});
  rconn.ws.close();

  // ---- 11. ping / shutdown（主 daemon）
  const pong = await conn2.rpc.request('ping', {});
  assert(pong && typeof pong.pong === 'number', 'ping/pong 正常');
  await conn2.rpc.request('shutdown', {});
  conn2.ws.close();

  // ---- 12. 清理
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
