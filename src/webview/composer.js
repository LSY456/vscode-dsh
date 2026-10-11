/**
 * 输入区与图片附件（批次 8 从 media/webview.js 抽出）。
 *
 * 三条图片输入路径（粘贴 / 拖放 / 选择文件）最终都汇到 stageImageFiles()：
 * 一处实现、一处限额、一处降采样。粘贴截图的用法最常见，因此它是默认入口 ——
 * 输入框的 placeholder 与按钮 title 都明说了这件事。
 *
 * 图片相关状态（暂存 / 已发缩略图 / 在途 clientId）也归本模块，`addUser` 渲染回显 chip 时
 * 通过 `state.sentImagePreviews` 读缩略图（同一个共享 state 对象，见 panelCore.js 的说明）。
 */
import { IMAGE_MIME_TYPES, MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES } from '../../shared/protocol.ts';

/**
 * 处理前的源文件上限。它**不是**协议限额，只是"别把一张 80MB 的原图读进内存再解码"的护栏；
 * 真正的限额判定在 sanitizeImageAttachments（扩展与 daemon 各做一次，见 shared/imageAttachment.ts）。
 */
const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
/**
 * 降采样目标长边。1568 是 Anthropic 的处理上限 —— 比它更大的图上游会自己缩掉，
 * 我们先付一份 base64、再让上游丢一半像素，等于白花 token；先缩到同一尺寸，
 * 代价与结果都可预期。OpenAI 兼容端没有公开上限，按同一尺寸处理不会有坏处。
 */
const IMAGE_LONG_EDGE = 1568;
/** 缩略图长边。缩略图要长期留在 DOM 里，所以单独做小一份（原图会随消息一直驻留）。 */
const PREVIEW_LONG_EDGE = 240;

export function createComposer(ctx) {
  const { el, $, vscode, dom, state, api } = ctx;
  const { inputEl, btnPlanMode, composerHint } = dom;

  // -------------------------------------------------------------------------
  // 图片附件（P2-4）
  // -------------------------------------------------------------------------

  /** base64 长度 → 原始字节数（每 4 字符 3 字节，减去补齐符）。 */
  function bytesOfBase64(b64) {
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.floor((b64.length * 3) / 4) - pad;
  }

  /** data URL 里逗号之后的部分就是 base64 本体。 */
  function base64Of(dataUrl) {
    const at = dataUrl.indexOf(',');
    return at >= 0 ? dataUrl.slice(at + 1) : '';
  }

  /**
   * 本环境能不能真的做图像处理（解码 + canvas 缩放）。
   *
   * jsdom（面板契约测试 / UI 预览）里 canvas 是空壳、图片也永远不会触发 onload ——
   * 与其在那里等一个永不到来的回调（测试会挂住），不如先认出来，直接走"原样发送"。
   */
  function canProcessImages() {
    // 取 window.navigator 而不是裸 navigator：预览脚本在 Node 里搭建 jsdom 环境，
    // 那里的裸 navigator 是 Node 自己的（userAgent 不含 jsdom），只有 window 上那份才说得准。
    const ua =
      (typeof window !== 'undefined' && window.navigator && window.navigator.userAgent) || '';
    if (/jsdom/i.test(ua)) return false;
    return typeof Image !== 'undefined';
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
  }

  function decodeImage(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  /** 等比缩放到长边 ≤ longEdge 并重新编码；无法处理（canvas 不可用 / 尺寸未知）时返回 null。 */
  function drawScaled(img, longEdge, mimeType, quality) {
    const srcW = img.naturalWidth || img.width || 0;
    const srcH = img.naturalHeight || img.height || 0;
    if (!srcW || !srcH) return null;
    try {
      const scale = Math.min(1, longEdge / Math.max(srcW, srcH));
      const w = Math.max(1, Math.round(srcW * scale));
      const h = Math.max(1, Math.round(srcH * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const c = canvas.getContext('2d');
      if (!c) return null;
      c.drawImage(img, 0, 0, w, h);
      const url = canvas.toDataURL(mimeType, quality);
      return url && url.startsWith('data:') ? url : null;
    } catch {
      return null;
    }
  }

  /**
   * 把一个 File 加工并暂存。返回 null 表示成功，否则返回给用户看的原因。
   *
   * 用"返回原因"而不是抛异常：多张图里某一张不合格时，剩下的仍应照常暂存，
   * 用户需要知道的只是"哪一张、为什么"，而不是整批失败。
   */
  async function stageImageFile(file) {
    if (state.stagedImages.length >= MAX_IMAGES_PER_MESSAGE) {
      return `最多只能附加 ${MAX_IMAGES_PER_MESSAGE} 张图片`;
    }
    const mimeType = String(file.type || '').toLowerCase();
    if (!IMAGE_MIME_TYPES.includes(mimeType)) {
      return `不支持的图片格式：${file.name || mimeType || '未知'}（仅支持 ${IMAGE_MIME_TYPES.join(' / ')}）`;
    }
    if (file.size > MAX_SOURCE_IMAGE_BYTES) {
      return `${file.name || '图片'} 过大（${(file.size / 1048576).toFixed(1)} MB）`;
    }

    let originalUrl;
    try {
      originalUrl = await readAsDataUrl(file);
    } catch (err) {
      return `${file.name || '图片'} 读取失败：${err instanceof Error ? err.message : String(err)}`;
    }

    // 默认原样发送；下面能缩才缩。
    let outUrl = originalUrl;
    let previewUrl = null;
    if (canProcessImages()) {
      const img = await decodeImage(originalUrl);
      if (img && mimeType !== 'image/gif') {
        // GIF 一动就丢了动画 —— 宁可原样发（大一点），也不要把动图缩成一张静帧。
        const originalBytes = bytesOfBase64(base64Of(originalUrl));
        const longEdge = Math.max(img.naturalWidth || 0, img.naturalHeight || 0);
        const scaled =
          longEdge > IMAGE_LONG_EDGE || originalBytes > MAX_IMAGE_BYTES
            ? drawScaled(img, IMAGE_LONG_EDGE, mimeType, mimeType === 'image/jpeg' ? 0.85 : undefined)
            : null;
        // 只在**确实变小**时才采用：小图重编码后可能反而更大（PNG 尤其），那就白折腾一趟。
        if (scaled && bytesOfBase64(base64Of(scaled)) < originalBytes) outUrl = scaled;
      }
      if (img) previewUrl = drawScaled(img, PREVIEW_LONG_EDGE, 'image/png', undefined);
    }

    const dataBase64 = base64Of(outUrl);
    state.stagedImages.push({
      id: 'img' + ++state.imageSeq + '_' + Date.now(),
      name: file.name || '粘贴的图片',
      mimeType,
      dataBase64,
      sizeBytes: bytesOfBase64(dataBase64),
      // 缩略图取不到就退回原图：宁可多占一点内存，也不能让用户看不到自己附了什么。
      previewUrl: previewUrl || outUrl,
    });
    return null;
  }

  /** 批量暂存：逐个报告失败原因，成功的照常进去。 */
  async function stageImageFiles(files) {
    const problems = [];
    for (const f of Array.from(files || [])) {
      const reason = await stageImageFile(f);
      if (reason) problems.push(reason);
    }
    renderStaging();
    if (problems.length) showComposerNotice(problems.join('；'));
  }

  function showComposerNotice(text) {
    const notice = $('composer-notice');
    if (!notice) return;
    notice.textContent = text;
    notice.hidden = false;
    if (state.noticeTimer) clearTimeout(state.noticeTimer);
    // 自动消失，但**不自动清空暂存**：提示说的是"哪张没进去"，用户要据此决定是删是换。
    state.noticeTimer = setTimeout(() => {
      notice.hidden = true;
      notice.textContent = '';
    }, 8000);
  }

  function renderStaging() {
    const box = $('image-staging');
    if (!box) return;
    box.textContent = '';
    box.hidden = state.stagedImages.length === 0;
    for (const img of state.stagedImages) {
      const thumb = el('div', 'image-thumb');
      const pic = document.createElement('img');
      pic.src = img.previewUrl; // data: URL —— CSP 的 img-src data: 已放行
      pic.alt = img.name;
      const sizeText = img.sizeBytes >= 1024 ? `${(img.sizeBytes / 1024).toFixed(0)} KB` : `${img.sizeBytes} B`;
      pic.title = `${img.name}（${sizeText}）`;
      const del = el('button', 'image-remove', '×');
      del.type = 'button';
      del.title = '移除这张图片';
      del.setAttribute('aria-label', `移除 ${img.name}`);
      del.addEventListener('click', () => removeStagedImage(img.id));
      thumb.append(pic, del);
      box.appendChild(thumb);
    }
  }

  function removeStagedImage(id) {
    const at = state.stagedImages.findIndex((i) => i.id === id);
    if (at >= 0) state.stagedImages.splice(at, 1);
    renderStaging();
  }

  function clearStagedImages() {
    if (state.stagedImages.length) {
      state.stagedImages.length = 0;
      renderStaging();
    }
    state.inFlightImageIds = [];
  }

  /** 装发送载荷（不含预览：缩略图留在面板本地，不回传扩展）。 */
  function collectStagedImages() {
    state.inFlightImageIds = state.stagedImages.map((i) => i.id);
    return state.stagedImages.map((i) => ({
      clientId: i.id,
      name: i.name,
      mimeType: i.mimeType,
      dataBase64: i.dataBase64,
      sizeBytes: i.sizeBytes,
    }));
  }

  /**
   * 扩展确认收到这条消息（user.message 回显）后才提交暂存。
   *
   * 顺序很关键：如果"点发送"就清空，扩展一旦拒绝（图片超标）用户就得重新粘一遍，
   * 而那张图往往正是问题本身。所以**等到回显**再清，失败时暂存还在。
   */
  function commitStagedImages() {
    const ids = state.inFlightImageIds;
    state.inFlightImageIds = [];
    if (ids.length === 0) return;
    const remainPreviews = [];
    for (const img of state.stagedImages) {
      remainPreviews.push(img);
    }
    for (const img of remainPreviews) {
      if (ids.includes(img.id)) state.sentImagePreviews.set(img.id, img.previewUrl);
    }
    const keep = state.stagedImages.filter((i) => !ids.includes(i.id));
    state.stagedImages.length = 0;
    state.stagedImages.push(...keep);
    renderStaging();
  }

  /** 会话级重置时清空图片现场（暂存 + 已发缩略图）。 */
  function clearComposer() {
    clearStagedImages();
    state.sentImagePreviews.clear();
  }

  // -------------------------------------------------------------------------
  // 发送 / 取消 / 计划开关
  // -------------------------------------------------------------------------

  function send() {
    const text = inputEl.value.trim();
    const images = collectStagedImages();
    // 允许"只发图不写字"：粘一张报错截图然后直接回车是很常见的用法，
    // 要求必须凑一句文字只会让人把图存下来再翻回去贴。
    if ((!text && images.length === 0) || state.running) {
      state.inFlightImageIds = [];
      return;
    }
    inputEl.value = '';
    autosizeInput();
    api.setRunning(true);
    // 不在本地回显：扩展侧会带上下文 chip 回发 user.message，避免出现两条重复消息
    vscode.postMessage({ kind: 'send', prompt: text, planMode: state.planModeEnabled, images });
  }

  /** 计划开关：只切换本地状态 + 视觉，真正的语义由 send() 带在消息里。 */
  function setPlanMode(on) {
    state.planModeEnabled = !!on;
    if (!btnPlanMode) return;
    btnPlanMode.classList.toggle('on', state.planModeEnabled);
    btnPlanMode.setAttribute('aria-pressed', state.planModeEnabled ? 'true' : 'false');
    btnPlanMode.title = state.planModeEnabled
      ? '计划模式：本轮先给方案，你批准后才执行（点击关闭）'
      : '计划模式：先给方案、批准后执行';
  }

  function cancel() {
    if (!state.running) return;
    composerHint.textContent = '正在停止…';
    vscode.postMessage({ kind: 'cancel' });
  }

  function autosizeInput() {
    inputEl.style.height = 'auto';
    const h = Math.min(inputEl.scrollHeight, 180);
    inputEl.style.height = h + 'px';
  }

  /** 从 DataTransfer / ClipboardData 里挑出图片文件。 */
  function imageFilesFrom(data) {
    if (!data) return [];
    const out = [];
    const files = data.files ? Array.from(data.files) : [];
    for (const f of files) if (String(f.type || '').startsWith('image/')) out.push(f);
    // 剪贴板截图在部分平台上只出现在 items 里，files 是空的
    if (out.length === 0 && data.items) {
      for (const it of Array.from(data.items)) {
        if (it.kind === 'file' && String(it.type || '').startsWith('image/')) {
          const f = it.getAsFile && it.getAsFile();
          if (f) out.push(f);
        }
      }
    }
    return out;
  }

  return {
    stageImageFiles,
    imageFilesFrom,
    commitStagedImages,
    clearComposer,
    send,
    cancel,
    setPlanMode,
    autosizeInput,
  };
}
