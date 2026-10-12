'use strict';

/**
 * 端到端冒烟测试（不依赖 VSCode）。
 *
 * 覆盖（P0/P1）：
 *  - 安全握手：无 token / 带浏览器 Origin 均被拒绝
 *  - initialize 返回 sessionId 与能力声明（resume/fileRead）
 *  - 能力分级：allowedTools 为空时高危工具直接禁用（不发审批）
 *  - 连接级能力隔离（P0-4）：同 daemon 两连接各自声明 allowedTools，互不污染
 *  - 补丁流程：file.patch.pending -> 接受 -> file.patch.result -> 磁盘已变更
 *  - 审批流程：approval.request -> 批准 -> tool.executed
 *  - 多会话并发：同一连接两个会话并行（不再 -32009）
 *  - 取消流程：slow 中 session.cancel -> session.ended(canceled)
 *  - 断线续跑：断开后 session.resume 重放事件并返回状态
 *  - file.read：工作区内可读 / 越界返回 -32012
 *  - 脏文档一致性（P0-1）：未保存缓冲区优先读取（dirty=true）、覆盖层按连接隔离、
 *    补丁落盘改走编辑器（applyInEditor）/ 脏文档未走编辑器时拒绝落盘
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
  // 版本号单点化（回归守卫）：daemon 上报的版本必须等于构建它的 package.json 版本。
  // 真实事故：shared/version.ts 手写值停在 0.3.0 而 package.json 已是 0.8.0，状态行显示
  // 「已连接 daemon v0.3.0」——用户可见、差了 5 个小版本，而没有任何测试发现它。
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  assert(
    connDisabled.init.daemonVersion === pkgVersion,
    `daemon 上报版本与 package.json 一致（期望 ${pkgVersion}，实际 ${connDisabled.init.daemonVersion}）`
  );
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

  // ---- 3b. 连接级能力隔离（P0-4 回归）：同一 daemon 上两个连接声明不同 allowedTools，
  // 必须各按各的语义执行——旧实现里 capabilities 是服务实例级，后 initialize 的连接会
  // 把先者的白名单整体冲掉，这里正是那处污染的可执行反例。
  console.log('[smoke] 连接级能力隔离（P0-4）…');
  const connStrict = await openSession(port, {
    workspaceRoot: tmpDir,
    capabilities: { allowedTools: ['read_file'] }, // 白名单：不含 bash_execute
    client: { name: 'smoke-strict', version: '0.0.0' },
  });
  const connLoose = await openSession(port, {
    workspaceRoot: tmpDir,
    capabilities: { allowedTools: [] }, // 空数组 = 全部允许
    client: { name: 'smoke-loose', version: '0.0.0' },
  });

  // 宽松连接**后**握手，若能力是实例级，此时严格连接的白名单已被置空
  connStrict.rpc.resetEvents();
  await connStrict.rpc.request('session.send', {
    sessionId: connStrict.init.sessionId,
    prompt: '危险操作：bash rm -rf build（danger）',
  });
  const strictTool = await connStrict.rpc.waitFor(
    (m) => m.method === 'tool.executed' && m.params.tool === 'bash_execute',
    '严格连接 tool.executed'
  );
  assert(strictTool.params.ok === false, 'P0-4：严格连接仍被禁用（未被宽松连接冲掉白名单）');
  assert(
    !connStrict.rpc.events.some((m) => m.method === 'approval.request'),
    'P0-4：严格连接不发起审批'
  );
  await connStrict.rpc.waitFor((m) => m.method === 'session.ended', '严格连接流程结束');

  // 同一时刻，宽松连接的同类请求应正常进入审批（证明两者互不影响、各自生效）
  connLoose.rpc.resetEvents();
  await connLoose.rpc.request('session.send', {
    sessionId: connLoose.init.sessionId,
    prompt: '危险操作：bash rm -rf build（danger）',
  });
  const looseApproval = await connLoose.rpc.waitFor(
    (m) => m.method === 'approval.request',
    '宽松连接 approval.request'
  );
  assert(looseApproval.params.tool === 'bash_execute', 'P0-4：宽松连接按全允许语义发起审批');
  await connLoose.rpc.request('approval.respond', {
    sessionId: connLoose.init.sessionId,
    approvalId: looseApproval.params.approvalId,
    approved: false,
  });
  await connLoose.rpc.waitFor((m) => m.method === 'session.ended', '宽松连接流程结束');
  connStrict.ws.close();
  connLoose.ws.close();

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
  // P2-9：等级必须与文案自洽 —— 只改 risk 字段而不改 reason，用户看到的仍是旧话术
  assert(approval.params.reason.includes('高危'), 'P2-9：高危命令的审批说明写明"高危"');
  // 挂起项超时由 daemon 统一盖戳（TTL 可经 initialize.capabilities.approvalTtlMs 配置）
  const ttl = approval.params.expiresAt - Date.now();
  assert(ttl > 0 && ttl <= 61_000, `approval.request 应带 expiresAt（缺省 60s，实际 ${ttl}ms）`);

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

  // ---- 9b. 脏文档一致性（P0-1）：未保存缓冲区优先 + 写盘改走编辑器
  // 注意：主连接 ws 已在第 8 节模拟断线时关闭，本节一律用 conn2。
  console.log('[smoke] 脏文档一致性（P0-1）…');
  const diskBefore = fs.readFileSync(samplePath, 'utf8');
  const bufferContent = 'BUFFER-ONLY（未保存的编辑器内容）\n';

  // 覆盖层按连接隔离（与 P0-4 的能力声明同理）：另一个窗口推的内容不影响本连接读取
  const conn3 = await openSession(port, {
    workspaceRoot: tmpDir,
    client: { name: 'smoke-3', version: '0.0.0' },
  });
  await conn3.rpc.request('workspace.syncDirty', {
    files: [{ path: samplePath, content: 'OTHER-WINDOW\n' }],
  });
  const otherRead = await conn3.rpc.request('file.read', { path: samplePath });
  assert(otherRead.content === 'OTHER-WINDOW\n' && otherRead.dirty === true, 'P0-1：覆盖层对该连接自身生效');
  const isolatedRead = await conn2.rpc.request('file.read', { path: samplePath });
  assert(
    isolatedRead.content === diskBefore && isolatedRead.dirty !== true,
    'P0-1：覆盖层按连接隔离，不跨连接串味'
  );
  conn3.ws.close();

  // 本连接推入未保存内容 -> file.read 必须读到缓冲区版本，而不是过期磁盘版本
  await conn2.rpc.request('workspace.syncDirty', {
    files: [{ path: samplePath, content: bufferContent }],
  });
  const dirtyRead = await conn2.rpc.request('file.read', { path: samplePath });
  assert(dirtyRead.content === bufferContent, 'P0-1：file.read 读到编辑器未保存内容');
  assert(dirtyRead.dirty === true, 'P0-1：file.read 标记 dirty=true 供 UI/模型辨识');
  assert(fs.readFileSync(samplePath, 'utf8') === diskBefore, 'P0-1：读取覆盖层不会碰磁盘');

  const sendDirtyPrompt = () =>
    conn2.rpc.request('session.send', {
      sessionId,
      prompt: '请修改文件内容，把 TODO 替换为 DONE（write edit）',
      attachments: [
        {
          kind: 'file',
          uri: 'file://' + samplePath.replace(/\\/g, '/'),
          path: samplePath,
          language: 'plaintext',
          name: 'sample.txt',
          content: bufferContent,
        },
      ],
    });

  // accept + applyInEditor：客户端已写入编辑器缓冲区，daemon 不得再落盘
  conn2.rpc.resetEvents();
  await sendDirtyPrompt();
  const p2 = await conn2.rpc.waitFor((m) => m.method === 'file.patch.pending', 'file.patch.pending（脏文档）');
  assert(p2.params.oldContent === bufferContent, 'P0-1：补丁 old 侧取自缓冲区（与用户所见一致，而非磁盘）');
  await conn2.rpc.request('file.patch.respond', {
    sessionId,
    patchId: p2.params.patchId,
    accept: true,
    applyInEditor: true,
  });
  const r2 = await conn2.rpc.waitFor(
    (m) => m.method === 'file.patch.result' && m.params.patchId === p2.params.patchId,
    'file.patch.result（脏文档）'
  );
  assert(r2.params.accepted && r2.params.appliedInEditor === true, 'P0-1：改动交由编辑器落地');
  assert(r2.params.applied === false, 'P0-1：daemon 未写盘（避免与缓冲区内容分叉）');
  assert(fs.readFileSync(samplePath, 'utf8') === diskBefore, 'P0-1：磁盘内容保持原样');
  await conn2.rpc.waitFor((m) => m.method === 'session.ended', '脏文档流程结束', 10000);

  // accept 但未走编辑器：安全默认是拒绝落盘并给出原因，而不是静默覆盖未保存改动
  conn2.rpc.resetEvents();
  await sendDirtyPrompt();
  const p3 = await conn2.rpc.waitFor(
    (m) => m.method === 'file.patch.pending',
    'file.patch.pending（脏文档未走编辑器）'
  );
  await conn2.rpc.request('file.patch.respond', { sessionId, patchId: p3.params.patchId, accept: true });
  const r3 = await conn2.rpc.waitFor(
    (m) => m.method === 'file.patch.result' && m.params.patchId === p3.params.patchId,
    'file.patch.result（脏文档未走编辑器）'
  );
  assert(r3.params.applied === false, 'P0-1：脏文档未走编辑器时拒绝落盘');
  assert(typeof r3.params.error === 'string' && r3.params.error.includes('未保存'), 'P0-1：拒绝时给出可读原因');
  assert(fs.readFileSync(samplePath, 'utf8') === diskBefore, 'P0-1：未保存改动没有被覆盖');
  await conn2.rpc.waitFor((m) => m.method === 'session.ended', '脏文档拒绝流程结束', 10000);

  // 清空覆盖层（用户保存后）-> 读取回落磁盘，普通落盘通路恢复
  await conn2.rpc.request('workspace.syncDirty', { files: [] });
  const cleanRead = await conn2.rpc.request('file.read', { path: samplePath });
  assert(cleanRead.content === diskBefore && cleanRead.dirty !== true, 'P0-1：清空覆盖层后回落磁盘');

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
  // P2-9：这里跑的是 `echo ... && pwd|cd` —— 纯只读，必须判 low。
  // 与上面 mock 段的 high 一起，证明分级**真的在按命令内容变化**，不是换个常量名硬编码。
  assert(
    rbashApproval.params.risk === 'low',
    `P2-9：只读命令判 low（实际 ${rbashApproval.params.risk}）`
  );
  assert(rbashApproval.params.reason.includes('只读'), 'P2-9：只读命令的审批说明写明"只读"');
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

  // ---- 10b. P2-6 会话级回滚：把本次会话改过的文件还原到会话开始前
  console.log('[smoke] 会话级回滚…');
  const beforeRollback = fs.readFileSync(samplePath, 'utf8');
  assert(beforeRollback.includes('REAL-DAEMON-WRITE'), '回滚前：文件确实被本次会话改过');

  const rb = await rconn.rpc.request('session.rollback', { sessionId: rsessionId });
  assert(rb.total >= 1, `回滚报告覆盖了 ${rb.total} 个被改动的文件`);
  assert(
    rb.restored.some((p) => path.resolve(p).toLowerCase() === path.resolve(samplePath).toLowerCase()),
    '回滚报告把 sample.txt 列为已还原'
  );
  const afterRollback = fs.readFileSync(samplePath, 'utf8');
  assert(
    afterRollback.includes('TODO') && !afterRollback.includes('REAL-DAEMON-WRITE'),
    '回滚后：磁盘内容还原为本次会话开始前'
  );
  assert(rb.skippedDirty.length === 0 && rb.failed.length === 0, '回滚无跳过、无失败');

  // ---- 10c. P2-6 加固：文件在会话之后**又被改过**（模拟用户手工编辑并保存）-> 跳过而不是覆盖
  console.log('[smoke] 回滚 × 内容已变的守卫…');
  rconn.rpc.resetEvents();
  await rconn.rpc.request('session.send', {
    sessionId: rsessionId,
    prompt: '请修改 sample.txt（write edit）',
    attachments: [
      { kind: 'file', path: samplePath, name: 'sample.txt', content: fs.readFileSync(samplePath, 'utf8') },
    ],
  });
  const rpatch2 = await rconn.rpc.waitFor((m) => m.method === 'file.patch.pending', '第二次真实补丁');
  await rconn.rpc.request('file.patch.respond', {
    sessionId: rsessionId,
    patchId: rpatch2.params.patchId,
    accept: true,
  });
  await rconn.rpc.waitFor(
    (m) => m.method === 'file.patch.result' && m.params.patchId === rpatch2.params.patchId,
    '第二次真实补丁结果'
  );
  await rconn.rpc.waitFor((m) => m.method === 'session.ended', '第二次真实写会话结束');

  // 会话之后手工改一遍并"保存" —— 文件因此**不脏**，脏文档守卫拦不住它，只有写入指纹能拦
  const userSaved = fs.readFileSync(samplePath, 'utf8') + '\n// USER-SAVED-AFTER-SESSION\n';
  fs.writeFileSync(samplePath, userSaved, 'utf8');
  const rb2 = await rconn.rpc.request('session.rollback', { sessionId: rsessionId });
  assert(
    rb2.changedAfter.some(
      (c) => path.resolve(c.path).toLowerCase() === path.resolve(samplePath).toLowerCase()
    ),
    '会话之后被改过的文件被列入 changedAfter（而不是被静默覆盖）'
  );
  assert(rb2.restored.length === 0, '内容已变时不做还原');
  assert(fs.readFileSync(samplePath, 'utf8') === userSaved, '用户会话之后的改动被保住');

  // 影子快照落在 .dsh/snapshots/<会话>/（首写优先，只增不改）
  const snapDir = path.join(tmpDir, '.dsh', 'snapshots', rsessionId);
  assert(
    fs.existsSync(path.join(snapDir, 'index.json')) &&
      fs.readdirSync(snapDir).some((f) => f.endsWith('.snap')),
    '影子快照已落盘（.dsh/snapshots/<会话>/index.json + *.snap）'
  );

  // ---- 10d. P2-4 图片输入：daemon 侧复验 + 图片**真的**进了请求体
  console.log('[smoke] 图片附件…');
  assert(
    rconn.init.capabilities.image === true,
    '能力声明包含 image（第三方客户端据此判断"发图给你收不收"）'
  );
  // 8 字节 PNG 头（89 50 4E 47 0D 0A 1A 0A）的 base64 —— 形态合法，足够走完校验。
  const PNG_B64 = 'iVBORw0KGgo=';

  rconn.rpc.resetEvents();
  await rconn.rpc.request('session.send', {
    sessionId: rsessionId,
    prompt: '这张截图里有几处问题？',
    attachments: [
      { kind: 'image', mimeType: 'image/png', dataBase64: PNG_B64, name: 'shot.png', clientId: 'smoke-img-1' },
    ],
  });
  await rconn.rpc.waitFor((m) => m.method === 'session.ended', '图片会话结束');
  assert(
    !rconn.rpc.events.some((m) => m.method === 'error'),
    '合法图片不报错（校验放行）'
  );
  assert(
    rconn.rpc.events.some((m) => m.method === 'session.started'),
    '带图会话正常开始（图片不再需要额外的批准步骤）'
  );
  const imgDeltas = rconn.rpc.events
    .filter((m) => m.method === 'message.delta')
    .map((m) => m.params.delta)
    .join('');
  // 假模型把请求体里真实的 image 内容块数回显出来：冒烟只看得到 SSE 正文，看不见请求体，
  // 靠 `[图片 N]` 标记只能证明文本到了。这两条一起才算"图片输入跑通"。
  assert(
    imgDeltas.includes('已收到 1 张图片'),
    '图片以独立内容块到达模型（假模型回显请求体的 image 块数）'
  );
  assert(
    imgDeltas.includes('[图片 1：shot.png]'),
    '文本侧保留 [图片 N] 位置标记（模型知道"第 1 张"指哪一张）'
  );
  assert(!imgDeltas.includes(PNG_B64), 'base64 不折进文本（否则每轮都要重读一份噪声）');
  assert(
    rconn.rpc.events.find((m) => m.method === 'session.ended').params.reason === 'completed',
    '带图会话以 reason=completed 收尾'
  );

  // 非法格式：**整条消息**拒绝，而不是丢掉那张继续发
  rconn.rpc.resetEvents();
  await rconn.rpc.request('session.send', {
    sessionId: rsessionId,
    prompt: '看图',
    attachments: [{ kind: 'image', mimeType: 'image/svg+xml', dataBase64: PNG_B64 }],
  });
  await rconn.rpc.waitFor((m) => m.method === 'session.ended', '图片被拒后的会话结束');
  const imgErr = rconn.rpc.events.find((m) => m.method === 'error');
  assert(!!imgErr, '非法图片格式 -> 明确报错（不静默丢弃那张）');
  assert(
    imgErr.params.code === -32602,
    `图片被拒的错误码为 InvalidParams（实际 ${imgErr && imgErr.params.code}）`
  );
  assert(
    String(imgErr.params.message).includes('图片附件被拒绝'),
    '错误文案点明是图片附件被拒（用户知道去改什么）'
  );
  assert(
    !rconn.rpc.events.some((m) => m.method === 'session.started'),
    '被拒时不发 session.started：模型一次都没被调用（拿不到"对着不存在的图作答"的机会）'
  );
  assert(
    rconn.rpc.events.find((m) => m.method === 'session.ended').params.reason === 'error',
    '被拒会话以 reason=error 收尾（不谎报 completed）'
  );

  // 超张数：同样是整条拒绝，且文案说得出上限
  rconn.rpc.resetEvents();
  await rconn.rpc.request('session.send', {
    sessionId: rsessionId,
    prompt: '看图',
    attachments: [0, 1, 2, 3, 4].map((i) => ({
      kind: 'image',
      mimeType: 'image/png',
      dataBase64: PNG_B64,
      clientId: 'smoke-many-' + i,
    })),
  });
  await rconn.rpc.waitFor((m) => m.method === 'session.ended', '超张数会话结束');
  const manyErr = rconn.rpc.events.find((m) => m.method === 'error');
  assert(!!manyErr && String(manyErr.params.message).includes('最多'), '超过张数上限 -> 拒绝并说明上限');
  assert(
    !rconn.rpc.events.some((m) => m.method === 'session.started'),
    '超张数时模型同样没被调用'
  );

  // 只发图不写字：prompt 允许为空串（粘一张截图直接回车是最常见的用法）
  rconn.rpc.resetEvents();
  await rconn.rpc.request('session.send', {
    sessionId: rsessionId,
    prompt: '',
    attachments: [{ kind: 'image', mimeType: 'image/png', dataBase64: PNG_B64, clientId: 'smoke-img-only' }],
  });
  await rconn.rpc.waitFor((m) => m.method === 'session.ended', '只发图的会话结束');
  const onlyImgDeltas = rconn.rpc.events
    .filter((m) => m.method === 'message.delta')
    .map((m) => m.params.delta)
    .join('');
  assert(onlyImgDeltas.includes('已收到 1 张图片'), '空 prompt + 有图片：会话照常成立（只发图不写字）');

  // 门禁：运行中的会话拒绝回滚（否则会出现"刚还回去又被改掉"的中间状态）
  const busySession = (await conn2.rpc.request('session.create', {})).sessionId;
  conn2.rpc.resetEvents();
  await conn2.rpc.request('session.send', { sessionId: busySession, prompt: 'slow 输出测试（slow）' });
  await conn2.rpc.waitFor((m) => m.method === 'message.delta', '慢会话开始输出');
  let busyCode;
  try {
    await conn2.rpc.request('session.rollback', { sessionId: busySession });
  } catch (err) {
    busyCode = err.code;
  }
  assert(busyCode === -32009, `运行中回滚被拒（期望 -32009，实际 ${busyCode}）`);
  await conn2.rpc.request('session.cancel', { sessionId: busySession });
  await conn2.rpc.waitFor((m) => m.method === 'session.ended', '慢会话取消结束', 15000);

  // ---- 10d. P2-7 Plan 模式：先出计划、批准后才执行
  console.log('[smoke] Plan 模式…');
  const planFile = path.join(tmpDir, 'plan-target.txt');
  const planOriginal = 'PLAN-ORIGINAL\n';
  const sendPlan = (prompt) =>
    rconn.rpc.request('session.send', {
      sessionId: rsessionId,
      prompt,
      attachments: [
        { kind: 'file', path: planFile, name: 'plan-target.txt', content: fs.readFileSync(planFile, 'utf8') },
      ],
      planMode: true,
    });

  fs.writeFileSync(planFile, planOriginal, 'utf8');
  rconn.rpc.resetEvents();
  await sendPlan('请修改 plan-target.txt（write edit）');
  const planReq = await rconn.rpc.waitFor((m) => m.method === 'plan.request', 'plan.request');
  assert(typeof planReq.params.plan === 'string' && planReq.params.plan.length > 0, 'plan.request 带回了计划正文');
  assert(typeof planReq.params.expiresAt === 'number', 'plan.request 由 daemon 盖上了过期时间戳');
  // 计划模式的整个承诺：批准前什么都不改
  assert(
    !rconn.rpc.events.some((m) => m.method === 'file.patch.pending'),
    '计划阶段没有任何补丁请求（方案未批不做改动）'
  );

  // 拒绝一次：应当一个文件都不碰，且按"已取消"收尾
  await rconn.rpc.request('plan.respond', {
    sessionId: rsessionId,
    planId: planReq.params.planId,
    approved: false,
  });
  let dupPlanCode;
  try {
    await rconn.rpc.request('plan.respond', {
      sessionId: rsessionId,
      planId: planReq.params.planId,
      approved: true,
    });
  } catch (err) {
    dupPlanCode = err.code;
  }
  assert(dupPlanCode === -32013, `重复 plan.respond 被拒（期望 -32013，实际 ${dupPlanCode}）`);
  const planRejectedEnd = await rconn.rpc.waitFor((m) => m.method === 'session.ended', '计划被拒后的会话结束');
  assert(planRejectedEnd.params.reason === 'canceled', '计划被拒 -> reason=canceled（不谎报"已完成"）');
  assert(fs.readFileSync(planFile, 'utf8') === planOriginal, '计划被拒 -> 磁盘原样未动');

  // 批准一次：走完整执行链路（计划只是闸门，不是终点）
  rconn.rpc.resetEvents();
  await sendPlan('请修改 plan-target.txt（write edit）');
  const planReq2 = await rconn.rpc.waitFor((m) => m.method === 'plan.request', '第二次 plan.request');
  await rconn.rpc.request('plan.respond', {
    sessionId: rsessionId,
    planId: planReq2.params.planId,
    approved: true,
    note: '只改这一行',
  });
  const planPatch = await rconn.rpc.waitFor((m) => m.method === 'file.patch.pending', '批准后的真实补丁');
  await rconn.rpc.request('file.patch.respond', {
    sessionId: rsessionId,
    patchId: planPatch.params.patchId,
    accept: true,
  });
  await rconn.rpc.waitFor(
    (m) => m.method === 'file.patch.result' && m.params.patchId === planPatch.params.patchId,
    '批准后的补丁结果'
  );
  assert(fs.readFileSync(planFile, 'utf8').includes('REAL-DAEMON-WRITE'), '计划批准后改动落盘');
  const planApprovedEnd = await rconn.rpc.waitFor((m) => m.method === 'session.ended', '计划批准的会话结束');
  assert(planApprovedEnd.params.reason === 'completed', '计划批准 -> reason=completed');
  assert(
    rconn.rpc.events.some((m) => m.method === 'trajectory.record' && m.params.kind === 'plan'),
    '计划审批已进入执行迹线（kind=plan）'
  );

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
  // P2-8：结构化字段必须经得起落盘 + 回读（否则"可聚合"只是内存里的假象）
  assert(
    trajList.records.some(
      (r) => r.kind === 'tool' && r.tool === 'read_file' && typeof r.durationMs === 'number' && r.ok === true
    ),
    'P2-8：tool 轨迹带回结构化字段（tool / ok / durationMs）'
  );
  assert(
    trajList.records.some((r) => r.tokens && r.tokens.estimated === true && typeof r.tokens.total === 'number'),
    'P2-8：轨迹含 token 估算记录（estimated=true，不当账单用）'
  );
  assert(
    trajList.records.some((r) => r.errorKind === 'approval-denied'),
    'P2-8：审批被拒（回滚/拒绝路径）按 approval-denied 分类'
  );

  // C2：daemon 日志落盘（tee stdout/stderr 到 .dsh/logs/daemon.log）
  const daemonLog = path.join(tmpDir, '.dsh', 'logs', 'daemon.log');
  assert(
    fs.existsSync(daemonLog) && fs.readFileSync(daemonLog, 'utf8').includes('DSH_DAEMON_PORT='),
    'daemon 日志已落盘（.dsh/logs/daemon.log）'
  );

  // P0-3：`.dsh/` 必须自守 —— daemon 进程自己写下忽略规则，否则用户的 git status
  // 会暴露会话全文 / 工具轨迹 / 日志，一个 git add -A 就带进仓库
  const dshIgnore = path.join(tmpDir, '.dsh', '.gitignore');
  assert(
    fs.existsSync(dshIgnore) && fs.readFileSync(dshIgnore, 'utf8').split(/\r?\n/).includes('*'),
    '.dsh/ 自守忽略已生成（.dsh/.gitignore 含 *）'
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
