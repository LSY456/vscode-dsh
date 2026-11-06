import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MAX_MEMORY_ENTRIES,
  MAX_MEMORY_TEXT,
  MemoryEntryData,
} from '../../shared/protocol';
import { buildMemorySection, MemoryStore, normalizeMemoryText } from './memoryStore';

let root = '';
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-'));
});
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

let dirSeq = 0;
/** 每个用例一个独立目录，避免互相看到对方写的 memory.json。 */
function makeStore(now?: () => number): { file: string; store: MemoryStore } {
  dirSeq++;
  const file = path.join(root, `case${dirSeq}`, 'memory.json');
  return { file, store: new MemoryStore({ file, now }) };
}

function entry(id: string, text: string, createdAt: number): MemoryEntryData {
  return { id, text, createdAt };
}

describe('normalizeMemoryText', () => {
  it('压掉换行与连续空白：记忆必须单行，否则能在提示词里伪造出新的项目符号', () => {
    expect(normalizeMemoryText('  别用\ttab\n缩进  ')).toBe('别用 tab 缩进');
    expect(normalizeMemoryText('- 第一条\n- 第二条')).toBe('- 第一条 - 第二条');
  });

  it('超长截到上限，非字符串输入不炸', () => {
    expect(normalizeMemoryText('x'.repeat(MAX_MEMORY_TEXT + 50))).toHaveLength(MAX_MEMORY_TEXT);
    expect(normalizeMemoryText(undefined)).toBe('');
    expect(normalizeMemoryText(null)).toBe('');
  });
});

describe('MemoryStore：写入与持久化', () => {
  it('写入后可读回，按新→旧排列，并落盘', () => {
    let clock = 1000;
    const { file, store } = makeStore(() => (clock += 10));

    const first = store.add('本项目禁用 npm，一律用 pnpm');
    const second = store.add('缩进用 2 空格，不要 tab');
    expect(first.ok && second.ok).toBe(true);

    const list = store.list();
    expect(list.map((e) => e.text)).toEqual(['缩进用 2 空格，不要 tab', '本项目禁用 npm，一律用 pnpm']);

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: MemoryEntryData[] };
    expect(onDisk.entries).toHaveLength(2);
  });

  it('重复内容（忽略大小写与空白差异）不重复写入', () => {
    const { store } = makeStore();
    expect(store.add('Use pnpm, not npm').ok).toBe(true);
    const dup = store.add('  use   PNPM, not npm ');
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toBe('duplicate');
    expect(store.list()).toHaveLength(1);
  });

  it('空内容被拒绝', () => {
    const { store } = makeStore();
    const r = store.add('   \n  ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty');
  });

  it('达到条数上限后拒绝写入，且不淘汰最旧一条', () => {
    let clock = 0;
    const { store } = makeStore(() => (clock += 1));
    for (let i = 0; i < MAX_MEMORY_ENTRIES; i++) {
      expect(store.add(`偏好 ${i}`).ok).toBe(true);
    }
    const over = store.add('第 41 条');
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe('full');

    const list = store.list();
    expect(list).toHaveLength(MAX_MEMORY_ENTRIES);
    // 最旧的一条必须还在：静默淘汰用户要求记住的东西是不可接受的
    expect(list.some((e) => e.text === '偏好 0')).toBe(true);
  });

  it('删除与清空都会落盘（另一个实例重新读盘能看到）', () => {
    const { file, store } = makeStore();
    const r = store.add('记住这条');
    expect(r.ok).toBe(true);
    const id = r.ok ? r.entry.id : '';

    const reopened = new MemoryStore({ file });
    expect(reopened.list()).toHaveLength(1);

    expect(reopened.remove(id)).toBe(true);
    expect(reopened.remove(id)).toBe(false); // 再删一次：本来就没有
    expect(new MemoryStore({ file }).list()).toHaveLength(0);

    store.add('A');
    store.clear();
    expect(new MemoryStore({ file }).list()).toHaveLength(0);
  });

  it('读盘失败不覆盖内存中的条目：一次读坏不该把刚批准的记忆清空', () => {
    const { file, store } = makeStore();
    store.add('这条不能在读坏文件后消失');
    fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');

    // load() 解析失败 → 沿用内存中的条目
    expect(store.list().map((e) => e.text)).toEqual(['这条不能在读坏文件后消失']);
    // 再写一条会把文件修好（整份重写），坏文件不会永久卡住功能
    expect(store.add('修好之后的新条目').ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveProperty('entries');
  });

  it('文件里混入脏条目时逐条跳过，不整份丢弃', () => {
    const { file } = makeStore();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'ok', text: '合法条目', createdAt: 1 },
          { id: 'bad-1', text: '缺 createdAt' },
          { id: 'bad-2', text: 42, createdAt: 2 },
          null,
        ],
      }),
      'utf8'
    );
    const store = new MemoryStore({ file });
    expect(store.list().map((e) => e.text)).toEqual(['合法条目']);
  });

  it('落盘失败时本会话仍生效，但如实标记 persisted=false', () => {
    dirSeq++;
    const blocked = path.join(root, `case${dirSeq}`);
    // 把「本该是目录」的位置先占成普通文件：mkdirSync 必然失败，落盘走不通
    fs.writeFileSync(blocked, 'x', 'utf8');
    const store = new MemoryStore({ file: path.join(blocked, 'memory.json') });

    const r = store.add('这条写不进磁盘');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.persisted).toBe(false);
    // 不因为写盘失败就丢掉用户刚批准的内容：本会话照样生效
    expect(store.list().map((e) => e.text)).toEqual(['这条写不进磁盘']);
  });
});

describe('buildMemorySection', () => {
  it('没有记忆时返回空串：未使用记忆的会话，请求体一字不加', () => {
    expect(buildMemorySection([])).toBe('');
  });

  it('按时间从旧到新排列，并声明"与本轮指令冲突时以本轮为准"', () => {
    const section = buildMemorySection([
      entry('b', '第二条', 200),
      entry('a', '第一条', 100),
    ]);
    expect(section).toContain('【长期记忆】');
    expect(section).toContain('以本轮为准');
    expect(section.indexOf('第一条')).toBeLessThan(section.indexOf('第二条'));
  });

  it('超字符预算时只展开最新的若干条，并明说还有多少条未展开', () => {
    const entries = [
      entry('1', 'A'.repeat(60), 1),
      entry('2', 'B'.repeat(60), 2),
      entry('3', 'C'.repeat(60), 3),
    ];
    const section = buildMemorySection(entries, 140);
    // 预算只够放一条（表头 + 60 余字符），且留的一定是最新的那条
    expect(section).toContain('C'.repeat(60));
    expect(section).not.toContain('A'.repeat(60));
    expect(section).toContain('另有 2 条');
  });

  it('连一条都放不下时返回空串，而不是只剩一个表头', () => {
    expect(buildMemorySection([entry('1', 'X'.repeat(100), 1)], 10)).toBe('');
  });
});

describe('MemoryStore.section', () => {
  it('段落反映磁盘上的最新内容（跨实例：另一个窗口写的也能看到）', () => {
    const { file, store } = makeStore();
    store.add('本项目禁止直接 push 到 main');
    const other = new MemoryStore({ file });
    expect(other.section()).toContain('本项目禁止直接 push 到 main');
  });
});
