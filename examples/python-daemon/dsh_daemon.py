#!/usr/bin/env python3
"""dsh Agent Daemon 的**第二实现**（Python 3 + 仅标准库）。

存在的唯一理由：证明 dsh 协议是**可插拔契约**，而不是"只有内置那个 Node 参考 daemon 能用"。
它刻意换了一门语言、不依赖任何第三方包（连 WebSocket 服务端都是手写的 RFC 6455 子集），
因此如果它能被 VSCode 扩展侧正常驱动，就说明协议本身没有泄露实现细节。

实现范围（刻意最小，只覆盖"能跑通一轮对话"的最小闭环）：
  initialize / session.create / session.send / session.cancel / ping / shutdown
外加一个 `read_file` 工具（走通用的 tool.started / tool.executed 事件时序）。

**不实现**（真实内核该做的事，本文件不做）：真实模型接入、补丁 Diff 审查、审批挂起、
断线续跑、轨迹持久化、多会话并发。这些都不影响"协议可插拔"的证明。

用法：
  DSH_DAEMON_TOKEN=<token> python3 dsh_daemon.py \\
      [--port 0] [--port-file <path>] [--workspace <path>] [--name py-ref]

端口就绪后向 stdout 打印一行 `DSH_DAEMON_PORT=<port>`（与协议 §1 一致）。
"""

import base64
import hashlib
import json
import os
import re
import socket
import struct
import sys
import threading
import time
import uuid

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
PROTOCOL_VERSION = "1.0"
DAEMON_VERSION = "1.1.0-py-ref"

OP_TEXT, OP_CLOSE, OP_PING, OP_PONG, OP_CONT = 0x1, 0x8, 0x9, 0xA, 0x0

# 从 prompt 里挑一个像文件路径的 token（参考实现只做这个"理解"，不接模型）
PATH_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_./\\-]*\.[A-Za-z0-9]{1,8}")


# ---------------------------------------------------------------------------
# WebSocket：RFC 6455 的最小子集（文本帧 + 掩码 + ping/pong/close）
# ---------------------------------------------------------------------------

def ws_accept_key(client_key: str) -> str:
    digest = hashlib.sha1((client_key + WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def _send_frame(sock: socket.socket, opcode: int, payload: bytes) -> None:
    """服务端 -> 客户端帧（服务端帧不加掩码）。"""
    header = bytes([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header += bytes([n])
    elif n < (1 << 16):
        header += bytes([126]) + struct.pack("!H", n)
    else:
        header += bytes([127]) + struct.pack("!Q", n)
    sock.sendall(header + payload)


def send_json(sock: socket.socket, obj: dict) -> None:
    _send_frame(sock, OP_TEXT, json.dumps(obj, ensure_ascii=False).encode("utf-8"))


def send_event(sock: socket.socket, lock: threading.Lock, method: str, params: dict) -> None:
    with lock:
        send_json(sock, {"jsonrpc": "2.0", "method": method, "params": params})


def send_result(sock, lock, rid, result) -> None:
    with lock:
        send_json(sock, {"jsonrpc": "2.0", "id": rid, "result": result})


def send_error(sock, lock, rid, code, message) -> None:
    with lock:
        send_json(sock, {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}})


def _recv_exactly(sock: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("连接已关闭")
        buf.extend(chunk)
    return bytes(buf)


def recv_frame(sock: socket.socket):
    """读一帧，返回 (opcode, payload)；连接结束返回 None。"""
    head = _recv_exactly(sock, 2)
    fin = bool(head[0] & 0x80)
    opcode = head[0] & 0x0F
    masked = bool(head[1] & 0x80)
    length = head[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", _recv_exactly(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _recv_exactly(sock, 8))[0]
    mask = _recv_exactly(sock, 4) if masked else b""
    data = _recv_exactly(sock, length) if length else b""
    if masked:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return fin, opcode, data


def read_http_request(sock: socket.socket) -> str:
    raw = bytearray()
    while b"\r\n\r\n" not in raw:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("握手阶段连接关闭")
        raw.extend(chunk)
    return raw.decode("latin-1")


def parse_headers(req: str) -> dict:
    headers = {}
    for line in req.split("\r\n")[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return headers


# ---------------------------------------------------------------------------
# 协议实现
# ---------------------------------------------------------------------------

class Daemon:
    def __init__(self, token: str, workspace: str, name: str):
        self.token = token
        self.workspace = os.path.realpath(workspace)
        self.name = name
        self.sessions = {}

    # -- 工具：read_file（带工作区路径护栏，语义对齐协议 §6b） ---------------

    def _resolve(self, target: str):
        """返回工作区内的绝对路径；越界/不存在返回 None（协议 -32012 的简化版）。"""
        if not target:
            return None
        cand = target if os.path.isabs(target) else os.path.join(self.workspace, target)
        real = os.path.realpath(cand)
        if real != self.workspace and not real.startswith(self.workspace + os.sep):
            return None
        return real

    def read_file(self, path: str):
        resolved = self._resolve(path)
        if resolved is None:
            return False, "路径越界或在沙箱外（仅允许工作区内）"
        try:
            with open(resolved, "r", encoding="utf-8", errors="replace") as fh:
                return True, fh.read()
        except OSError as exc:
            return False, f"读取失败: {exc}"

    # -- session.send 的"Agent 循环"（无模型，纯确定性，方便冒烟断言） ------

    def run_turn(self, sock, lock, sid: str, prompt: str) -> None:
        ev = lambda m, p: send_event(sock, lock, m, {"sessionId": sid, **p})  # noqa: E731
        trace = 0

        def record(kind, detail):
            nonlocal trace
            trace += 1
            ev("trajectory.record", {"step": trace, "kind": kind, "detail": detail, "ts": int(time.time() * 1000)})

        ev("session.started", {"title": prompt[:40]})
        record("system", "收到 prompt")

        match = PATH_RE.search(prompt)
        if not match:
            ev("message.delta", {"delta": "（Python 参考 daemon）没有在 prompt 里找到文件路径。"})
            ev("message.done", {})
            ev("session.ended", {"reason": "completed"})
            return

        target = match.group(0)
        started = time.time()
        ev("tool.started", {"tool": "read_file", "input": {"path": target}})
        ok, output = self.read_file(target)
        ev("tool.executed", {
            "tool": "read_file", "ok": ok, "output": output,
            "durationMs": int((time.time() - started) * 1000),
        })
        record("tool", f"read_file({target}) -> {'ok' if ok else 'failed'}")

        if ok:
            head = f"（Python 参考 daemon）{target} 共 {len(output)} 字符，前几行：\n\n"
        else:
            head = f"（Python 参考 daemon）{target}: {output}\n"
        for piece in (head, output[:600]):
            for i in range(0, len(piece), 120):  # 分块下发，验证流式增量语义
                ev("message.delta", {"delta": piece[i:i + 120]})
                time.sleep(0.005)

        ev("message.done", {})
        record("message", "回答完成")
        ev("session.ended", {"reason": "completed"})

    # -- 请求分发 ---------------------------------------------------------

    def handle(self, sock: socket.socket, lock: threading.Lock, msg: dict) -> bool:
        """处理一条 JSON-RPC 消息；返回 False 表示要求进程退出。"""
        rid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}

        if method == "initialize":
            if not params.get("workspaceRoot"):
                send_error(sock, lock, rid, -32602, "initialize 需要 workspaceRoot")
                return True
            sid = "sess_" + uuid.uuid4().hex[:16]
            self.sessions[sid] = {"sid": sid, "turn": 0}
            send_result(sock, lock, rid, {
                "daemonVersion": DAEMON_VERSION,
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {
                    "streaming": True, "approvals": False, "filePatches": False,
                    "sessions": True, "trajectory": True, "resume": False, "fileRead": True,
                },
                "sessionId": sid,
                "agent": "python-reference",
            })
            print(f"[{self.name}] initialize ok, session={sid}", flush=True)
            return True

        if method == "session.create":
            sid = "sess_" + uuid.uuid4().hex[:16]
            self.sessions[sid] = {"sid": sid, "turn": 0}
            send_result(sock, lock, rid, {"sessionId": sid})
            return True

        if method == "session.send":
            sid = params.get("sessionId") or ""
            prompt = params.get("prompt")
            if not isinstance(prompt, str):
                send_error(sock, lock, rid, -32602, "session.send 需要 prompt")
                return True
            if sid not in self.sessions:
                send_error(sock, lock, rid, -32013, f"session 不存在: {sid}")
                return True
            send_result(sock, lock, rid, {"sessionId": sid, "accepted": True})
            self.sessions[sid]["turn"] += 1
            # 参考实现按会话串行：事件同步发完再返回（真实 daemon 应异步 + 可取消）
            self.run_turn(sock, lock, sid, prompt)
            return True

        if method == "session.cancel":
            send_result(sock, lock, rid, {"canceled": False})  # 本实现会话是同步的
            return True

        if method == "ping":
            send_result(sock, lock, rid, {"pong": True})
            return True

        if method == "shutdown":
            send_result(sock, lock, rid, {"bye": True})
            return False

        send_error(sock, lock, rid, -32601, f"MethodNotFound: {method}")
        return True

    # -- 连接 -------------------------------------------------------------

    def serve_connection(self, sock: socket.socket) -> bool:
        """处理一条连接；返回 False 表示收到 shutdown（调用方负责结束进程）。"""
        lock = threading.Lock()
        try:
            req = read_http_request(sock)
            headers = parse_headers(req)
            # 安全：拒绝带浏览器 Origin 的连接（防 CSWSH），并校验 Bearer token
            if headers.get("origin"):
                sock.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                return True
            if headers.get("authorization") != f"Bearer {self.token}":
                sock.sendall(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
                return True
            key = headers.get("sec-websocket-key")
            if not key:
                sock.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
                return True
            sock.sendall((
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {ws_accept_key(key)}\r\n\r\n"
            ).encode("ascii"))

            while True:
                frame = recv_frame(sock)
                if frame is None:
                    return True
                fin, opcode, data = frame
                if opcode == OP_CLOSE:
                    return True
                if opcode == OP_PING:
                    _send_frame(sock, OP_PONG, data)
                    continue
                if opcode == OP_PONG:
                    continue
                if opcode not in (OP_TEXT, OP_CONT):
                    continue
                # 参考实现不支持跨帧续传：只处理 FIN 且为文本的完整消息
                if not fin:
                    continue
                try:
                    msg = json.loads(data.decode("utf-8"))
                except ValueError:
                    send_error(sock, lock, None, -32700, "Parse error")
                    continue
                if not isinstance(msg, dict):
                    send_error(sock, lock, None, -32600, "Invalid Request")
                    continue
                if not self.handle(sock, lock, msg):
                    # shutdown：响应已 sendall 落进内核缓冲，稍等以确保发出去再退出。
                    # 注意不能用 SystemExit——这里是工作线程，抛出只结束线程，进程不退。
                    time.sleep(0.05)
                    os._exit(0)
        except (ConnectionError, OSError):
            return True
        finally:
            try:
                sock.close()
            except OSError:
                pass


def parse_args(argv):
    args = {"port": 0, "port_file": None, "workspace": os.getcwd(), "name": "py-ref-daemon"}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--port":
            i += 1
            args["port"] = int(argv[i])
        elif a == "--port-file":
            i += 1
            args["port_file"] = argv[i]
        elif a == "--workspace":
            i += 1
            args["workspace"] = argv[i]
        elif a == "--name":
            i += 1
            args["name"] = argv[i]
        i += 1
    return args


def main() -> int:
    args = parse_args(sys.argv[1:])
    token = os.environ.get("DSH_DAEMON_TOKEN") or ""
    if not token:
        print("[py-ref-daemon] 缺少 token：请设置 DSH_DAEMON_TOKEN 环境变量。", file=sys.stderr)
        return 1

    daemon = Daemon(token=token, workspace=args["workspace"], name=args["name"])
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", args["port"]))
    srv.listen(8)
    port = srv.getsockname()[1]
    print(f"DSH_DAEMON_PORT={port}", flush=True)
    print(f"[{args['name']}] listening on ws://127.0.0.1:{port} (workspace: {daemon.workspace})", flush=True)
    if args["port_file"]:
        os.makedirs(os.path.dirname(args["port_file"]), exist_ok=True)
        with open(args["port_file"], "w", encoding="utf-8") as fh:
            json.dump({"port": port, "pid": os.getpid(), "workspace": daemon.workspace}, fh, indent=2)

    try:
        while True:
            conn, _ = srv.accept()
            threading.Thread(target=daemon.serve_connection, args=(conn,), daemon=True).start()
    except KeyboardInterrupt:
        pass
    finally:
        srv.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
