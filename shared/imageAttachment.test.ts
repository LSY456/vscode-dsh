import { describe, expect, it } from 'vitest';
import { base64ByteLength, formatBytes, sanitizeImageAttachments } from './imageAttachment';
import { MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL_BYTES, MAX_IMAGES_PER_MESSAGE } from './protocol';

/** 一张 8 字节的"真"PNG 头（`89 50 4E 47 0D 0A 1A 0A`）的 base64，长度恰好 12。 */
const PNG8 = 'iVBORw0KGgo=';
/**
 * 造一段 base64，使解码后**恰好** `bytes` 字节 —— 边界用例（"刚好等于上限"）
 * 必须精确到字节，靠 4/3 心算会差一两个，那正好落在 `>` / `>=` 的分界上。
 * 每 4 字符一组、每组 3 字节，故组数 `k = ceil(bytes / 3)`，多出来的用补齐符消掉。
 */
function b64OfBytes(bytes: number): string {
  const k = Math.ceil(bytes / 3);
  const body = 'A'.repeat(k * 4);
  const pad = 3 * k - bytes; // 0 / 1 / 2
  return pad === 0 ? body : body.slice(0, body.length - pad) + '='.repeat(pad);
}
const img = (over: Record<string, unknown> = {}) => ({
  mimeType: 'image/png',
  dataBase64: PNG8,
  ...over,
});

describe('base64ByteLength：不采信调用方声明的体积', () => {
  it('每 4 个字符 3 字节，补齐符要扣掉', () => {
    expect(base64ByteLength('AAAA')).toBe(3);
    expect(base64ByteLength('AAA=')).toBe(2);
    expect(base64ByteLength('AA==')).toBe(1);
    expect(base64ByteLength('')).toBe(0);
    expect(base64ByteLength(PNG8)).toBe(8);
  });

  it('比 `length * 3 / 4` 小：后者在有补齐时会高估 1–2 字节', () => {
    expect(base64ByteLength('AA==')).toBeLessThan((4 * 3) / 4);
  });
});

describe('formatBytes：只出现在拒绝文案里，所以必须是人话', () => {
  it('B / KB / MB 三档', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(MAX_IMAGE_BYTES)).toBe('5.0 MB');
  });
});

describe('sanitizeImageAttachments：全有或全无', () => {
  it('没传 / 空数组：都是"没有图片"，不是错误', () => {
    expect(sanitizeImageAttachments(undefined)).toEqual({ ok: true, images: [] });
    expect(sanitizeImageAttachments(null)).toEqual({ ok: true, images: [] });
    expect(sanitizeImageAttachments([])).toEqual({ ok: true, images: [] });
  });

  it('不是数组 -> 明确拒绝（不静默当作没有图片）', () => {
    const r = sanitizeImageAttachments({ mimeType: 'image/png' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('数组');
  });

  it('合规图片：产出 Attachment，体积用算出来的而不是声明的', () => {
    const r = sanitizeImageAttachments([
      img({ name: '  shot.png  ', sizeBytes: 999999, clientId: ' c1 ', extra: '忽略我' }),
    ]);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.images).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        dataBase64: PNG8,
        sizeBytes: 8, // 声明的 999999 被丢弃
        name: 'shot.png', // 前后空白被 trim
        clientId: 'c1',
      },
    ]);
  });

  it('name / clientId 为空或空白时不产生空字段（留空即"没有"，不是空串）', () => {
    const r = sanitizeImageAttachments([img({ name: '   ', clientId: '' })]);
    expect(r.ok).toBe(true);
    const first = r.ok === true ? r.images[0] : undefined;
    expect(first && 'name' in first).toBe(false);
    expect(first && 'clientId' in first).toBe(false);
  });

  it('顺序被保留（daemon 靠顺序对齐 [图片 N] 位置标记）', () => {
    const r = sanitizeImageAttachments([
      img({ name: 'a.png', clientId: 'a' }),
      img({ mimeType: 'image/jpeg', name: 'b.jpg', clientId: 'b' }),
    ]);
    expect(r.ok === true && r.images.map((i) => i.clientId)).toEqual(['a', 'b']);
  });

  it('MIME 白名单：白名单外一律拒绝并说明支持哪些', () => {
    for (const bad of ['image/svg+xml', 'image/bmp', 'image/png ', 'IMAGE/PNG', '', undefined, 42]) {
      const r = sanitizeImageAttachments([img({ mimeType: bad })]);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain('不支持');
    }
  });

  it('数组里混入脏元素（null / 非对象）不会崩，按"第 N 张不合规"拒绝', () => {
    const r = sanitizeImageAttachments([img(), null]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('第 2 张');
  });

  it('张数上限：超过即整体拒绝，并报出当前张数', () => {
    const many = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => img());
    const r = sanitizeImageAttachments(many);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain(String(MAX_IMAGES_PER_MESSAGE));
    expect(r.ok === false && r.reason).toContain(String(MAX_IMAGES_PER_MESSAGE + 1));
  });

  it('恰好等于上限时放行（边界不能用 > 写成 >=）', () => {
    const exact = Array.from({ length: MAX_IMAGES_PER_MESSAGE }, () => img());
    expect(sanitizeImageAttachments(exact).ok).toBe(true);
  });

  it('内容缺失 / 空串 -> "没有内容"', () => {
    for (const bad of [undefined, null, '', 123]) {
      const r = sanitizeImageAttachments([img({ dataBase64: bad })]);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain('没有内容');
    }
  });

  it('base64 形状：拒绝换行、空白、base64url 的 `-_`、以及长度非 4 的倍数', () => {
    // 带换行是**最需要拦**的一种：JSON 里合法，但上游会按"损坏的图片"处理
    for (const bad of ['iVBORw0K\nGgo=', ' iVBORw0KGgo=', 'iVBORw0KGgo', 'iVBORw0K-go=', 'iVBORw0K_go=', 'AAAA=']) {
      const r = sanitizeImageAttachments([img({ dataBase64: bad })]);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain('base64');
    }
  });

  it('单张超限 -> 报体积与上限，并给出"裁剪或压缩"的下一步动作', () => {
    const r = sanitizeImageAttachments([img({ dataBase64: b64OfBytes(MAX_IMAGE_BYTES + 65536) })]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('单张上限');
    expect(r.ok === false && r.reason).toContain('裁剪');
  });

  it('声明的体积很小也不能让超限图片过关（体积以实测为准）', () => {
    const r = sanitizeImageAttachments([
      { mimeType: 'image/png', dataBase64: b64OfBytes(MAX_IMAGE_BYTES + 65536), sizeBytes: 1 },
    ]);
    expect(r.ok).toBe(false);
  });

  it('总计超限 -> 与单张超限给出**不同**的文案（该删哪张 / 该压一下）', () => {
    // 每张 3.3MB（单张合规），四张合计 13.2MB > 12MB
    const each = b64OfBytes(3_300_000);
    const r = sanitizeImageAttachments(Array.from({ length: 4 }, () => img({ dataBase64: each })));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('合计');
    expect(r.ok === false && r.reason).toContain('张数');
    expect(r.ok === false && r.reason).not.toContain('单张上限');
  });

  it('单张刚好到上限时放行（累计判定不能把 `<=` 写成 `<`）', () => {
    const r = sanitizeImageAttachments([img({ dataBase64: b64OfBytes(MAX_IMAGE_BYTES) })]);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.images[0].sizeBytes).toBe(MAX_IMAGE_BYTES);
  });

  it('总量上限常量确实是 4 张单张上限的收敛（否则 4 张压线能撑到 20MB）', () => {
    expect(MAX_IMAGE_TOTAL_BYTES).toBeLessThan(MAX_IMAGES_PER_MESSAGE * MAX_IMAGE_BYTES);
  });
});
