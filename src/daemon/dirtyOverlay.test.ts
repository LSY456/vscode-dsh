import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirtyOverlay, MAX_OVERLAY_FILES } from './dirtyOverlay';

let root: string;
let fileA: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dirty-'));
  fileA = path.join(root, 'a.txt');
  fs.writeFileSync(fileA, 'on-disk', 'utf8');
});
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('DirtyOverlay（P0-1 脏文档覆盖层）', () => {
  it('全量快照替换：后一次调用整体覆盖前一次，不留幽灵条目', () => {
    const o = new DirtyOverlay();
    o.replace([{ path: fileA, content: 'v1' }]);
    expect(o.get(fileA)).toBe('v1');

    const other = path.join(root, 'b.txt');
    o.replace([{ path: other, content: 'v2' }]);
    expect(o.has(fileA)).toBe(false); // 上一次的条目必须消失
    expect(o.get(other)).toBe('v2');
    expect(o.size).toBe(1);
  });

  it('空快照清空覆盖层', () => {
    const o = new DirtyOverlay();
    o.replace([{ path: fileA, content: 'v1' }]);
    expect(o.replace([])).toBe(0);
    expect(o.has(fileA)).toBe(false);
  });

  it('键为 canonical 路径：不同写法（相对/重复分隔符）指向同一条目', () => {
    const o = new DirtyOverlay();
    o.replace([{ path: fileA, content: 'v1' }]);
    expect(o.get(path.join(root, '.', 'a.txt'))).toBe('v1');
    expect(o.has(path.join(root, 'sub', '..', 'a.txt'))).toBe(true);
  });

  it('内容可缺省：只报「脏」时 has 为真而 get 为 undefined（超大文件通路）', () => {
    const o = new DirtyOverlay();
    o.replace([{ path: fileA }]);
    expect(o.has(fileA)).toBe(true); // 写入路径据此避开磁盘
    expect(o.get(fileA)).toBeUndefined(); // 读取路径据此回落磁盘
  });

  it('非法条目被丢弃：非字符串路径 / 空路径 / 含 NUL', () => {
    const o = new DirtyOverlay();
    const bad = [
      { path: '', content: 'x' },
      { path: 123 as unknown as string, content: 'x' },
      { path: path.join(root, 'a\0b.txt'), content: 'x' },
    ];
    expect(o.replace(bad)).toBe(0);
    expect(o.size).toBe(0);
  });

  it('非数组入参按空快照处理（不抛异常）', () => {
    const o = new DirtyOverlay();
    o.replace([{ path: fileA, content: 'v1' }]);
    expect(o.replace(undefined as never)).toBe(0);
    expect(o.has(fileA)).toBe(false);
  });

  it('条目数上限：超出部分被截断（按路径排序后取前 N，结果确定）', () => {
    const o = new DirtyOverlay();
    const many = Array.from({ length: MAX_OVERLAY_FILES + 50 }, (_, i) => ({
      path: path.join(root, `f${String(i).padStart(4, '0')}.txt`),
      content: 'x',
    }));
    expect(o.replace(many)).toBe(MAX_OVERLAY_FILES);
    expect(o.has(path.join(root, 'f0000.txt'))).toBe(true);
    expect(o.has(path.join(root, `f${MAX_OVERLAY_FILES + 49}.txt`))).toBe(false);
  });

  it('clear 清空全部条目', () => {
    const o = new DirtyOverlay();
    o.replace([{ path: fileA, content: 'v1' }]);
    o.clear();
    expect(o.size).toBe(0);
    expect(o.has(fileA)).toBe(false);
  });
});
