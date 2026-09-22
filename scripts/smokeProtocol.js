'use strict';

/**
 * 协议「第二实现」冒烟：用**另一个语言实现的 daemon** 驱动同一份协议。
 *
 * 为什么需要它：PROTOCOL.md 承诺"前端可换、后端可换"，但在本脚本之前，这个承诺
 * **只有文档、没有第二实现来证明**——所有测试跑的都是仓库自带的 Node daemon，
 * 协议里若有实现细节泄露，测试根本发现不了。
 *
 * 这里拉起 `examples/python-daemon/dsh_daemon.py`（Python 3 + 仅标准库，
 * 连 WebSocket 服务端都是手写的 RFC 6455 子集），用同一个 `ws` 客户端按协议
 * 走完 initialize -> session.create -> session.send（含 read_file 工具）-> shutdown，
 * 并顺带验证安全语义（错 token / 带 Origin 一律拒绝）。
 *
 * 覆盖：
 *  - 端口上报约定 `DSH_DAEMON_PORT=<n>`
 *  - 握手鉴权：Bearer 错 token 拒绝、带浏览器 Origin 拒绝
 *  - initialize 结果形状（protocolVersion / capabilities / sessionId）
 *  - session.send 的事件时序：session.started -> tool.started -> tool.executed
 *    -> message.delta* -> message.done -> session.ended
 *  - read_file 路径护栏：工作区内 ok，越界 ok:false
 *  - shutdown 能真正结束进程
 *
 * 运行：node scripts/smokeProtocol.js [--require]
 *   --require：找不到 Python 3 时判失败（CI 用；本地默认优雅跳过，退出 0）
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const DAEMON_SCRIPT = path.join(ROOT, 'examples', 'python-daemon', 'dsh_daemon.py');
const REQUIRE_PYTHON = process.argv.includes('--require');
const TOKEN = 'py-smoke-' + Math.random().toString(36).slice(2);

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error('  FAIL: ' + msg);
  } else {
    console.log('  ok:   ' + msg);
  }
}
function section(title) {
  console.log('\n== ' + title + ' ==');
}

/** 找一个可用的 Python 3（DSH_PYTHON 可覆盖，支持带参数如 "py -3"）。 */
function findPython() {
  const candidates = [];
  if (process.env.DSH_PYTHON) candidates.push(process.env.DSH_PYTHON.split(/\s+/));
  candidates.push(['python3'], ['python'], ['py', '-3']);
  for (const c of candidates) {
    const r = spawnSync(c[0], [...c.slice(1), '-c', 'import sys;print(sys.version_info[0])'], {
      encoding: 'utf8',
    });
    if (r.status === 0 && String(r.stdout || '').trim() === '3') {
      return { exe: c[0], args: c.slice(1) };
    }
  }
  return null;
}

function startDaemon(python, workspace) {
  const child = spawn(python.exe, [...python.args, DAEMON_SCRIPT, '--port', '0', '--workspace', workspace], {
    env: { ...process.env, DSH_DAEMON_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('等待 DSH_DAEMON_PORT 超时（10s）：' + out + err));
    }, 10_000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/DSH_DAEMON_PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]) });
      }
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Python daemon 提前退出（code=${code}）：${err || out}`));
    });
    child.on('error', reject);
  });
}

function connect(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('connect timeout'));
    }, 8000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** 期望握手被拒（鉴权失败 / 带 Origin）——成功连上即为失败。 */
function expectHandshakeFailure(url, headers, label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    let errored = false;
    ws.on('error', () => {
      errored = true;
      assert(true, label);
      resolve();
    });
    ws.on('close', () => {
      if (!errored) assert(true, label);
      resolve();
    });
    ws.on('open', () => {
      assert(false, label + '（意外连接成功）');
      ws.close();
      resolve();
    });
    setTimeout(() => resolve(), 8000);
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
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message + ' (code ' + msg.error.code + ')');
        err.code = msg.error.code;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    events.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  return {
    events,
    request(method, params) {
      return new Promise((resolve, reject) => {
        const rid = ++id;
        pending.set(rid, { resolve, reject });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }));
      });
    },
    /**
     * 从 startIndex 之后等待事件。
     * 必须带起点：会话是多轮的，`session.ended` 在上一轮就已存在于 events 里，
     * 不带起点会立刻匹配到旧事件，第二轮的断言就全落在空数组上（假绿）。
     */
    waitFor(pred, label, timeoutMs, startIndex) {
      return new Promise((resolve, reject) => {
        const minIndex = startIndex || 0;
        const found = events.slice(minIndex).find(pred);
        if (found) return resolve(found);
        const entry = { pred, resolve, minIndex };
        waiters.push(entry);
        setTimeout(() => {
          const i = waiters.indexOf(entry);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('等待事件超时: ' + label));
        }, timeoutMs || 10_000);
      });
    },
  };
}

/** 跑完一轮 session.send，返回该轮收到的全部事件。 */
async function runTurn(rpc, sessionId, prompt) {
  const from = rpc.events.length;
  await rpc.request('session.send', { sessionId, prompt });
  await rpc.waitFor((m) => m.method === 'session.ended', 'session.ended', 10_000, from);
  return rpc.events.slice(from);
}

async function main() {
  if (!fs.existsSync(DAEMON_SCRIPT)) {
    console.error('找不到 ' + DAEMON_SCRIPT);
    process.exit(1);
  }

  const python = findPython();
  if (!python) {
    const msg = '未找到 Python 3，跳过协议「第二实现」冒烟。';
    if (REQUIRE_PYTHON) {
      console.error('FAIL: ' + msg + '（--require 指定必须运行）');
      process.exit(1);
    }
    console.log('SKIP: ' + msg + '（设置 DSH_PYTHON 可指定解释器）');
    process.exit(0);
  }
  console.log(`Python: ${python.exe} ${python.args.join(' ')}`);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-py-ref-'));
  fs.writeFileSync(path.join(workspace, 'hello.txt'), 'hello from the python reference daemon\n', 'utf8');
  const outside = path.join(os.tmpdir(), 'dsh-py-ref-outside.txt');
  fs.writeFileSync(outside, '不应被读到', 'utf8');

  let daemon;
  try {
    section('0. 启动与端口上报');
    daemon = await startDaemon(python, workspace);
    const url = 'ws://127.0.0.1:' + daemon.port;
    assert(daemon.port > 0, '按 DSH_DAEMON_PORT 约定上报了端口');

    section('1. 安全握手（协议 §1）');
    await expectHandshakeFailure(url, { Authorization: 'Bearer wrong-token' }, '错误 token 被拒绝');
    await expectHandshakeFailure(
      url,
      { Authorization: 'Bearer ' + TOKEN, Origin: 'https://evil.example' },
      '带浏览器 Origin 的连接被拒绝（防 CSWSH）'
    );

    section('2. initialize / session.create');
    const ws = await connect(url, { Authorization: 'Bearer ' + TOKEN });
    const rpc = makeRpc(ws);
    const init = await rpc.request('initialize', {
      workspaceRoot: workspace,
      client: { name: 'smoke-protocol', version: '1.0.0' },
    });
    assert(init.protocolVersion === '1.0', '报出 protocolVersion=1.0');
    assert(typeof init.sessionId === 'string' && init.sessionId.startsWith('sess_'), '分配了默认会话 id');
    assert(init.capabilities && init.capabilities.streaming === true, 'capabilities 声明 streaming');
    assert(typeof init.daemonVersion === 'string' && init.daemonVersion.length > 0, '报出 daemonVersion');
    assert(init.agent === 'python-reference', '明确标注这是 Python 参考实现（非内置 Node daemon）');

    const created = await rpc.request('session.create', {});
    assert(created.sessionId !== init.sessionId, 'session.create 产出独立的新会话');

    section('3. session.send：事件时序 + read_file 工具');
    const events = await runTurn(rpc, created.sessionId, '请读取 hello.txt 的内容');
    const by = (m) => events.filter((e) => e.method === m);
    assert(by('session.started').length === 1, '发出 session.started');
    assert(by('tool.started').some((e) => e.params.tool === 'read_file'), 'tool.started(read_file)');
    const executed = by('tool.executed')[0];
    assert(executed && executed.params.ok === true, 'tool.executed 报告执行成功');
    assert(
      executed && executed.params.output.includes('hello from the python reference daemon'),
      '工具返回了文件真实内容'
    );
    const text = by('message.delta').map((e) => e.params.delta).join('');
    assert(by('message.delta').length > 1, '回答以多个增量流式下发');
    assert(text.includes('hello from the python reference daemon'), '流式内容包含文件内容');
    assert(by('message.done').length === 1, '发出 message.done 收尾回答流');
    assert(
      by('session.ended')[0].params.reason === 'completed',
      'session.ended(reason=completed)'
    );
    assert(by('trajectory.record').length >= 2, '轨迹以 trajectory.record 事件流投影');
    assert(
      events.every((e) => e.params && e.params.sessionId === created.sessionId),
      '所有事件都带正确 sessionId'
    );

    section('4. read_file 路径护栏（协议 §6b）');
    const guardEvents = await runTurn(rpc, created.sessionId, '请读取 ' + outside + ' 的内容');
    const guardExec = guardEvents.find((e) => e.method === 'tool.executed');
    assert(guardExec && guardExec.params.ok === false, '工作区外路径被拒绝（ok:false）');

    section('5. 未知方法与 ping');
    let notFound = null;
    try {
      await rpc.request('no.such.method', {});
    } catch (e) {
      notFound = e;
    }
    assert(notFound && notFound.code === -32601, '未知方法返回 -32601 MethodNotFound');
    const pong = await rpc.request('ping', {});
    assert(pong.pong === true, 'ping 返回 pong');

    section('6. shutdown');
    const bye = await rpc.request('shutdown', {});
    assert(bye.bye === true, 'shutdown 返回 bye');
    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 5000);
      daemon.child.on('exit', () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    assert(exited, 'shutdown 后进程真正退出');
    ws.terminate();
  } finally {
    if (daemon && !daemon.child.killed) {
      try {
        daemon.child.kill();
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { force: true });
    } catch {
      /* ignore */
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(`协议「第二实现」冒烟失败：${failures} 项`);
    process.exit(1);
  }
  console.log('协议「第二实现」冒烟通过：Python daemon 与协议契约完全兼容 ✅');
}

main().catch((err) => {
  console.error('冒烟脚本异常：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
