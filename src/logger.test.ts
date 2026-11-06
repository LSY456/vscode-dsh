/**
 * 扩展侧日志（logger）的行为锁。
 *
 * 这类"薄壳"模块最容易被当成无需测试，但它有两个真实风险点：
 *  1. `init()` 之前就被调用 —— 模块级单例，任何早于 activate 的 import 都可能触发，
 *     必须"静默不抛"，否则一条日志就能把激活流程带崩；
 *  2. 级别过滤的真实语义 —— `debug()` 默认不输出，`info/warn/error` 恒输出。
 *     这条口径决定了用户开 debug 后看到什么，写错方向是"该看的看不到"。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from 'vscode';

const h = vi.hoisted(() => {
  /** 每次 createOutputChannel 产出的假通道都记在这里，便于逐条断言写入了什么 */
  const lines: string[] = [];
  let showArgs: unknown[] = [];
  const config: Record<string, string> = { 'log.level': 'info' };
  return { lines, config, get showArgs() { return showArgs; }, setShowArgs(a: unknown[]) { showArgs = a; } };
});

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      appendLine(line: string) {
        h.lines.push(line);
      },
      show(...args: unknown[]) {
        h.setShowArgs(args);
      },
      dispose() {},
    }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, def: unknown) => (key in h.config ? h.config[key] : def),
    }),
  },
}));

/** 只用到 subscriptions 一项，其余字段 logger 不碰，交给类型断言。 */
function makeContext(subs: Array<{ dispose(): void }> = []): ExtensionContext {
  return { subscriptions: subs } as unknown as ExtensionContext;
}

/** 每个用例都拿一份全新的单例，避免上一例的 level / channel 泄漏到下一例。 */
async function freshLogger() {
  vi.resetModules();
  h.lines.length = 0;
  h.setShowArgs([]);
  return import('./logger');
}

beforeEach(() => {
  h.config['log.level'] = 'info';
});

describe('logger：初始化前不得崩', () => {
  it('init 之前调用 info / warn / error 静默丢弃，不抛异常', async () => {
    const { logger } = await freshLogger();
    expect(() => logger.info('还没初始化')).not.toThrow();
    expect(() => logger.warn('还没初始化')).not.toThrow();
    expect(() => logger.error('还没初始化', new Error('x'))).not.toThrow();
    expect(() => logger.debug('还没初始化')).not.toThrow();
    expect(h.lines).toEqual([]);
  });

  it('init 之前调用 show() 不抛', async () => {
    const { logger } = await freshLogger();
    expect(() => logger.show()).not.toThrow();
  });
});

describe('logger：级别与格式', () => {
  it('缺省 info 级别：debug 不输出，其余三档都输出', async () => {
    const { logger } = await freshLogger();
    logger.init(makeContext());
    h.lines.length = 0;
    logger.info('一');
    logger.debug('二');
    logger.warn('三');
    logger.error('四');
    expect(h.lines).toHaveLength(3);
    expect(h.lines.map((l) => l.includes('] [INFO] ') || l.includes('] [WARN] ') || l.includes('] [ERROR] '))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('配置里写着 debug 时，init 后立刻可见 debug', async () => {
    h.config['log.level'] = 'debug';
    const { logger } = await freshLogger();
    logger.init(makeContext());
    h.lines.length = 0;
    logger.debug('细节');
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain('] [DEBUG] 细节');
  });

  it('setLevel("debug") 之后 debug 立即可见（无需重新 init）', async () => {
    const { logger } = await freshLogger();
    logger.init(makeContext());
    h.lines.length = 0;
    logger.debug('之前');
    expect(h.lines).toHaveLength(0);
    logger.setLevel('debug');
    logger.debug('之后');
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain('之后');
  });

  it('每行形如 [ISO 时间] [级别] 正文', async () => {
    const { logger } = await freshLogger();
    logger.init(makeContext());
    h.lines.length = 0;
    logger.info('正文');
    expect(h.lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] 正文$/);
  });
});

describe('logger：错误详情与生命周期', () => {
  it('error() 带上 Error 的 message；非 Error 附加值不加噪', async () => {
    const { logger } = await freshLogger();
    logger.init(makeContext());
    h.lines.length = 0;
    logger.error('失败了', new Error('磁盘只读'));
    logger.error('失败了', '一段字符串');
    logger.error('失败了', undefined);
    expect(h.lines[0]).toContain('失败了 — 磁盘只读');
    expect(h.lines[1]).toMatch(/失败了$/);
    expect(h.lines[2]).toMatch(/失败了$/);
  });

  it('init 会把自己建的 OutputChannel 交给 subscriptions 回收，并写一条初始化记录', async () => {
    const { logger } = await freshLogger();
    const subscriptions: Array<{ dispose(): void }> = [];
    logger.init(makeContext(subscriptions));
    expect(subscriptions).toHaveLength(1);
    expect(h.lines.some((l) => l.includes('logger 初始化完成'))).toBe(true);
  });

  it('show() 透传 (true)：不抢焦点地展开输出面板', async () => {
    const { logger } = await freshLogger();
    logger.init(makeContext());
    logger.show();
    expect(h.showArgs).toEqual([true]);
  });
});
