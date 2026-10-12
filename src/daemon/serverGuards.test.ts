import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  defaultCapabilities,
  normalizeCapabilities,
  normalizeDeclaration,
  pendingRespondError,
  resolvePathWithin,
  verifyHandshake,
} from './serverGuards';
import { ERROR_CODES } from '../../shared/protocol';
import { DEFAULT_APPROVAL_TTL_MS, MAX_APPROVAL_TTL_MS, MIN_APPROVAL_TTL_MS } from './sessionManager';

/**
 * P1-17：daemon 是安全边界，这些判定必须能被离线穷举。
 *
 * 这套用例的价值不在"代码能跑"，而在把**必须成立的安全语义**写死：
 *  - Origin 非空一律拒绝（CSWSH）；
 *  - token 精确比对，不做任何"宽容"解析；
 *  - 能力字段非法时收敛到安全的缺省，而不是原样透传（旧实现会把字符串当数组塞进去）。
 */

const TOKEN = 's3cret-token-value';

describe('verifyHandshake（P1-17 握手鉴权）', () => {
  it('正确 Bearer token + 无 Origin -> 放行', () => {
    expect(verifyHandshake({ authorization: `Bearer ${TOKEN}` }, TOKEN)).toBe(true);
    expect(verifyHandshake({ authorization: `Bearer ${TOKEN}`, origin: '' }, TOKEN)).toBe(true);
    expect(verifyHandshake({ authorization: `Bearer ${TOKEN}`, origin: null }, TOKEN)).toBe(true);
  });

  it('携带任何 Origin 一律拒绝（CSWSH 防护）', () => {
    expect(verifyHandshake({ authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' }, TOKEN)).toBe(false);
    // 即便 Origin 是空白的 " " 也算携带（只有真正空串才视为不携带）
    expect(verifyHandshake({ authorization: `Bearer ${TOKEN}`, origin: ' ' }, TOKEN)).toBe(false);
    // 本机页面同样拒绝：127.0.0.1 不是信任边界
    expect(verifyHandshake({ authorization: `Bearer ${TOKEN}`, origin: 'http://127.0.0.1:3000' }, TOKEN)).toBe(false);
  });

  it('缺 Authorization / 空串 -> 拒绝', () => {
    expect(verifyHandshake({}, TOKEN)).toBe(false);
    expect(verifyHandshake({ authorization: undefined }, TOKEN)).toBe(false);
    expect(verifyHandshake({ authorization: null }, TOKEN)).toBe(false);
    expect(verifyHandshake({ authorization: '' }, TOKEN)).toBe(false);
  });

  it('token 必须精确匹配：不接受前缀伪造 / 大小写变体 / 缺前缀', () => {
    expect(verifyHandshake({ authorization: `${TOKEN}` }, TOKEN)).toBe(false); // 缺 "Bearer "
    expect(verifyHandshake({ authorization: `bearer ${TOKEN}` }, TOKEN)).toBe(false); // scheme 小写
    expect(verifyHandshake({ authorization: `Bearer ${TOKEN} ` }, TOKEN)).toBe(false); // 尾随空格
    expect(verifyHandshake({ authorization: `Bearer  ${TOKEN}` }, TOKEN)).toBe(false); // 双空格
    expect(verifyHandshake({ authorization: `Bearer ${TOKEN.toUpperCase()}` }, TOKEN)).toBe(false);
    expect(verifyHandshake({ authorization: `Bearer ${TOKEN}x` }, TOKEN)).toBe(false); // 多一字符
    expect(verifyHandshake({ authorization: `Basic ${TOKEN}` }, TOKEN)).toBe(false); // 换 scheme
    expect(verifyHandshake({ authorization: `Bearer ${TOKEN.slice(0, -1)}` }, TOKEN)).toBe(false); // 少一字符
  });

  it('token 为空时只接受字面 "Bearer "（服务端不该走到这里，但判定需自洽）', () => {
    expect(verifyHandshake({ authorization: 'Bearer ' }, '')).toBe(true);
    expect(verifyHandshake({ authorization: 'Bearer' }, '')).toBe(false);
    expect(verifyHandshake({}, '')).toBe(false);
  });

  it('判定不含副作用：重复调用同一输入结果恒定', () => {
    const info = { authorization: `Bearer ${TOKEN}` };
    const first = verifyHandshake(info, TOKEN);
    for (let i = 0; i < 5; i++) expect(verifyHandshake(info, TOKEN)).toBe(first);
  });
});

describe('normalizeCapabilities / normalizeDeclaration（P1-17 能力收敛）', () => {
  it('未声明 -> 空能力（= 不额外限制）', () => {
    expect(normalizeCapabilities()).toEqual({ allowedTools: [], allowedDirs: [], maxConcurrency: 0 });
    expect(normalizeCapabilities(null)).toEqual({ allowedTools: [], allowedDirs: [], maxConcurrency: 0 });
    expect(normalizeCapabilities({})).toEqual({ allowedTools: [], allowedDirs: [], maxConcurrency: 0 });
  });

  it('正常声明原样收敛', () => {
    expect(
      normalizeCapabilities({ allowedTools: ['read_file'], allowedDirs: ['/tmp/ws/sub'], maxConcurrency: 2 })
    ).toEqual({ allowedTools: ['read_file'], allowedDirs: ['/tmp/ws/sub'], maxConcurrency: 2 });
  });

  it('产出的数组是拷贝，不持有调用方引用（防后续被改写）', () => {
    const tools = ['read_file'];
    const dirs = ['/tmp/ws'];
    const caps = normalizeCapabilities({ allowedTools: tools, allowedDirs: dirs });
    tools.push('bash_execute');
    dirs.push('/etc');
    expect(caps.allowedTools).toEqual(['read_file']);
    expect(caps.allowedDirs).toEqual(['/tmp/ws']);
  });

  it('两次调用互不共享引用（连接级隔离的物理前提）', () => {
    const a = defaultCapabilities();
    const b = defaultCapabilities();
    expect(a.allowedTools).not.toBe(b.allowedTools);
    expect(a.allowedDirs).not.toBe(b.allowedDirs);
    a.allowedTools.push('read_file');
    expect(b.allowedTools).toEqual([]);
  });

  it('字段类型非法时按"未声明"处理，不做原样透传', () => {
    // 旧实现会把字符串当数组塞进 allowedTools，Agent 侧 .some() 时直接抛
    const caps = normalizeCapabilities({
      allowedTools: 'read_file' as unknown,
      allowedDirs: 42 as unknown,
    });
    expect(caps.allowedTools).toEqual([]);
    expect(caps.allowedDirs).toEqual([]);
  });

  it('maxConcurrency 非正数 / 非数字 / 非有限 -> 0（= 不限制）', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '3', null]) {
      expect(normalizeCapabilities({ maxConcurrency: bad }).maxConcurrency).toBe(0);
    }
  });

  it('maxConcurrency 小数向下取整（不能出现"1.5 个并发"）', () => {
    expect(normalizeCapabilities({ maxConcurrency: 2.9 }).maxConcurrency).toBe(2);
  });

  it('normalizeDeclaration：未声明 approvalTtlMs -> null（调用方保持现状）', () => {
    expect(normalizeDeclaration({}).approvalTtlMs).toBeNull();
    expect(normalizeDeclaration(undefined).approvalTtlMs).toBeNull();
  });

  it('normalizeDeclaration：显式声明 -> 收敛到 [10s, 60min]', () => {
    expect(normalizeDeclaration({ approvalTtlMs: 30_000 }).approvalTtlMs).toBe(30_000);
    expect(normalizeDeclaration({ approvalTtlMs: 1 }).approvalTtlMs).toBe(MIN_APPROVAL_TTL_MS);
    expect(normalizeDeclaration({ approvalTtlMs: 1e12 }).approvalTtlMs).toBe(MAX_APPROVAL_TTL_MS);
    expect(normalizeDeclaration({ approvalTtlMs: 0 }).approvalTtlMs).toBe(DEFAULT_APPROVAL_TTL_MS);
    expect(normalizeDeclaration({ approvalTtlMs: 'nope' }).approvalTtlMs).toBe(DEFAULT_APPROVAL_TTL_MS);
  });
});

describe('pendingRespondError（P1-17 挂起项错误码映射）', () => {
  it('ok -> null（调用方走成功路径）', () => {
    expect(pendingRespondError('approval', 'ok', 'a1')).toBeNull();
    expect(pendingRespondError('plan', 'ok', 'p1')).toBeNull();
    expect(pendingRespondError('patch', 'ok', 'f1')).toBeNull();
  });

  it('三类挂起项的失败映射**同源**：找不到 -> NotFound，过期 -> Expired', () => {
    const kinds = ['approval', 'plan', 'patch'] as const;
    for (const kind of kinds) {
      expect(pendingRespondError(kind, 'not_found', 'x')!.code).toBe(ERROR_CODES.NotFound);
      expect(pendingRespondError(kind, 'expired', 'x')!.code).toBe(ERROR_CODES.Expired);
    }
  });

  it('文案带中文类别名与 id，且与旧内联实现逐字一致', () => {
    expect(pendingRespondError('approval', 'not_found', 'a1')).toEqual({
      code: ERROR_CODES.NotFound,
      message: '审批不存在或已处理: a1',
    });
    expect(pendingRespondError('approval', 'expired', 'a1')).toEqual({
      code: ERROR_CODES.Expired,
      message: '审批已过期: a1',
    });
    expect(pendingRespondError('plan', 'not_found', 'p1')!.message).toBe('计划不存在或已处理: p1');
    expect(pendingRespondError('plan', 'expired', 'p1')!.message).toBe('计划已过期: p1');
    expect(pendingRespondError('patch', 'not_found', 'f1')!.message).toBe('补丁不存在或已处理: f1');
    expect(pendingRespondError('patch', 'expired', 'f1')!.message).toBe('补丁已过期: f1');
  });

  it('三类错误码互不相同且落在 JSON-RPC 保留区间之外', () => {
    const notFound = pendingRespondError('approval', 'not_found', 'x')!.code;
    const expired = pendingRespondError('approval', 'expired', 'x')!.code;
    expect(notFound).not.toBe(expired);
    // -32000..-32099 是 JSON-RPC 预留的服务端错误区间
    expect(notFound).toBeLessThanOrEqual(-32000);
    expect(expired).toBeLessThanOrEqual(-32000);
  });
});

/**
 * 路径护栏：工作区边界与 allowedDirs 收窄必须**同时**生效。
 * 用真实临时目录测，因为判定依赖 canonicalize（解析符号链接）—— 假路径测不出这层。
 */
describe('resolvePathWithin（P1-17 路径护栏）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-guard-'));
  const sub = path.join(root, 'sub');
  const other = path.join(root, 'other');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(sub, 'a.txt'), 'x');

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('工作区内的相对路径 -> 解析为 canonical 绝对路径', () => {
    const r = resolvePathWithin(root, [], 'sub/a.txt');
    expect('resolved' in r).toBe(true);
    expect((r as { resolved: string }).resolved.endsWith(path.join('sub', 'a.txt'))).toBe(true);
    expect(path.isAbsolute((r as { resolved: string }).resolved)).toBe(true);
  });

  it('工作区内的绝对路径 -> 放行', () => {
    const r = resolvePathWithin(root, [], path.join(sub, 'a.txt'));
    expect('resolved' in r).toBe(true);
  });

  it('工作区外的路径 -> error（不抛，交给调用方映射成 PathOutsideWorkspace）', () => {
    const outside = path.join(root, '..', `dsh-outside-${Date.now()}`);
    const r = resolvePathWithin(root, [], outside);
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toContain('路径越界');
  });

  it('用 .. 逃逸工作区 -> error', () => {
    const r = resolvePathWithin(root, [], path.join(sub, '..', '..', 'etc'));
    expect('error' in r).toBe(true);
  });

  it('allowedDirs 为空 = 不额外限制（工作区内即可）', () => {
    expect('resolved' in resolvePathWithin(root, [], 'other')).toBe(true);
  });

  it('allowedDirs 命中 -> 放行', () => {
    expect('resolved' in resolvePathWithin(root, [sub], 'sub/a.txt')).toBe(true);
    expect('resolved' in resolvePathWithin(root, [other, sub], 'sub/a.txt')).toBe(true);
  });

  it('allowedDirs 未命中 -> error（收窄不能被绕过）', () => {
    const r = resolvePathWithin(root, [sub], 'other');
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toContain('allowedDirs');
  });

  it('allowedDirs 指向工作区外时，该条目自身无效（不会反向放宽）', () => {
    const outside = path.join(root, '..', `dsh-outside-${Date.now()}`);
    const r = resolvePathWithin(root, [outside], 'sub');
    expect('error' in r).toBe(true);
  });
});

