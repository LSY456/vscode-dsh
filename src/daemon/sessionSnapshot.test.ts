import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionSnapshotStore, isSafeBlobName, safeSessionSegment } from './sessionSnapshot';

/**
 * P2-6 会话级事务回滚的存储层。
 *
 * 这个模块的价值全在**边界**上，所以测试也全打在边界上：
 *  - 首写优先（同一文件改两次，回滚要回到"这次会话开始前"，不是"上一次修改前"）
 *  - 新建 → 回滚即删除
 *  - 脏文档一律跳过（宁可回滚不全，也不覆盖用户正在编辑的内容）
 *  - 索引被篡改 → 路径重校验挡住，写不到工作区外
 *  - 超出容量 → 如实计数/分类上报，不静默少还一个文件
 *  - 任何失败都不抛（留不下快照不是让写盘失败的理由）
 */

let root: string;
let storeRoot: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-snap-'));
  storeRoot = path.join(root, '.dsh', 'snapshots');
});
afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function mk(opts: Partial<ConstructorParameters<typeof SessionSnapshotStore>[0]> = {}) {
  return new SessionSnapshotStore({ root: storeRoot, workspaceRoot: root, log: () => {}, ...opts });
}

const file = (name: string) => path.join(root, name);

describe('safeSessionSegment（会话 id 拼进路径前的收敛）', () => {
  it('正常 id 原样通过', () => {
    expect(safeSessionSegment('sess_abc123')).toBe('sess_abc123');
  });

  it('分隔符 / 上跳 / 空串都被收敛，不会逃出快照目录', () => {
    // 白名单字符集里不含 `.` 与分隔符，故 `..` 表达不出来（退化成 `__`，是普通目录名）
    expect(safeSessionSegment('..')).toBe('__');
    expect(safeSessionSegment('../../etc')).toBe('______etc');
    expect(safeSessionSegment('')).toBe('_unnamed');
    expect(safeSessionSegment('a\\b')).toBe('a_b');
    // 任一取值都不得成为特殊目录项或含分隔符
    for (const id of ['..', '.', '../x', 'a/b', 'a\\b', '', 'x'.repeat(100)]) {
      const seg = safeSessionSegment(id);
      expect(seg).not.toBe('.');
      expect(seg).not.toBe('..');
      expect(seg).not.toContain('/');
      expect(seg).not.toContain('\\');
      expect(seg.length).toBeLessThanOrEqual(64);
    }
  });
});

describe('record（首写优先 + 不抛）', () => {
  it('同一文件记两次只有第一次生效 —— 回滚目标是"会话开始前"', () => {
    const s = mk();
    const f = file('a.txt');
    s.record('sess1', f, 'v1');
    s.record('sess1', f, 'v2');

    expect(s.count('sess1')).toBe(1);
    expect(s.list('sess1')[0].bytes).toBe(2);
  });

  it('Windows 大小写差异视为同一文件（不会重复记录）', () => {
    const s = mk();
    const f = file('Case.txt');
    s.record('sess1', f, 'x');
    s.record('sess1', f.toUpperCase(), 'y');
    // 只有在 Windows 上 pathKey 才折叠大小写，故此处按平台断言
    const expected = process.platform === 'win32' ? 1 : 2;
    expect(s.count('sess1')).toBe(expected);
  });

  it('文件不存在（新建）也记录，existed 为假', () => {
    const s = mk();
    s.record('sess1', file('new.txt'), undefined);
    const [e] = s.list('sess1');
    expect(e).toMatchObject({ existed: false, blob: null });
  });

  it('超出单文件上限 -> 记为不可还原，而不是静默丢弃', () => {
    const s = mk({ maxBytesPerFile: 4 });
    s.record('sess1', file('big.txt'), 'x'.repeat(10));
    const [e] = s.list('sess1');
    expect(e.blob).toBeNull();
    expect(e.unrestorable).toContain('超过快照上限');
  });

  it('超出条目上限 -> 计入 dropped，不新增条目', () => {
    const s = mk({ maxEntries: 1 });
    s.record('sess1', file('a.txt'), 'a');
    s.record('sess1', file('b.txt'), 'b');
    expect(s.count('sess1')).toBe(1);
    const report = s.restore('sess1', () => false);
    expect(report.unrecorded).toBe(1);
  });

  it('快照根不可用时失败不抛（留不下快照不该阻断写盘）', () => {
    // 把"根目录"指到一个普通文件上 -> mkdir 必然失败
    const bogus = file('not-a-dir');
    fs.writeFileSync(bogus, 'x', 'utf8');
    const s = new SessionSnapshotStore({ root: bogus, workspaceRoot: root, log: () => {} });
    expect(() => s.record('sess1', file('a.txt'), 'v')).not.toThrow();
    expect(s.count('sess1')).toBe(0);
  });

  it('失败会经 log 说出来（否则用户只能在回滚时才发现少了个文件）', () => {
    const bogus = file('not-a-dir2');
    fs.writeFileSync(bogus, 'x', 'utf8');
    const messages: string[] = [];
    const s = new SessionSnapshotStore({ root: bogus, workspaceRoot: root, log: (m) => messages.push(m) });
    s.record('sess1', file('a.txt'), 'v');
    expect(messages.join('\n')).toContain('记录快照失败');
  });
});

describe('restore（还原 / 删除 / 跳过 / 越界）', () => {
  it('还原为记录时的内容', () => {
    const s = mk();
    const f = file('a.txt');
    fs.writeFileSync(f, 'original', 'utf8');
    s.record('sess1', f, 'original');
    fs.writeFileSync(f, 'agent-modified', 'utf8');

    const r = s.restore('sess1', () => false);
    expect(r.total).toBe(1);
    expect(r.restored).toEqual([f]);
    expect(r.failed).toEqual([]);
    expect(fs.readFileSync(f, 'utf8')).toBe('original');
  });

  it('新建的文件回滚即删除', () => {
    const s = mk();
    const f = file('created.txt');
    s.record('sess1', f, undefined);
    fs.writeFileSync(f, 'agent created', 'utf8');

    const r = s.restore('sess1', () => false);
    expect(r.deleted).toEqual([f]);
    expect(fs.existsSync(f)).toBe(false);
  });

  it('新建的文件已被手工删掉 -> 仍算删除成功（不报失败）', () => {
    const s = mk();
    const f = file('gone.txt');
    s.record('sess1', f, undefined);
    const r = s.restore('sess1', () => false);
    expect(r.deleted).toEqual([f]);
    expect(r.failed).toEqual([]);
  });

  it('脏文档跳过，且磁盘内容不被覆盖', () => {
    const s = mk();
    const f = file('a.txt');
    fs.writeFileSync(f, 'original', 'utf8');
    s.record('sess1', f, 'original');
    fs.writeFileSync(f, 'agent-modified', 'utf8');

    const r = s.restore('sess1', () => true);
    expect(r.skippedDirty).toEqual([f]);
    expect(r.restored).toEqual([]);
    expect(fs.readFileSync(f, 'utf8')).toBe('agent-modified'); // 绝不覆盖用户正在编辑的内容
  });

  it('不可还原的条目单独分类，不混进失败', () => {
    const s = mk({ maxBytesPerFile: 2 });
    s.record('sess1', file('big.txt'), 'too-long');
    const r = s.restore('sess1', () => false);
    expect(r.unrestorable).toHaveLength(1);
    expect(r.unrestorable[0].reason).toContain('超过快照上限');
    expect(r.failed).toEqual([]);
  });

  it('索引被篡改成工作区外路径 -> 拒绝执行并报失败，不写到外面', () => {
    const s = mk();
    const inside = file('safe.txt');
    s.record('sess1', inside, 'v');
    // 直接改索引文件：模拟"本机其它进程篡改了 .dsh 下的文件"
    const outside = path.join(root, '..', 'evil.txt');
    const idxFile = path.join(storeRoot, 'sess1', 'index.json');
    const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    idx.entries[0].path = outside;
    fs.writeFileSync(idxFile, JSON.stringify(idx), 'utf8');

    const r = s.restore('sess1', () => false);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].error).toContain('路径校验未通过');
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('没有记录过任何改动 -> total 为 0（面板据此说"无需回滚"）', () => {
    const r = mk().restore('never', () => false);
    expect(r).toMatchObject({ total: 0, restored: [], deleted: [], unrecorded: 0 });
  });

  it('索引损坏当作空索引，不抛异常', () => {
    const s = mk();
    fs.mkdirSync(path.join(storeRoot, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(storeRoot, 'broken', 'index.json'), '{ 不是 JSON', 'utf8');
    expect(s.count('broken')).toBe(0);
    expect(() => s.restore('broken', () => false)).not.toThrow();
  });

  it('首写优先在回滚上体现为"回到会话开始前"（改两次仍是第一次的内容）', () => {
    const s = mk();
    const f = file('a.txt');
    fs.writeFileSync(f, 'v1', 'utf8');
    s.record('sess1', f, 'v1');
    fs.writeFileSync(f, 'v2', 'utf8');
    s.record('sess1', f, 'v2'); // 被忽略
    fs.writeFileSync(f, 'v3', 'utf8');

    s.restore('sess1', () => false);
    expect(fs.readFileSync(f, 'utf8')).toBe('v1');
  });
});

describe('clear', () => {
  it('返回被丢弃的条目数并删除目录', () => {
    const s = mk();
    s.record('sess1', file('a.txt'), 'a');
    expect(s.clear('sess1')).toBe(1);
    expect(fs.existsSync(path.join(storeRoot, 'sess1'))).toBe(false);
    expect(s.count('sess1')).toBe(0);
  });
});

/**
 * 写入指纹（文件头 ⑤）。
 *
 * ③ 的「脏文档跳过」只挡得住"编辑器里还没保存"的改动；用户改完**保存**之后文件不脏，
 * 守卫就失效了 —— 回滚会把他的改动连同 Agent 的一起退回，而报告还显示"全部成功"。
 * 这一组用例钉的就是这个缺口：磁盘不是"我留下的样子"就一律不碰。
 */
describe('restore × 写入指纹（会话之后被改过就不覆盖）', () => {
  it('磁盘内容与本次会话写入的一致 -> 正常还原', () => {
    const s = mk();
    const f = file('a.txt');
    fs.writeFileSync(f, 'original', 'utf8');
    s.record('sess1', f, 'original', 'agent-written');
    fs.writeFileSync(f, 'agent-written', 'utf8'); // 正是会话写入的样子

    const r = s.restore('sess1', () => false);
    expect(r.restored).toEqual([f]);
    expect(r.changedAfter).toEqual([]);
    expect(fs.readFileSync(f, 'utf8')).toBe('original');
  });

  it('用户改完又保存（文件不脏）-> 归入「内容已变」，绝不覆盖', () => {
    const s = mk();
    const f = file('a.txt');
    fs.writeFileSync(f, 'original', 'utf8');
    s.record('sess1', f, 'original', 'agent-written');
    fs.writeFileSync(f, 'user-edited-and-saved', 'utf8'); // 会话之后被改过

    // 关键：不脏（已保存），所以脏文档守卫拦不住它 —— 挡住它的是写入指纹
    const r = s.restore('sess1', () => false);
    expect(r.changedAfter).toHaveLength(1);
    expect(r.changedAfter[0].path).toBe(f);
    expect(r.restored).toEqual([]);
    expect(fs.readFileSync(f, 'utf8')).toBe('user-edited-and-saved'); // 用户改动保住了
  });

  it('会话新建的文件被用户改过 -> 不删除（删除会毁掉用户的改动）', () => {
    const s = mk();
    const f = file('created.txt');
    s.record('sess1', f, undefined, 'agent-created');
    fs.writeFileSync(f, 'user-edited', 'utf8');

    const r = s.restore('sess1', () => false);
    expect(r.deleted).toEqual([]);
    expect(r.changedAfter).toHaveLength(1);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('原本存在的文件在会话之后被删掉 -> 陈述「未还原」，不谎报成功', () => {
    const s = mk();
    const f = file('gone.txt');
    fs.writeFileSync(f, 'original', 'utf8');
    s.record('sess1', f, 'original', 'agent-written');
    fs.unlinkSync(f);

    const r = s.restore('sess1', () => false);
    expect(r.restored).toEqual([]);
    expect(r.changedAfter).toHaveLength(1);
    expect(r.changedAfter[0].reason).toContain('不存在');
  });

  it('同一文件写两次：改动前内容取第一次，写入指纹取最后一次', () => {
    const s = mk();
    const f = file('a.txt');
    fs.writeFileSync(f, 'v1', 'utf8');
    s.record('sess1', f, 'v1', 'w1');
    s.record('sess1', f, 'v2', 'w2'); // 改动前内容被忽略、指纹被更新为 w2
    fs.writeFileSync(f, 'w2', 'utf8');

    const r = s.restore('sess1', () => false);
    expect(r.restored).toEqual([f]);
    expect(fs.readFileSync(f, 'utf8')).toBe('v1'); // 仍是"会话开始前"
  });

  it('未观测到写入内容 -> 退回旧行为，不因缺指纹就让回滚整体失效', () => {
    const s = mk();
    const f = file('a.txt');
    fs.writeFileSync(f, 'original', 'utf8');
    s.record('sess1', f, 'original'); // 没有写入指纹
    fs.writeFileSync(f, 'anything', 'utf8');

    const r = s.restore('sess1', () => false);
    expect(r.restored).toEqual([f]);
    expect(r.changedAfter).toEqual([]);
  });

  it('回滚两次是幂等的：第二次仍报还原，而不是谎报「内容已变」', () => {
    const s = mk();
    const f = file('a.txt');
    fs.writeFileSync(f, 'original', 'utf8');
    s.record('sess1', f, 'original', 'agent-written');
    fs.writeFileSync(f, 'agent-written', 'utf8');

    expect(s.restore('sess1', () => false).restored).toEqual([f]);
    // 快照只增不改，所以「再点一次回滚」是常见动作：此时磁盘 = 会话开始前的内容，
    // 与写入指纹不符，但那是**我们自己**刚还原的结果，不该吓用户说"内容已变"
    const again = s.restore('sess1', () => false);
    expect(again.restored).toEqual([f]);
    expect(again.changedAfter).toEqual([]);
  });
});

describe('restore × 索引篡改（path 与 blob 都必须过护栏）', () => {
  const tamper = (session: string, mutate: (idx: any) => void) => {
    const idxFile = path.join(storeRoot, session, 'index.json');
    const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    mutate(idx);
    fs.writeFileSync(idxFile, JSON.stringify(idx), 'utf8');
  };

  it('blob 被改成目录穿越 -> 拒绝读取（只校验 path 等于留了半扇门）', () => {
    const s = mk();
    const inside = file('safe.txt');
    fs.writeFileSync(inside, 'v', 'utf8');
    s.record('sess1', inside, 'original', 'written');
    tamper('sess1', (idx) => {
      idx.entries[0].blob = '../../../../Windows/win.ini';
    });
    fs.writeFileSync(inside, 'written', 'utf8'); // 否则先被指纹挡下，测不到 blob 这道闸

    const r = s.restore('sess1', () => false);
    expect(r.restored).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].error).toContain('不合法');
  });

  it('isSafeBlobName 只放行记录侧真正会产出的形状', () => {
    expect(isSafeBlobName('blob_0001.snap')).toBe(true);
    expect(isSafeBlobName('blob_12.snap')).toBe(true);
    expect(isSafeBlobName('blob_0001.snap.bak')).toBe(false);
    expect(isSafeBlobName('../index.json')).toBe(false);
    expect(isSafeBlobName('C:\\x\\blob_0001.snap')).toBe(false);
    expect(isSafeBlobName('blob_0001.txt')).toBe(false);
  });
});
