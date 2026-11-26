/* =====================================================================
 *  Socratopia v0 · 大纲纯函数单元测试（node --experimental-default-type=module js/outline.test.mjs）
 *  ---------------------------------------------------------------------
 *  安全网：app.js 拆分第一刀（js/outline.js）的回归保护。
 *  之后每往 outline.js 迁一个函数，先补测试再迁移，保证拆分不引入行为变化。
 * ===================================================================== */
import { splitBookIntoChunks, parseChunkJson, classifyChunkReply, ensureLessonIds, mergePartialsByChapter, indexChapterPositions, needsReindex, CHAPTER_INDEX_VERSION } from "./outline.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}
function eq(name, a, b) { ok(name + " (得到 " + JSON.stringify(a) + ")", a === b); }

console.log("splitBookIntoChunks");
eq("空串仍返回单块", splitBookIntoChunks("").length, 1);
eq("短文本(<8000)单块", splitBookIntoChunks("字".repeat(5000)).length, 1);
eq("短文本无标题", splitBookIntoChunks("字".repeat(5000))[0].title, null);
let mat = "";
for (let i = 0; i < 30; i++) mat += "第" + i + "章 主题" + i + "\n" + ("正文内容。".repeat(200)) + "\n";
const chunks = splitBookIntoChunks(mat);
ok("长书切成多块", chunks.length > 1);
ok("覆盖到末尾无遗漏", chunks[chunks.length - 1].end === mat.length);
ok("块间连续无洞", chunks.every((c, i) => i === 0 || c.start === chunks[i - 1].end));
ok("单块不超上限", Math.max(...chunks.map((c) => c.end - c.start)) <= 10000);
ok("带标题块 title 为原文标题", chunks[0].title === "第0章 主题0");
ok("无标题长文 title 均为 null", splitBookIntoChunks("无标题纯文本。".repeat(3000)).every((c) => c.title === null));

console.log("parseChunkJson");
ok("正常 lessons 解析", Array.isArray(parseChunkJson('{"lessons":[{"title":"a"}]}').lessons));
ok("带代码块包裹", Array.isArray(parseChunkJson('```json\n{"lessons":[]}\n```').lessons));
ok("chapterTitle 透传", parseChunkJson('{"chapterTitle":"第一章 总论","lessons":[]}').chapterTitle === "第一章 总论");
ok("无 chapterTitle 为 null", parseChunkJson('{"lessons":[]}').chapterTitle === null);
ok("无 lessons 返回 null", parseChunkJson('{"chapters":[]}') === null);
ok("完全非法返回 null", parseChunkJson("今天天气不错") === null);
ok("空串返回 null", parseChunkJson("") === null);
ok("bridge 透传（分块路径章导语）", parseChunkJson('{"chapterTitle":"第一章 总论","bridge":"本章导语…","lessons":[]}').bridge === "本章导语…");
ok("无 bridge 为 null", parseChunkJson('{"lessons":[]}').bridge === null);

console.log("ensureLessonIds");
const o = { chapters: [{ lessons: [{ id: "keep" }, {}, null] }] };
ensureLessonIds(o);
ok("已有 id 保留", o.chapters[0].lessons[0].id === "keep");
ok("缺失 id 幂等补全", o.chapters[0].lessons[1].id === "ch0_L1");
ok("null 课时安全跳过", o.chapters[0].lessons[2] === null);
ok("无大纲入参安全返回", ensureLessonIds(null) === undefined);

console.log("splitBookIntoChunks 章节继承");
const filler = "内容填充。".repeat(400);
const mdBook = "# 前言\n" + filler + "\n## 第一章 总论\n" + filler + "\n### 1.1 概述\n" + filler + "\n### 1.2 细节\n" + filler + "\n## 第二章 分论\n" + filler + "\n### 2.1 小节\n" + filler;
const mdChunks = splitBookIntoChunks(mdBook);
const firstChapter = mdChunks.find((c) => c.title && c.title.includes("第一章"));
ok("章级片段 title 为章标题", !!firstChapter);
ok("小节片段继承最近章标题", mdChunks.every((c) => !c.title || !c.title.includes("1.1") || c.title.includes("第一章")));

console.log("mergePartialsByChapter");
const samplePartials = [
  { absStart: 0, absEnd: 100, title: "第一章 总论", lessons: [{ title: "1.1 概述" }, { title: "1.2 背景" }] },
  { absStart: 100, absEnd: 200, title: "第一章 总论", lessons: [{ title: "1.3 目标" }] },
  { absStart: 200, absEnd: 300, title: "第二章 分论", lessons: [{ title: "2.1 小节" }] },
];
const merged = mergePartialsByChapter(samplePartials);
ok("同 title 合并为一个章节", merged.chapters.length === 2);
ok("第一章包含3个课时", merged.chapters[0].lessons.length === 3);
ok("按 absStart 顺序保留课时", merged.chapters[0].lessons[1].title === "1.2 背景");
ok("不同 title 各自成章节", merged.chapters[1].lessons.length === 1);

const longPartials = [
  { absStart: 0, absEnd: 10, title: "第一章", lessons: Array.from({ length: 15 }, (_, i) => ({ title: "课" + i })) },
];
const split = mergePartialsByChapter(longPartials, { maxLessonsPerChapter: 6 });
ok("超长章节拆分为(1)(2)(3)", split.chapters.length === 3);
ok("子章标题含中文序号", split.chapters[0].title.includes("（1）") && split.chapters[2].title.includes("（3）"));
ok("空数组返回空章节", mergePartialsByChapter([]).chapters.length === 0);

console.log("mergePartialsByChapter 归集 bridge / whyImportant（长书分块路径字段不丢失）");
const bridgePartials = [
  { absStart: 0, absEnd: 100, title: "第一章 总论", bridge: "BRIDGE_第一章", lessons: [{ title: "1.1 概述" }] },
  { absStart: 100, absEnd: 200, title: "第一章 总论", lessons: [{ title: "1.2 背景" }] }, // 第二段无 bridge
  { absStart: 200, absEnd: 300, title: "第二章 分论", bridge: "BRIDGE_第二章", lessons: [{ title: "2.1 小节", whyImportant: "WHY_2.1" }] },
];
const bMerged = mergePartialsByChapter(bridgePartials);
ok("章 bridge 取首个片段的值", bMerged.chapters[0].bridge === "BRIDGE_第一章");
ok("第二章 bridge 透传", bMerged.chapters[1].bridge === "BRIDGE_第二章");
ok("课时 whyImportant 透传（分块路径不再丢字段）", bMerged.chapters[1].lessons[0].whyImportant === "WHY_2.1");
// 超长章拆 (1)(2)(3) 时，每片子章继承同一 bridge
const bSplit = mergePartialsByChapter([{ absStart: 0, absEnd: 10, title: "第一章", bridge: "B", lessons: Array.from({ length: 15 }, (_, i) => ({ title: "课" + i })) }], { maxLessonsPerChapter: 6 });
ok("超长章拆分后子章继承 bridge", bSplit.chapters.every((c) => c.bridge === "B"));

console.log("mergePartialsByChapter 重名章不误并（B2）");
// 跨章重复的小节名（如每章末尾都有的「1. 习题」）不应被并成同一章
const dupPartials = [
  { absStart: 0, absEnd: 100, title: "第一章 基础", lessons: [{ title: "1.1 概念" }] },
  { absStart: 100, absEnd: 200, title: "1. 习题", lessons: [{ title: "习题A" }] },
  { absStart: 200, absEnd: 300, title: "第二章 进阶", lessons: [{ title: "2.1 概念" }] },
  { absStart: 300, absEnd: 400, title: "1. 习题", lessons: [{ title: "习题B" }] },
];
const dupMerged = mergePartialsByChapter(dupPartials);
ok("重名小节各自成章（不被并成 1 章）", dupMerged.chapters.length === 4,
  "实际 " + dupMerged.chapters.length);
ok("重名小节各自保留自己的课时",
  dupMerged.chapters[1].lessons[0].title === "习题A" && dupMerged.chapters[3].lessons[0].title === "习题B");
ok("相邻同标题片段仍合并", mergePartialsByChapter([
  { absStart: 0, absEnd: 50, title: "第一章 基础", lessons: [{ title: "a" }] },
  { absStart: 50, absEnd: 100, title: "第一章 基础", lessons: [{ title: "b" }] },
]).chapters.length === 1);

console.log("splitBookIntoChunks 超长章标题（B3）");
// 旧正则把标题后缀限死在 .{0,30}，48 字标题会被漏判 → 该章退化成 title=null 的定长块
const longTitle = "第一章 " + "标".repeat(44);
const longBook = longTitle + "\n" + "正文内容。".repeat(300);
const longChunks = splitBookIntoChunks(longBook);
ok("48 字章标题被识别为章边界", longChunks.some((c) => c.title === longTitle),
  "首块标题：" + JSON.stringify(longChunks[0].title));

console.log("mergePartialsByChapter 默认阈值取自 config（B4）");
// 默认（不传 opts）应使用 APP_CONFIG.outlineMaxLessonsPerChapter；15 课 > 12 → 拆 2 子章
const dfltSplit = mergePartialsByChapter([
  { absStart: 0, absEnd: 10, title: "第一章", lessons: Array.from({ length: 15 }, (_, i) => ({ title: "课" + i })) },
]);
ok("默认阈值下 15 课章被拆为 2 子章", dfltSplit.chapters.length === 2, "实际 " + dfltSplit.chapters.length);

console.log("splitBookIntoChunks 数字编号边界防御");
// 规整排版：数字编号标题独占一行且前后为空白行 → 仍应作为章边界
const bigFiller = "内容填充很长很长。".repeat(800);
const numberedBook = "第一章 总论\n\n" + bigFiller + "\n\n1. 引言\n\n" + bigFiller + "\n\n2. 方法\n\n" + bigFiller;
const nbChunks = splitBookIntoChunks(numberedBook);
const nbTitles = nbChunks.map((c) => c.title);
ok("规整数字编号标题被识别为章 ('1. 引言')", nbTitles.includes("1. 引言"));
ok("规整数字编号标题被识别为章 ('2. 方法')", nbTitles.includes("2. 方法"));
// 正文列表项：数字. 开头的短行紧贴上一行正文（前一行非空）→ 不应切出伪章
const listBook = "第一章 总论\n" + "正文内容很长。".repeat(1000) + "\n3. 这是一个列表项\n" + "正文内容很长。".repeat(1000);
const lbChunks = splitBookIntoChunks(listBook);
ok("正文数字列表项不误判为章边界", !lbChunks.some((c) => c.title === "3. 这是一个列表项"));
ok("正文列表项内容归入前一章", lbChunks.some((c) => c.title === "第一章 总论" && c.text.includes("3. 这是一个列表项")));

console.log("indexChapterPositions（目录免疫）");
// 书首带 ](#锚点) 的目录：朴素 indexOf 会命中目录而非正文 → 切出目录残行
const chapterBody = (t) => t + "\n" + "这一章的正文内容，足够长以便切片。".repeat(120) + "\n";
const tocBook =
  "# 目录\n\n" +
  "[第一章 环境](#ch1)\n[第二章 语法](#ch2)\n[第三章 实战](#ch3)\n\n" +
  "## 第一章 环境\n" + chapterBody("环境章正文从这里开始。") +
  "## 第二章 语法\n" + chapterBody("语法章正文从这里开始。") +
  "## 第三章 实战\n" + chapterBody("实战章正文从这里开始。");
const tocOutline = { chapters: [
  { title: "第一章 环境", lessons: [{ title: "环境课" }] },
  { title: "第二章 语法", lessons: [{ title: "语法课" }] },
  { title: "第三章 实战", lessons: [{ title: "实战课" }] },
] };
indexChapterPositions(tocBook, tocOutline);
ok("空入参安全返回", indexChapterPositions("", null) === undefined);
tocOutline.chapters.forEach((ch, ci) => {
  const slice = tocBook.slice(ch._charStart, ch._charEnd);
  ok("第" + (ci + 1) + "章切片含正文标题（未命中目录）", slice.includes(ch.title));
  ok("第" + (ci + 1) + "章切片不含目录锚点 ](#", !slice.includes("](#"));
  ok("第" + (ci + 1) + "章切片足够长（非残行）", slice.trim().length >= 100);
});
ok("各章起点单调不减", tocOutline.chapters.every((ch, ci) => ci === 0 || ch._charStart >= tocOutline.chapters[ci - 1]._charStart));
ok("课时索引落在章范围内", tocOutline.chapters.every((ch) => ch.lessons.every((ls) => ls._charStart >= ch._charStart && ls._charEnd <= ch._charEnd)));

// 无目录的普通文本也能定位（回归：不比旧版差）
const plainBook = "第一章 甲\n" + "甲章内容。".repeat(300) + "\n第二章 乙\n" + "乙章内容。".repeat(300);
const plainOutline = { chapters: [{ title: "第一章 甲", lessons: [{ title: "a" }] }, { title: "第二章 乙", lessons: [{ title: "b" }] }] };
indexChapterPositions(plainBook, plainOutline);
ok("普通文本第一章定位到标题", plainBook.slice(plainOutline.chapters[0]._charStart).startsWith("第一章 甲"));
ok("普通文本第二章定位到标题", plainBook.slice(plainOutline.chapters[1]._charStart).startsWith("第二章 乙"));
// 完全找不到标题 → 按比例均分而非塌缩
const ghostOutline = { chapters: [{ title: "不存在甲", lessons: [{ title: "x" }] }, { title: "不存在乙", lessons: [{ title: "y" }] }] };
indexChapterPositions(plainBook, ghostOutline);
ok("找不到标题时按比例均分", ghostOutline.chapters[0]._charStart === 0 && ghostOutline.chapters[1]._charStart > 0);
ok("找不到标题时范围覆盖全文", ghostOutline.chapters[1]._charEnd === plainBook.length);

console.log("indexLessonPositions（章内关键词定位）");
const lpPad = "章内填充正文。".repeat(300);
const lpMat = "第一章 语言基础\n" +
  lpPad + "\n这里开讲【变量作用域】。\n" + lpPad +
  "\n接着讲【闭包与自由变量】。\n" + lpPad +
  "\n最后讲【装饰器语法糖】。\n" + lpPad;
const lpOutline = { chapters: [{ title: "第一章 语言基础", lessons: [
  { id: "q1", title: "变量作用域", keyPoints: ["变量作用域"] },
  { id: "q2", title: "闭包", keyPoints: ["闭包"] },
  { id: "q3", title: "装饰器", keyPoints: ["装饰器"] },
  { id: "q4", title: "玄学", keyPoints: ["原文没有的概念"] },
] }] };
indexChapterPositions(lpMat, lpOutline);
const lpCh = lpOutline.chapters[0];
ok("章有真实起止范围", lpCh._charStart === 0 && lpCh._charEnd === lpMat.length);
ok("前三课按关键词定位成功", lpCh.lessons.slice(0, 3).every((ls) => ls._located === true));
ok("定位不到的课时标记 _located=false", lpCh.lessons[3]._located === false);
ok("课时区间单调不减", lpCh.lessons.every((ls, i) => i === 0 || ls._charStart >= lpCh.lessons[i - 1]._charStart));
ok("课时区间不越出章范围", lpCh.lessons.every((ls) => ls._charStart >= lpCh._charStart && ls._charEnd <= lpCh._charEnd));
ok("第1课区间含其关键词", lpMat.slice(lpCh.lessons[0]._charStart, lpCh.lessons[0]._charEnd).includes("变量作用域"));
ok("第2课区间含其关键词且不含第1课关键词", lpMat.slice(lpCh.lessons[1]._charStart, lpCh.lessons[1]._charEnd).includes("闭包") && !lpMat.slice(lpCh.lessons[1]._charStart, lpCh.lessons[1]._charEnd).includes("变量作用域"));
ok("第3课区间含其关键词", lpMat.slice(lpCh.lessons[2]._charStart, lpCh.lessons[2]._charEnd).includes("装饰器"));
ok("定位不到的课时区间仍非空", lpCh.lessons[3]._charEnd - lpCh.lessons[3]._charStart > 0);
// 单课时章 → 直接覆盖整章
const oneOutline = { chapters: [{ title: "第一章 语言基础", lessons: [{ id: "o1", title: "唯一课时", keyPoints: ["变量作用域"] }] }] };
indexChapterPositions(lpMat, oneOutline);
ok("单课时章覆盖整章", oneOutline.chapters[0].lessons[0]._charStart === 0 && oneOutline.chapters[0].lessons[0]._charEnd === lpMat.length);

// ---- 索引版本：旧大纲（有坐标但算法版本落后）应自动重算，免重生成大纲 ----
console.log("needsReindex（旧大纲自动重算）");
const vrMat = "第一章 甲\n" + "甲正文。".repeat(200) + "\n第二章 乙\n" + "乙正文。".repeat(200);
const vrOutline = { chapters: [
  { title: "第一章 甲", lessons: [{ id: "v1", title: "甲之一", keyPoints: ["甲正文"] }] },
  { title: "第二章 乙", lessons: [{ id: "v2", title: "乙之一", keyPoints: ["乙正文"] }] },
] };
ok("从未算过索引 → 需要重算", needsReindex(vrOutline) === true);
indexChapterPositions(vrMat, vrOutline);
ok("算过之后写入当前版本号", vrOutline._indexVersion === CHAPTER_INDEX_VERSION);
ok("同版本且坐标齐全 → 不再重算（幂等）", needsReindex(vrOutline) === false);

// 模拟「旧版存下来的大纲」：坐标字段齐全（旧均分/旧 indexOf 结果），但没有版本标记
const staleOutline = { chapters: [
  { title: "第一章 甲", _charStart: 0, _charEnd: 500, lessons: [
    { id: "v1", title: "甲之一", keyPoints: ["甲正文"], _charStart: 0, _charEnd: 250 },
  ] },
  { title: "第二章 乙", _charStart: 500, _charEnd: 1000, lessons: [
    { id: "v2", title: "乙之一", keyPoints: ["乙正文"], _charStart: 500, _charEnd: 750 },
  ] },
] };
ok("旧数据有坐标但版本落后 → 仍需重算", needsReindex(staleOutline) === true);
ok("旧数据的课时没有 _located 标记", staleOutline.chapters[0].lessons[0]._located === undefined);
const staleBefore = staleOutline.chapters[1]._charStart;
indexChapterPositions(vrMat, staleOutline);
ok("重算后章坐标被纠正到真实标题处", staleOutline.chapters[1]._charStart === vrMat.indexOf("第二章 乙"));
ok("重算确实改变了原坐标（说明旧值是错的）", staleOutline.chapters[1]._charStart !== staleBefore);
ok("重算后课时被内容定位（_located=true）", staleOutline.chapters[0].lessons[0]._located === true);
ok("重算后升级版本号", staleOutline._indexVersion === CHAPTER_INDEX_VERSION);
ok("重算后不再重复触发", needsReindex(staleOutline) === false);
// 边界：空/非法输入不应抛错，也不该被判定为需要重算
ok("空入参不抛错", needsReindex(null) === false && needsReindex({}) === false);

console.log("classifyChunkReply（B9：解析失败也必须算失败，不能静默丢章节）");
{
  const chunk = { start: 100, end: 200, title: "第三章" };
  const good = classifyChunkReply(JSON.stringify({ chapterTitle: "第三章", lessons: [{ id: "l1", title: "课时一" }] }), chunk);
  ok("正常返回 ok:true", good.ok === true);
  eq("partial.title 用片段标题", good.partial.title, "第三章");
  eq("partial.absStart 取自片段区间", good.partial.absStart, 100);
  eq("partial.absEnd 取自片段区间", good.partial.absEnd, 200);
  eq("课时透传", good.partial.lessons.length, 1);

  // 片段无标题时回落到模型给的 chapterTitle
  const noChunkTitle = classifyChunkReply(JSON.stringify({ chapterTitle: "第四章", lessons: [{ id: "a" }] }), { start: 0, end: 10, title: null });
  eq("片段无标题时用 chapterTitle", noChunkTitle.partial.title, "第四章");

  // ---- 核心：这些以前**不计数**，于是那一章从大纲里静默消失 ----
  const bad = classifyChunkReply("模型今天不太想干活", chunk);
  eq("纯文本回复 → ok:false", bad.ok, false);
  eq("纯文本回复 reason=parse", bad.reason, "parse");
  eq("空回复 → ok:false", classifyChunkReply("", chunk).ok, false);
  eq("null 回复 → ok:false", classifyChunkReply(null, chunk).ok, false);
  eq("JSON 合法但无 lessons（解析出对象却无课时）→ 仍算失败",
    classifyChunkReply(JSON.stringify({ chapterTitle: "第三章" }), chunk).ok, false);
  eq("lessons 为空数组 → 算失败", classifyChunkReply(JSON.stringify({ lessons: [] }), chunk).ok, false);
  eq("lessons 类型不对（对象）→ 算失败", classifyChunkReply(JSON.stringify({ lessons: { a: 1 } }), chunk).ok, false);
  eq("被截断的 JSON（模型吐一半）→ 算失败", classifyChunkReply('{"lessons":[{"title":"半截', chunk).ok, false);
  ok("失败结果不带 partial（调用方不得误用）", bad.partial === undefined);
}

console.log("indexChapterPositions（纯文本目录 / 同名章 —— 2026-09-13 修复的两处塌缩）");
{
  // 这两支此前【没有任何测试】：上面的目录夹具用的是 markdown 链接式（]( 命中 -4 分，
  // 天然被排除），而 .txt / docx 导出最常见的裸目录行拿不到任何扣分，与正文标题同分。
  const body = "正文内容。".repeat(200);
  const plain = (t) => "\n" + t + "\n" + body;

  // A) 书首裸目录 + 正文里再次出现同名标题
  const TOC_A = "第一章 环境\n第二章 语法\n第三章 实战";
  const tocBook2 = TOC_A + plain("第一章 环境") + plain("第二章 语法") + plain("第三章 实战");
  const oA = { chapters: [{ title: "第一章 环境" }, { title: "第二章 语法" }, { title: "第三章 实战" }] };
  indexChapterPositions(tocBook2, oA);
  const lensA = oA.chapters.map((c) => c._charEnd - c._charStart);
  ok("纯文本目录：没有哪一章塌缩成一行标题（旧实现前两章各只有 7 个字）",
    lensA.every((n) => n > 500));
  ok("纯文本目录：第一章从目录块【之后】开始，而不是锚在书首目录上",
    oA.chapters[0]._charStart >= TOC_A.length);
  ok("纯文本目录：各章范围单调递增",
    oA.chapters.every((c, i) => i === 0 || c._charStart >= oA.chapters[i - 1]._charEnd));

  // B) 两章同名（模型把一个大章拆成两条同名章）
  const dupBook2 = "第一章 总论" + body + body + body;
  const oB = { chapters: [{ title: "第一章 总论" }, { title: "第一章 总论" }] };
  indexChapterPositions(dupBook2, oB);
  const lensB = oB.chapters.map((c) => c._charEnd - c._charStart);
  ok("同名章：前一章不再只剩 1 个字符（旧实现 len=1）", lensB.every((n) => n > 500));

  // C) 回归：markdown 链接式目录的行为不能被改动
  const mdBook2 = "# 目录\n\n[第一章 环境](#ch1)\n[第二章 语法](#ch2)\n[第三章 实战](#ch3)\n\n" +
    "## 第一章 环境" + plain("环境正文") + "## 第二章 语法" + plain("语法正文") + "## 第三章 实战" + plain("实战正文");
  const oC = { chapters: [{ title: "第一章 环境" }, { title: "第二章 语法" }, { title: "第三章 实战" }] };
  indexChapterPositions(mdBook2, oC);
  ok("回归：markdown 目录仍不落进章节范围",
    !oC.chapters.some((c) => mdBook2.slice(c._charStart, c._charEnd).includes("](#ch1)")));
  ok("回归：markdown 目录下各章仍有正常篇幅",
    oC.chapters.every((c) => c._charEnd - c._charStart > 500));
}

console.log("结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
