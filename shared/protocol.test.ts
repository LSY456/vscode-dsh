import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  EVENTS,
  METHODS,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
} from './protocol';

describe('JSON-RPC 类型守卫', () => {
  it('识别合法请求', () => {
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe(true);
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 'a', method: 'ping', params: {} })).toBe(true);
  });

  it('拒绝缺 id / 缺 method / 错版本', () => {
    expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'ping' })).toBe(false); // 无 id => 通知
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1 })).toBe(false); // 无 method
    expect(isJsonRpcRequest({ jsonrpc: '1.0', id: 1, method: 'ping' })).toBe(false);
    expect(isJsonRpcRequest(null)).toBe(false);
  });

  it('识别合法响应（result 或 error 恰居其一）', () => {
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } })).toBe(true);
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, error: { code: -32009, message: 'busy' } })).toBe(true);
  });

  it('拒绝同时携带 result 与 error 的畸形响应', () => {
    expect(
      isJsonRpcResponse({ jsonrpc: '2.0', id: 1, result: 1, error: { code: 1, message: 'x' } })
    ).toBe(false);
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1 })).toBe(false);
  });

  it('识别通知（无 id）', () => {
    expect(isJsonRpcNotification({ jsonrpc: '2.0', method: 'message.delta', params: {} })).toBe(true);
    expect(isJsonRpcNotification({ jsonrpc: '2.0', id: 1, method: 'message.delta' })).toBe(false);
  });
});

describe('协议常量一致性', () => {
  it('方法/事件/错误码均为非空字符串或数字', () => {
    expect(Object.values(METHODS).every((v) => typeof v === 'string' && v.length > 0)).toBe(true);
    expect(Object.values(EVENTS).every((v) => typeof v === 'string' && v.length > 0)).toBe(true);
    expect(Object.values(ERROR_CODES).every((v) => typeof v === 'number' && v < 0)).toBe(true);
  });

  it('关键错误码语义稳定（扩展依赖它们做分支）', () => {
    expect(ERROR_CODES.Busy).toBe(-32009);
    expect(ERROR_CODES.Expired).toBe(-32010);
    expect(ERROR_CODES.PathOutsideWorkspace).toBe(-32012);
    expect(ERROR_CODES.NotFound).toBe(-32013);
  });
});
