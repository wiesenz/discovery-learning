/* =====================================================================
 *  Socratopia v0 · js/image-input.js 的单元测试（node js/image-input.test.mjs）
 *  ---------------------------------------------------------------------
 *  这里钉的是「粘贴图片」这条链路上**最容易悄悄做错**的四类判断：
 *    1. 这次粘贴到底该不该挂图（从网页复制一段文字不能顺带挂图）
 *    2. 缩放只缩不放（小图放大＝白付 token 还糊）
 *    3. 发给模型的消息里，只有 user 能带图
 *    4. 落盘时必须剥掉原图（否则 base64 会吃掉 localStorage 配额）
 *  用假 File / 假 DataTransfer，不依赖 DOM 与 canvas。
 * ===================================================================== */
import {
  MAX_IMAGES, IMAGE_MAX_DIM, IMAGE_THUMB_DIM, IMAGE_TOKEN_EST,
  isImageType, pickImageFiles, filesFromDataTransfer, shouldAttachFromPaste,
  fitSize, splitByCapacity, isSafeImageDataUrl, sendableUrls, displayableUrls,
  buildVisionContent, toApiMessage, toApiMessages, stripImagesForStorage,
  countImageTokens, humanBytes,
} from "./image-input.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}
function eq(name, a, b) { ok(name + " (得到 " + JSON.stringify(a) + ")", a === b); }
function deepEq(name, a, b) { eq(name, JSON.stringify(a), JSON.stringify(b)); }

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
function fakeFile(type, name) { return { type, name: name || "f", size: 1234 }; }

console.log("isImageType / pickImageFiles");
{
  ok("image/png 是图", isImageType("image/png"));
  ok("IMAGE/PNG 大小写不敏感", isImageType("IMAGE/PNG"));
  ok("text/plain 不是图", !isImageType("text/plain"));
  ok("空值不炸", !isImageType(null) && !isImageType(undefined) && !isImageType(""));
  deepEq("混合列表只留图片，且保持顺序",
    pickImageFiles([fakeFile("text/plain", "a.txt"), fakeFile("image/png", "b.png"), fakeFile("image/webp", "c.webp")])
      .map((f) => f.name),
    ["b.png", "c.webp"]);
  eq("无输入返回空数组", pickImageFiles(null).length, 0);
}

console.log("filesFromDataTransfer —— 拖放走 files，粘贴走 items");
{
  const dropped = { files: [fakeFile("image/png", "drop.png"), fakeFile("application/pdf", "x.pdf")] };
  deepEq("拖入文件：从 dt.files 取", filesFromDataTransfer(dropped).map((f) => f.name), ["drop.png", "x.pdf"]);

  const pasted = {
    items: [
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "file", type: "image/png", getAsFile: () => fakeFile("image/png", "shot.png") },
    ],
  };
  deepEq("粘贴截图：从 dt.items 取", filesFromDataTransfer(pasted).map((f) => f.name), ["shot.png"]);

  // items 有结果时就不再叠加 files，避免同一张图被算两次
  const both = {
    items: [{ kind: "file", type: "image/png", getAsFile: () => fakeFile("image/png", "only-once.png") }],
    files: [fakeFile("image/png", "dup.png")],
  };
  deepEq("items 与 files 都有时只用 items（不重复）", filesFromDataTransfer(both).map((f) => f.name), ["only-once.png"]);

  deepEq("null 不炸", filesFromDataTransfer(null), []);
  deepEq("items 里非 file 的项被跳过",
    filesFromDataTransfer({ items: [{ kind: "string", getAsFile: () => fakeFile("image/png", "nope.png") }] }).map((f) => f.name),
    []);
}

console.log("shouldAttachFromPaste —— 「有文字就按文字粘贴」是这条链路上最容易被写错的一步");
{
  ok("截图（无文字）→ 挂图", shouldAttachFromPaste({ hasImageFiles: true, plainText: "" }));
  ok("只空白字符也算无文字 → 挂图", shouldAttachFromPaste({ hasImageFiles: true, plainText: "  \n\t " }));
  ok("从网页复制一段文字（剪贴板同时带位图）→ 不挂图",
    !shouldAttachFromPaste({ hasImageFiles: true, plainText: "这句话是我复制的" }));
  ok("没有图片文件 → 不挂图", !shouldAttachFromPaste({ hasImageFiles: false, plainText: "" }));
  ok("参数缺失不炸", !shouldAttachFromPaste(null) && !shouldAttachFromPaste({}));
}

console.log("fitSize —— 只缩不放");
{
  deepEq("横图超长边：等比缩到 1024", fitSize(3000, 1500, 1024), { width: 1024, height: 512, scaled: true, invalid: false });
  deepEq("竖图超长边：按高缩", fitSize(600, 2400, 1200), { width: 300, height: 1200, scaled: true, invalid: false });
  deepEq("小图原样（不放大的关键断言）", fitSize(320, 200, IMAGE_MAX_DIM), { width: 320, height: 200, scaled: false, invalid: false });
  deepEq("正好等于上限：不算缩", fitSize(1024, 768, 1024), { width: 1024, height: 768, scaled: false, invalid: false });
  deepEq("极扁的图也不塌成 0 宽", fitSize(4000, 3, 1024), { width: 1024, height: 1, scaled: true, invalid: false });
  ok("非法尺寸退化为 1×1 并标 invalid", fitSize(0, 100, 1024).invalid && fitSize(100, 100, 0).invalid);
  ok("缩略图档位也遵守同一规则", fitSize(2000, 2000, IMAGE_THUMB_DIM).width === IMAGE_THUMB_DIM);
}

console.log("splitByCapacity —— 一条消息最多 MAX_IMAGES 张，超出部分要能报出来");
{
  const a = splitByCapacity(0, [1, 2, 3, 4, 5, 6], MAX_IMAGES);
  deepEq("从 0 开始：收前 4 张", a.accepted, [1, 2, 3, 4]);
  deepEq("多出来的 2 张单独返回（用于提示用户）", a.dropped, [5, 6]);

  const b = splitByCapacity(3, [1, 2, 3], MAX_IMAGES);
  deepEq("已有 3 张：只剩 1 个位置", b.accepted, [1]);
  deepEq("其余丢弃", b.dropped, [2, 3]);

  const c = splitByCapacity(MAX_IMAGES, [1], MAX_IMAGES);
  eq("已满：一张也收不下", c.accepted.length, 0);
  eq("已满时不算丢（本来就没位置）", c.dropped.length, 1);
  eq("负数/缺参按 0 处理", splitByCapacity(-5, [1, 2], MAX_IMAGES).accepted.length, 2);
}

console.log("isSafeImageDataUrl —— 白名单（图片 URL 会被拼进 <img src>）");
{
  ok("canvas 产出的 png dataURL 放行", isSafeImageDataUrl(PNG));
  ok("jpeg 放行", isSafeImageDataUrl(JPG));
  ok("webp / gif 放行", isSafeImageDataUrl("data:image/webp;base64,AAAA") && isSafeImageDataUrl("data:image/gif;base64,AAAA"));
  ok("http 外链拦下", !isSafeImageDataUrl("https://evil.example/a.png"));
  ok("javascript: 拦下", !isSafeImageDataUrl("javascript:alert(1)"));
  ok("闭合引号注入的 payload 拦下", !isSafeImageDataUrl('data:image/png;base64,AAA" onerror="alert(1)'));
  ok("data:image/svg+xml（可内嵌脚本）拦下", !isSafeImageDataUrl("data:image/svg+xml;base64,PHN2Zz4="));
  ok("空值拦下", !isSafeImageDataUrl(null) && !isSafeImageDataUrl(""));
}

console.log("sendableUrls / displayableUrls");
{
  const imgs = [
    { full: PNG, thumb: JPG, w: 100, h: 80 },   // 本次会话内：两样都在
    { thumb: JPG, w: 60, h: 60 },               // 刷新后：只剩缩略图
  ];
  deepEq("可发送的只有还带着原图的那张", sendableUrls(imgs), [PNG]);
  deepEq("可渲染的两张都在（渲染优先用缩略图）", displayableUrls(imgs), [JPG, JPG]);
  deepEq("内存里那张渲染时也用缩略图而不是原图", displayableUrls([imgs[0]]), [JPG]);
  deepEq("无可信来源时不给渲染", displayableUrls([{ thumb: "https://x/a.png" }]), []);
}

console.log("buildVisionContent");
{
  eq("无图 → 原样字符串（绝大多数消息走这条，不能被包成数组）", buildVisionContent("你好", []), "你好");
  eq("无图且文字为空 → 空串", buildVisionContent("", []), "");
  deepEq("一图一文 → 文字在前、图在后", buildVisionContent("这题看不懂", [PNG]), [
    { type: "text", text: "这题看不懂" },
    { type: "image_url", image_url: { url: PNG } },
  ]);
  deepEq("只有图没有字 → 不塞空 text 块", buildVisionContent("", [PNG]), [
    { type: "image_url", image_url: { url: PNG } },
  ]);
  deepEq("两图顺序保持", buildVisionContent("", [PNG, JPG]).map((b) => b.image_url.url), [PNG, JPG]);
  deepEq("不可信的 URL 被剔除（剔到没图就退回字符串）", buildVisionContent("hi", ["javascript:alert(1)"]), "hi");
  deepEq("可信与不可信混着：只发可信的", buildVisionContent("", [PNG, "https://x/a.png"]).length, 1);
}

console.log("toApiMessage");
{
  deepEq("纯文字消息：content 保持字符串", toApiMessage({ role: "user", content: "在吗" }),
    { role: "user", content: "在吗" });
  deepEq("无 images 字段不抛错", toApiMessage({ role: "assistant", content: "嗯" }),
    { role: "assistant", content: "嗯" });
  deepEq("user + 图 → content 变块数组", toApiMessage({ role: "user", content: "看图", images: [{ full: PNG, thumb: JPG }] }),
    { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: PNG } }] });

  // 上游对 system/assistant 带图直接 400，这条断言是"不撞墙"的保险
  deepEq("assistant 即便被写坏了 images 也绝不带图",
    toApiMessage({ role: "assistant", content: "答", images: [{ full: PNG, thumb: JPG }] }),
    { role: "assistant", content: "答" });

  const reloaded = toApiMessage({ role: "user", content: "这题", images: [{ thumb: JPG, w: 1, h: 1 }] });
  eq("刷新后只剩缩略图：content 退回字符串", typeof reloaded.content, "string");
  ok("并明说图片已释放（不能让老师硬答）", reloaded.content.indexOf("已释放") >= 0);
  ok("原文保留在说明之前", reloaded.content.indexOf("这题") === 0);

  const blocked = toApiMessage({ role: "user", content: "这题", images: [{ full: PNG, thumb: JPG }], imagesBlocked: true });
  eq("被模型拒收过：不再发图", typeof blocked.content, "string");
  ok("并说明图片没发出去", blocked.content.indexOf("收不了图") >= 0);

  deepEq("批量转换逐条生效", toApiMessages([{ role: "user", content: "a" }, { role: "user", content: "b", images: [{ full: PNG }] }])
    .map((m) => typeof m.content), ["string", "object"]);
}

console.log("stripImagesForStorage —— base64 原图绝不能落盘");
{
  const msg = { role: "user", content: "图", images: [{ full: PNG, thumb: JPG, w: 100, h: 80, bytes: 999 }] };
  const slim = stripImagesForStorage(msg);
  ok("原图被剥掉", slim.images[0].full === undefined);
  eq("缩略图保留", slim.images[0].thumb, JPG);
  eq("尺寸保留（用于渲染占位）", slim.images[0].w, 100);
  ok("来源对象未被改动（内存里的原图还得能发）", msg.images[0].full === PNG);
  eq("落盘副本的字节数远小于原图", JSON.stringify(slim).length < JSON.stringify(msg).length, true);

  const plain = { role: "user", content: "没图" };
  ok("无图消息返回同一个引用（cleanChatMessages 要在它上面补 speaker，克隆会丢）",
    stripImagesForStorage(plain) === plain);

  ok("缩略图不可信时置空，不留注入面",
    stripImagesForStorage({ images: [{ thumb: 'data:image/png;base64,A" onerror="x' }] }).images[0].thumb === "");
}

console.log("countImageTokens");
{
  eq("无图不占预算", countImageTokens([{ role: "user", content: "a" }]), 0);
  eq("一张图 = 一个单位", countImageTokens([{ role: "user", images: [{ full: PNG }] }]), IMAGE_TOKEN_EST);
  eq("两张图翻倍", countImageTokens([{ role: "user", images: [{ full: PNG }, { full: JPG }] }]), IMAGE_TOKEN_EST * 2);
  eq("刷新后只剩缩略图 → 不占预算（反正发不出去）", countImageTokens([{ role: "user", images: [{ thumb: JPG }] }]), 0);
  eq("被拒收过的图 → 也不再占预算", countImageTokens([{ role: "user", images: [{ full: PNG }], imagesBlocked: true }]), 0);
  eq("可自定义单价", countImageTokens([{ role: "user", images: [{ full: PNG }] }], 10), 10);
}

console.log("humanBytes");
{
  eq("小值按 B", humanBytes(512), "512 B");
  eq("千级按 KB", humanBytes(2048), "2 KB");
  eq("兆级按 MB", humanBytes(2.5 * 1024 * 1024), "2.5 MB");
  eq("空值按 0", humanBytes(null), "0 B");
}

console.log("");
console.log("image-input: " + pass + " 通过, " + fail + " 失败");
if (fail) process.exit(1);
