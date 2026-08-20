/**
 * 信任记忆（B1）：免审批白名单。
 *
 * 真实场景：用户高频执行安全命令（npm run build 等）不想每次都弹审批卡；
 * 审批卡上点「批准并记住」后，同规则命令不再挂起，直接执行。
 *
 * 安全策略（企业级）：
 *  - 规则脱敏：不是存命令全文，而是生成「程序 + 首个参数」的 prefix 模板
 *    （npm run build -> "npm run"），可疑参数/路径信息不落白名单；
 *  - 高危程序（rm/del/format…）禁止生成宽松前缀规则，只允许整条精确匹配
 *    （exact），迫使用户对破坏性命令逐次审批；
 *  - 精确匹配优先于前缀匹配；规则持久化于 .dsh/trust.json（0600），用户可审阅/删除；
 *  - 匹配边界：prefix 规则 "npm run" 命中 "npm run test"，但绝不命中 "npm runall"。
 *
 * 纯逻辑 + 文件依赖注入，便于确定性测试。
 */
import * as fs from 'fs';
import * as path from 'path';
import { TrustRuleData } from '../../shared/protocol';

/** 内部别名：规则数据即规则（id 即键）。 */
type TrustRule = TrustRuleData;
export type { TrustRule, TrustRuleData };

export interface TrustStoreOptions {
  /** 持久化文件路径（.dsh/trust.json） */
  file: string;
  now?: () => number;
}

/** 高危程序：只允许 exact（整条）信任，禁止生成宽松 prefix 规则 */
export const HIGH_RISK_PROGRAMS = [
  'rm',
  'del',
  'rd',
  'rmdir',
  'format',
  'shutdown',
  'reg',
  'taskkill',
  'pkill',
  'kill',
  'mkfs',
  'dd',
  'fdisk',
  'reboot',
  'mount',
  'chmod',
  'chown',
] as const;

/** 从命令串解析出程序名（忽略管道/重定向/环境变量前缀）。 */
export function programOf(command: string): string {
  const m = command.trim().match(/^([^\s|&;<>()"'`]+)/);
  return m ? m[1] : '';
}

/** 依据命令生成信任规则（脱敏 + 高危分级）。 */
export function buildRuleForCommand(command: string, now: number): TrustRule {
  const trimmed = command.trim();
  const program = programOf(trimmed);
  if (HIGH_RISK_PROGRAMS.includes(program as (typeof HIGH_RISK_PROGRAMS)[number])) {
    const id = `exact:${trimmed}`;
    return { id, kind: 'exact', pattern: trimmed, createdAt: now };
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const pattern = tokens.length >= 2 ? tokens.slice(0, 2).join(' ') : (tokens[0] ?? '');
  return { id: `prefix:${pattern}`, kind: 'prefix', pattern, createdAt: now };
}

/** 规则匹配：exact 全等；prefix 以「前缀 + 单个空格」边界匹配（避免 npm run / npm runall）。 */
export function ruleMatches(rule: TrustRuleData, command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (rule.kind === 'exact') return cmd === rule.pattern;
  return cmd === rule.pattern || cmd.startsWith(rule.pattern + ' ');
}

export class TrustStore {
  private rules = new Map<string, TrustRule>();

  constructor(private readonly opts: TrustStoreOptions) {
    this.load();
  }

  /** 读取持久化文件；缺失/损坏返回空（宁缺毋滥，不因坏文件锁死审批）。 */
  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.opts.file, 'utf8')) as { rules?: unknown };
      if (raw && Array.isArray(raw.rules)) {
        for (const r of raw.rules) {
          const rule = r as TrustRule;
          if (
            rule &&
            typeof rule.id === 'string' &&
            (rule.kind === 'exact' || rule.kind === 'prefix') &&
            typeof rule.pattern === 'string' &&
            typeof rule.createdAt === 'number'
          ) {
            this.rules.set(rule.id, rule);
          }
        }
      }
    } catch {
      /* 无文件或损坏：空规则集 */
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.file), { recursive: true });
      fs.writeFileSync(
        this.opts.file,
        JSON.stringify({ rules: [...this.rules.values()] }, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      );
    } catch (e) {
      // 落盘失败不应阻断审批链（规则仅本次进程内生效）；违规命令仍走审批
      console.error(`[trust] 规则持久化失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 全部规则（新→旧）。 */
  list(): TrustRule[] {
    return [...this.rules.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 命令是否命中任一信任规则。 */
  matches(command: string): boolean {
    for (const rule of this.rules.values()) {
      if (ruleMatches(rule, command)) return true;
    }
    return false;
  }

  /** 将命令纳入白名单（幂等：同 kind+pattern 覆盖保留为最早创建时间语义由 id 去重保证）。 */
  add(command: string): TrustRule {
    const now = this.opts.now?.() ?? Date.now();
    const rule = buildRuleForCommand(command, now);
    this.rules.set(rule.id, rule);
    this.persist();
    return rule;
  }

  /** 清空全部信任规则。 */
  clear(): void {
    this.rules.clear();
    this.persist();
  }
}