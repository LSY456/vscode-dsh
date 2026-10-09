/**
 * 图片附件的校验与规范化：**唯一实现**，扩展侧与 daemon 侧共用。
 *
 * 为什么不是"扩展侧校验一次就够了"：daemon 是安全边界，它面对的不只有本扩展 ——
 * 协议允许任意客户端接入（`examples/python-daemon` 就是活证据）。凡是**要发给模型**的内容，
 * 就必须在真正使用它的那一刻再校验一次，而不是信任上游已经做过。
 *
 * 纯函数、不依赖 vscode、不碰文件系统。图片字节全程只以 base64 存在于消息里，
 * 因此它天然比 file/selection 那类附件少一整类风险 —— **没有路径可以逃逸**，
 * 唯一的攻击面是"体积"和"格式"。
 */

import {
  IMAGE_MIME_TYPES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_TOTAL_BYTES,
  type Attachment,
  type ImageMimeType,
} from './protocol';

/** 待校验的图片（来自不可信输入，字段一律可选、类型一律可疑）。 */
export interface ImageAttachmentInput {
  mimeType?: unknown;
  dataBase64?: unknown;
  name?: unknown;
  sizeBytes?: unknown;
  clientId?: unknown;
}

export type SanitizeImagesResult =
  | { ok: true; images: Attachment[] }
  | { ok: false; reason: string };

/** base64 形状：字母表白名单 + 至多两个补齐符。分行/空白/base64url 的 `-_` 一律不接受。 */
const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * 从 base64 长度反推原始字节数。
 *
 * 不采信调用方给的 `sizeBytes`：它既可能是过期的，也可能是编的，而窗口大小直接由它决定。
 * base64 每 4 个字符表示 3 字节，减去补齐符才是真实长度（`length * 3 / 4` 会高估 1–2 字节）。
 */
export function base64ByteLength(dataBase64: string): number {
  const padding = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0;
  return Math.floor((dataBase64.length * 3) / 4) - padding;
}

function isImageMimeType(v: unknown): v is ImageMimeType {
  return typeof v === 'string' && (IMAGE_MIME_TYPES as readonly string[]).includes(v);
}

/**
 * 校验并规范化图片附件。
 *
 * 语义是**全有或全无**：任何一张不合规就整体拒绝并给出具体原因，而不是丢掉那张、
 * 把剩下的发出去。理由是这类消息的图片通常**就是提问本身**（"看这个报错截图"）——
 * 静默少发一张会让模型对着一张根本不存在的图作答，用户拿到的是一段看起来正常的胡话；
 * 而"明确告诉你第 2 张没附上、为什么"最多只是让用户重发一次。
 *
 * 限额判定用的是**逐个累计**的真实字节数（见 `base64ByteLength`），
 * 因此单张超限与总量超限各自有明确文案，用户知道该删哪张、还是该压一下。
 */
export function sanitizeImageAttachments(raw: unknown): SanitizeImagesResult {
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: '图片附件格式不正确（应为数组）' };
  if (raw.length === 0) return { ok: true, images: [] };
  if (raw.length > MAX_IMAGES_PER_MESSAGE) {
    return {
      ok: false,
      reason: `一条消息最多附带 ${MAX_IMAGES_PER_MESSAGE} 张图片（当前 ${raw.length} 张）`,
    };
  }

  const images: Attachment[] = [];
  let total = 0;

  for (let i = 0; i < raw.length; i++) {
    const at = `第 ${i + 1} 张图片`;
    const item = (raw[i] ?? {}) as ImageAttachmentInput;

    if (!isImageMimeType(item.mimeType)) {
      return {
        ok: false,
        reason: `${at}的格式不支持（仅支持 ${IMAGE_MIME_TYPES.join(' / ')}）`,
      };
    }
    const b64 = item.dataBase64;
    if (typeof b64 !== 'string' || b64.length === 0) {
      return { ok: false, reason: `${at}没有内容` };
    }
    // 先查形状再查长度：`/^[A-Za-z0-9+/]+={0,2}$/` 已经排除空白与换行，
    // 而带换行的 base64 塞进 JSON 请求体虽然合法、却会让上游按"损坏的图片"处理。
    if (!BASE64_SHAPE.test(b64) || b64.length % 4 !== 0) {
      return { ok: false, reason: `${at}的内容不是合法的 base64` };
    }

    const bytes = base64ByteLength(b64);
    if (bytes === 0) return { ok: false, reason: `${at}没有内容` };
    if (bytes > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        reason:
          `${at}过大（${formatBytes(bytes)}，单张上限 ${formatBytes(MAX_IMAGE_BYTES)}）。` +
          '请裁剪或压缩后再发。',
      };
    }
    total += bytes;
    if (total > MAX_IMAGE_TOTAL_BYTES) {
      return {
        ok: false,
        reason: `本次附带的图片合计过大（上限 ${formatBytes(MAX_IMAGE_TOTAL_BYTES)}）。请减少张数。`,
      };
    }

    images.push({
      kind: 'image',
      mimeType: item.mimeType,
      dataBase64: b64,
      // 用算出来的值，不用调用方声明的那个
      sizeBytes: bytes,
      ...(typeof item.name === 'string' && item.name.trim() ? { name: item.name.trim() } : {}),
      ...(typeof item.clientId === 'string' && item.clientId.trim()
        ? { clientId: item.clientId.trim() }
        : {}),
    });
  }

  return { ok: true, images };
}

/** 人类可读的体积（用于报错文案；只在拒绝路径上用到）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
