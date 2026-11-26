/* =====================================================================
 *  Socratopia v0 · 图片输入（粘贴 / 拖入 / 选文件 → 多模态消息）
 *  20260916.1 新建。
 *
 *  为什么单独成模块：这条链路上真正会出错的判断全是纯逻辑 ——
 *    「这次粘贴该不该挂图」「缩放后多大」「一块内容怎么拼」「哪些能落盘」
 *  而它们此前一个都没法单测（app.js 是 IIFE + DOM 依赖）。搬进来后配合
 *  js/image-input.test.mjs 直接钉死，这比省行数重要。
 *
 *  与 js/api.js 的分工（刻意不重叠）：
 *    本模块只负责「把用户消息变成 OpenAI 兼容的 content 块」，
 *    **完全不碰 fetch**。js/api.js 至今不知道图片的存在 ——
 *    payload 的 messages 里出现数组 content，对它来说也只是 JSON 的一部分。
 *    这样「传输层」与「输入形态」互不耦合，将来换 vision 模型 / 换 provider
 *    都不必动 api.js。
 *
 *  数据模型（挂在消息对象上，content 始终保持字符串）：
 *    msg.images = [{ full?, thumb, w, h, bytes }]
 *      · full  —— 原图 dataURL。**只活在内存里**，落盘前由 stripImagesForStorage 剥掉。
 *                 理由同头像（当年压到 256px 就是为这个）：base64 进 localStorage
 *                 会直接吃掉 5MB 配额，教材库那套已经够紧张了。
 *      · thumb —— 缩略图（~320px），落盘，用于刷新后仍能看见"当时发过什么图"。
 *    msg.imagesBlocked = true —— 该模型不收图（400）时打的记号，
 *      之后 toApiMessage 不再把图发出去，改为文字说明，避免每轮都撞同一堵墙。
 * ===================================================================== */

/** 一条消息最多带几张图。4 张够覆盖「这道题 + 我的草稿 + 选项页 + 答案页」。 */
export const MAX_IMAGES = 4;

/* 缩放到多大再上传。1024 是折中：再大对"截图里的小字"未必有增益，
   因为上游给每张图的输入预算只有几百 token，服务端大概率还会再缩一次；
   再小则截图里的公式/下标开始糊。改这一个常量即可整体调档。 */
export const IMAGE_MAX_DIM = 1024;
/** 落盘缩略图的长边。320 张张加起来也才几 KB 一张，配额吃得消。 */
export const IMAGE_THUMB_DIM = 320;
export const IMAGE_QUALITY = 0.85;
export const THUMB_QUALITY = 0.7;
/** 单张图按多少 token 计入「老师精力」。上游按"每图上限 384 token"计费与限流。 */
export const IMAGE_TOKEN_EST = 384;

/** 图片 MIME 判定（只看类型字段，不看扩展名）。 */
export function isImageType(mime) {
  return /^image\//i.test(String(mime == null ? "" : mime));
}

/** 从文件列表里挑出图片。接受 File[] / FileList / 其它可迭代对象。 */
export function pickImageFiles(list) {
  const out = [];
  if (!list) return out;
  const n = list.length || 0;
  for (let i = 0; i < n; i++) {
    const f = list[i];
    if (f && isImageType(f.type)) out.push(f);
  }
  return out;
}

/**
 * 从 DataTransfer 取文件。拖放与粘贴的取法不同：
 *  - 拖文件：dt.files 里直接有
 *  - 粘贴图片：要遍历 dt.items 逐个 getAsFile()
 * 两条都试，谁先给出结果用谁（不合并，避免同一张图出现两次）。
 */
export function filesFromDataTransfer(dt) {
  const out = [];
  if (!dt) return out;
  const items = dt.items;
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it && it.kind === "file" && typeof it.getAsFile === "function") {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  if (out.length) return out;
  const files = dt.files;
  if (files && files.length) {
    for (let i = 0; i < files.length; i++) if (files[i]) out.push(files[i]);
  }
  return out;
}

/**
 * 这次粘贴要不要挂图。
 * 关键在「有文字就不挂」这条：从网页/Word 里复制一段选中的文字时，剪贴板
 * 常常同时带一份位图（text/html + image/png）。若"见图就挂"，用户只是复制
 * 一句话，输入框就凭空多出一张图并计入 token —— 这种"好心"最招人烦。
 * 判定：剪贴板里【没有可用的纯文本】且【有图片】时，才当作"粘贴了一张图"。
 * @param {{hasImageFiles:boolean, plainText:string}} info
 */
export function shouldAttachFromPaste(info) {
  const it = info || {};
  if (!it.hasImageFiles) return false;
  return !String(it.plainText == null ? "" : it.plainText).trim();
}

/**
 * 等比缩放到 maxDim 以内。**只缩不放**（原图本来就小就原样返回），
 * 避免把小图放大成糊的大图还多付 token。
 * @returns {{width:number, height:number, scaled:boolean}}
 */
export function fitSize(w, h, maxDim) {
  const W = Number(w), H = Number(h), M = Number(maxDim);
  if (!isFinite(W) || !isFinite(H) || !isFinite(M) || W <= 0 || H <= 0 || M <= 0) {
    return { width: 1, height: 1, scaled: false, invalid: true };
  }
  const longest = Math.max(W, H);
  if (longest <= M) return { width: Math.round(W), height: Math.round(H), scaled: false, invalid: false };
  const k = M / longest;
  return { width: Math.max(1, Math.round(W * k)), height: Math.max(1, Math.round(H * k)), scaled: true, invalid: false };
}

/**
 * 按剩余容量切分待加入的图片。
 * @returns {{accepted:Array, dropped:Array}}
 */
export function splitByCapacity(existingCount, incoming, max) {
  const list = (incoming || []).slice();
  const cap = Number(max) || 0;
  const used = Math.max(0, Number(existingCount) || 0);
  const room = Math.max(0, cap - used);
  return { accepted: list.slice(0, room), dropped: list.slice(room) };
}

/**
 * 只接受本应用自己产出的 dataURL（canvas.toDataURL 的形态）。
 * 与 app.js 的 getAvatar 白名单同源：图片 URL 会被拼进 <img src="...">，
 * 而「导入配置」能把任意字符串写进 localStorage —— 带引号的 payload 足以
 * 闭合属性注入事件处理器。宁可少渲染一张图，也不开这个口子。
 */
export function isSafeImageDataUrl(v) {
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(String(v == null ? "" : v));
}

/** 可发送的图（本次会话内原图还在内存里的那些）。 */
export function sendableUrls(images) {
  return (images || [])
    .map((i) => (i && i.full) || "")
    .filter((u) => isSafeImageDataUrl(u));
}

/** 用于渲染的图（优先缩略图，兼容只有原图的老数据）。 */
export function displayableUrls(images) {
  const out = [];
  (images || []).forEach((i) => {
    if (!i) return;
    const u = i.thumb || i.full || "";
    if (isSafeImageDataUrl(u)) out.push(u);
  });
  return out;
}

/**
 * 拼 OpenAI 兼容的多模态 content。
 * 无图 → 原样返回字符串（这条分支必须存在：绝大多数消息都是纯文字，
 * 不该因为它们被包成数组，而破坏上游对 content 的既有处理）。
 * 有图 → [{type:"text"},{type:"image_url"},...]，文字在前。
 */
export function buildVisionContent(text, urls) {
  const t = String(text == null ? "" : text);
  const ok = (urls || []).filter((u) => isSafeImageDataUrl(u));
  if (!ok.length) return t;
  const blocks = ok.map((u) => ({ type: "image_url", image_url: { url: u } }));
  if (t) blocks.unshift({ type: "text", text: t });
  return blocks;
}

/**
 * 把一条内部消息转成发给模型的消息。
 * 只有 user 消息会带图 —— 上游对 system/assistant 带图直接 400，
 * 这里即便数据被人为写坏也不放行。
 */
export function toApiMessage(m) {
  const msg = m || {};
  const role = msg.role;
  const text = String(msg.content == null ? "" : msg.content);
  const images = msg.images || [];
  if (role !== "user" || !images.length) return { role, content: text };

  if (msg.imagesBlocked) {
    return {
      role,
      content: (text ? text + "\n" : "") +
        "（这一轮我附了 " + images.length + " 张图片，但当前模型收不了图，所以图片没有发出去。）",
    };
  }
  const urls = sendableUrls(images);
  if (!urls.length) {
    // 刷新后原图已释放（只留在内存里、从不落盘）：明说，免得老师"看不见图还硬答"
    return {
      role,
      content: (text ? text + "\n" : "") +
        "（这一轮我附了 " + images.length + " 张图片，但图片在刷新页面时已释放，我这边也看不清了。）",
    };
  }
  return { role, content: buildVisionContent(text, urls) };
}

/** 批量转换（历史消息 → API 消息）。 */
export function toApiMessages(msgs) {
  return (msgs || []).map(toApiMessage);
}

/**
 * 落盘前的瘦身：剥掉 full（原图），只留 thumb / w / h。
 * 没有图的消息原样返回**同一个对象引用** —— cleanChatMessages 会在它上面
 * 补 speaker 字段，克隆会让那次写入丢失。
 */
export function stripImagesForStorage(m) {
  const msg = m || {};
  if (!Array.isArray(msg.images) || !msg.images.length) return m;
  const copy = Object.assign({}, msg);
  copy.images = msg.images.map((i) => ({
    thumb: (i && isSafeImageDataUrl(i.thumb)) ? i.thumb : "",
    w: (i && i.w) || 0,
    h: (i && i.h) || 0,
  }));
  return copy;
}

/** 这些消息里的图片会占多少 token（用于「老师精力」与发送前自动精简）。 */
export function countImageTokens(msgs, per) {
  const unit = Number(per) > 0 ? Number(per) : IMAGE_TOKEN_EST;
  let n = 0;
  (msgs || []).forEach((m) => {
    const msg = m || {};
    if (msg.imagesBlocked) return; // 不发出去的图，不该占预算
    n += sendableUrls(msg.images).length * unit;
  });
  return n;
}

/** 人类可读的体量，用于图片角标。 */
export function humanBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return Math.round(v / 1024) + " KB";
  return (v / 1024 / 1024).toFixed(1) + " MB";
}
