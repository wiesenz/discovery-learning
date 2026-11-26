/* =====================================================================
 *  Socratopia v0 · 大纲生成纯函数模块（js/outline.js）
 *  ---------------------------------------------------------------------
 *  从 app.js 拆出的第一刀（20260821.3）：只搬「零外部依赖」的纯函数，
 *  保证拆分零风险、行为逐字不变。generateOutline / generateOutlineFullBook
 *  等依赖运行时状态的主流程仍在 app.js，后续逐刀迁入。
 *
 *  浏览器里通过 ESM import 使用（app.js 已是 <script type="module">）；
 *  Node 22+ 可直接 require() 或 import() 跑 js/outline.test.mjs 单测。
 * ===================================================================== */

import { APP_CONFIG } from "../config.js";

// 判断一个标题是否属于「章级」标题（用于 splitBookIntoChunks 跟踪当前章节）。
// 规则覆盖常见教材/教程格式：第X章、Chapter X、# / ## 层标题、单层编号标题（1. / 2.），
// 但不把三级以下标题（###）或多级编号（1.1 / 2.1）当成章级。
function isMajorHeading(t) {
  if (!t || typeof t !== "string") return false;
  const text = t.trim();
  if (!text) return false;
  if (/^第[一二三四五六七八九十百千0-9]+[章回节部分卷]/i.test(text)) return true;
  if (/^Chapter\s+\d+/i.test(text)) return true;
  if (/^#\s+/.test(text)) return true;
  if (/^##\s+/.test(text)) return true;
  // 单层编号标题，如 "1. 引言" / "2. 下载"，但不是 "1.1 xxx"
  if (/^\d+[\.、]\s+/.test(text) && !/^\d+[\.、]\d+/.test(text)) return true;
  return false;
}

// 单层编号标题（如 "3. 说明"），区别于多级编号 "3.1"（不当章级）。
function isNumberedHeading(t) {
  return /^\d+[\.、]\s+/.test(t) && !/^\d+[\.、]\d+/.test(t);
}

// 标题行（text[index] 起）的「前一行」是否为空行。
// 用于约束数字编号类标题：只有它独占一行且上方是空行时才算章节边界，
// 否则极可能是正文里的列表项（如 "3. 这是一个列表项"），不应切分成章。
function prevLineIsBlank(material, index) {
  const prevNl = material.lastIndexOf("\n", index - 1); // 标题行紧邻的上一个换行
  if (prevNl < 0) return true; // 文档开头第一行，视为之前为空（数字编号类几乎不会在此触发）
  const beforeNl = material.lastIndexOf("\n", prevNl - 1); // 再上一行的换行
  const lineBefore = material.slice(beforeNl + 1, prevNl).replace(/\r/g, "").trim();
  return lineBefore.length === 0;
}

// 把全书切成若干连续片段，保证每个字符都被读到（无遗漏）。
// 两层切分策略（20260824.4 明确，满足「默认按原章节切分 + 过长再按长度上下切分」）：
//   层1 结构层：默认按教材原文章节标题边界切（章/节），尽量保留原章节框架；
//   层2 长度层：某节切出后仍超过「合适长度」上限，再按该上限对这节内容做定长「上下切分」。
// 每个片段携带所属的教材原文章节标题（title），供后续按原章节目录组织大纲。
export function splitBookIntoChunks(material, opts) {
  // 单块「合适长度」上限：全部由窗口派生（见 config.js limits.chunkSoftChars）。
  // 旧值 10000 是 64K/128K 时代的遗留，1M 窗口下每块可大得多，提取更聚焦、分块数更少。
  const CHUNK_SOFT = (opts && opts.chunkSoftChars) || (APP_CONFIG.limits && APP_CONFIG.limits.chunkSoftChars) || 10000;
  const MIN_HEADINGS = 1;     // 只要有 1 个可识别标题就走结构切，避免标题少时整本退回定长而丢失章节结构
  const MAX_CHUNKS = (APP_CONFIG.limits && APP_CONFIG.limits.maxChunks) || 80;
  const total = material.length;
  // 空输入：沿用原有契约，返回单个空片段（区别于「无内容可切」返回空数组）。
  // 这不是长度阈值，只是显式的空值守卫，避免下方定长切分循环对空串产出 0 块。
  if (total === 0) return [{ start: 0, end: 0, text: "", title: null, sectionTitle: null }];
  // 注：此处原有一条「total <= 8000 直接返回单块（title:null）」的短书快路径。
  // 2026-09-08 删除，理由：
  //  ① 8000 是 64K/128K 时代留下的写死魔数，不属于「模型能力上限」这一类约束；
  //  ② 它会把带章节标题的短书压成单个 title=null 的块，反而丢失章节结构
  //     （先改成读 limits.shortBookChars=16000 后，outline.test.mjs 的「章节继承」
  //      两条用例即因此失败 —— 阈值越大越容易吞掉有结构的书）；
  //  ③ 生产上本函数只在 generateOutlineFullBook 里调用，而后者仅当书超过整书门槛
  //     （1M 档位下 **19.2 万字**，= limits.outlineWholeBookMaxChars；此处曾误记 133 万字）
  //     才触发，这条快路径实际上永远走不到，属死代码。
  // 删除后统一走「结构优先、再按长度细分」：短书无标题时自然仍是单块，行为一致，
  // 有标题时则保留章标题，比原快路径更正确。
  // 章标题行的长度上限（含「第X章」前缀后的标题正文）。
  // 2026-09-10 修 B3：旧正则把后缀限死在 .{0,30} / .{0,40}，实测 47 字的章标题
  // （如「第一章 电池热失控预警与换电站安全运营要点分析及应急处置流程说明…」）
  // 因整体长度超出上限而**匹配失败** → 该标题不被当作边界 → 这一章的结构被丢进
  // 若干 title=null 的定长块里。放宽到 60 字：足够覆盖长标题，
  // 又仍能挡住「以『第一章』开头」的长正文段落（那些通常远超 60 字）。
  const MAX_HEADING_LEN = 60;
  const headingRe = new RegExp(
    "^(第[一二三四五六七八九十百千0-9]+[章回节部分卷].{0," + MAX_HEADING_LEN + "}" +
    "|Chapter\\s+\\d+.{0," + MAX_HEADING_LEN + "}" +
    "|#{1,6}\\s+\\S.{0," + MAX_HEADING_LEN + "}" +
    "|\\d+[\\.、]\\s+.{1," + MAX_HEADING_LEN + "})$", "gm");
  const bounds = [];
  let m;
  while ((m = headingRe.exec(material)) !== null) bounds.push({ i: m.index, t: m[0].trim() });
  // 候选标题里，只有「章级」且「数字编号类需前一行是空行」才算真实边界，
  // 以防御正文列表项（如 "3. 这是一个列表项"）被误判为章边界而切出伪章。
  // 「第X章 / Chapter / # 标题」类几乎不可能在正文行首出现，不要求空行。
  const realBounds = bounds.filter((b) => {
    if (!isMajorHeading(b.t)) return false;
    if (isNumberedHeading(b.t) && !prevLineIsBlank(material, b.i)) return false;
    return true;
  });
  const segs = [];
  if (realBounds.length >= MIN_HEADINGS) {
    // 层1：按真实标题边界切；标题前的序/前言片段保留 t:null（无章标题）
    if (realBounds[0].i > 0) segs.push({ s: 0, e: realBounds[0].i, t: null });
    for (let i = 0; i < realBounds.length; i++) {
      const h = realBounds[i].t;
      // realBounds 内全是章级标题，标题即当前章/节标题（保留原层级，如「第一章」「1. 引言」）
      segs.push({ s: realBounds[i].i, e: i + 1 < realBounds.length ? realBounds[i + 1].i : total, t: h, section: h });
    }
  } else {
    // 完全没有任何可识别标题：整本按 CHUNK_SOFT 定长切（无法保留章节结构，退而求其次）
    for (let s = 0; s < total; s += CHUNK_SOFT) segs.push({ s, e: Math.min(s + CHUNK_SOFT, total), t: null, section: null });
  }
  // 层2：对每节（seg）若仍超过 CHUNK_SOFT，按 CHUNK_SOFT 对其内容做定长「上下切分」；
  // 细分片段继承该节的章标题（t/section），保证后续能归并回同一章。
  const fine = [];
  for (const seg of segs) {
    if (seg.e - seg.s > CHUNK_SOFT) {
      for (let x = seg.s; x < seg.e; x += CHUNK_SOFT) fine.push({ s: x, e: Math.min(x + CHUNK_SOFT, seg.e), t: seg.t, section: seg.section });
    } else fine.push(seg);
  }
  let final = fine;
  if (final.length > MAX_CHUNKS) { // 安全上限：超出则加粗窗口（此兜底下无法携带章标题）
    const step = Math.ceil(total / MAX_CHUNKS);
    final = [];
    for (let s = 0; s < total; s += step) final.push({ s, e: Math.min(s + step, total), t: null, section: null });
  }
  return final.map((seg) => ({
    start: seg.s,
    end: seg.e,
    text: material.slice(seg.s, seg.e).replace(/\r/g, ""),
    title: seg.t || null,
    sectionTitle: seg.section || null,
  }));
}

function normalizeChapterTitle(t) {
  if (!t || typeof t !== "string") return "__no_title__";
  let s = t.trim().replace(/^#{1,6}\s+/, "");
  s = s.replace(/^[\*\-•]\s*/, "");
  s = s.replace(/\s+/g, " ").trim();
  // 按长度截断，避免标题里夹带的长段落被当成唯一键
  if (s.length > 80) s = s.slice(0, 80);
  return s || "__empty__";
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// 按教材原文章节标题（partial.title）合并各片段提取结果。
// 这是「大纲综合」失败时的确定性兜底：不需要再调 API，直接把相邻且同 title 的片段课时归并
// （跨章重名各自成章，见 B2），超长章节再按课时数拆分为 (1)(2)(3) 子章，
// 确保结果仍按原章节框架组织。
export function mergePartialsByChapter(partials, opts) {
  opts = opts || {};
  // B4（2026-09-10）：阈值从 config 读，不再在代码里写死 12
  // （见 APP_CONFIG.outlineMaxLessonsPerChapter 的说明：教学节奏阈值、非 token 预算）。
  const maxLessonsPerChapter = opts.maxLessonsPerChapter || APP_CONFIG.outlineMaxLessonsPerChapter || 12;
  const maxCharsPerChapter = opts.maxCharsPerChapter || (APP_CONFIG.limits && APP_CONFIG.limits.maxCharsPerChapter) || 60000; // 粗略覆盖字符上限
  if (!Array.isArray(partials) || !partials.length) return { chapters: [] };

  // 分组：只把「与上一片段同标题的连续片段」并入同一章（2026-09-10 修 B2）。
  // 片段是全书按顺序连续切出来的，同一章的片段必然相邻；而旧实现只按归一化标题做
  // 全局分组，导致跨章重复出现的小节名（如每章末尾都有的「1. 习题」「本章小结」
  // 「Exercises」「思考题」）被误并成同一个章，破坏原章节结构。
  // 改为「相邻且同标题才归并」：重复的章节名各自成章，同一章的多个 chunk 仍正确合并。
  const groups = [];
  let cur = null;
  for (let i = 0; i < partials.length; i++) {
    const p = partials[i];
    const key = normalizeChapterTitle(p.title);
    if (!cur || cur.key !== key) {
      cur = { key, rawTitle: p.title || null, firstAbs: p.absStart, spanChars: 0, lessons: [], rawBridge: null };
      groups.push(cur);
    }
    // bridge 由「每章首个片段」产出（outlineChunkRules 要求）；取该章首个非空值。
    if (!cur.rawBridge && p.bridge) cur.rawBridge = p.bridge;
    // 累计本章覆盖的原文长度（各片段 absStart/absEnd 依次拼接）
    cur.spanChars += Math.max(0, (p.absEnd || 0) - (p.absStart || 0));
    // 把课时绑定到片段位置，便于后续排序
    const lessons = (p.lessons || []).map((ls) => ({ __absStart: p.absStart, ls: ls }));
    cur.lessons.push(...lessons);
  }
  groups.sort((a, b) => (a.firstAbs || 0) - (b.firstAbs || 0));

  const chapters = [];
  for (const g of groups) {
    // 按片段在全书中的先后顺序重排课时
    g.lessons.sort((a, b) => (a.__absStart || 0) - (b.__absStart || 0));
    const lessons = g.lessons.map((x) => x.ls);

    const baseTitle = g.rawTitle || ("第 " + (chapters.length + 1) + " 章（未命名）");

    // 本章覆盖的原文长度（用 absEnd/absStart 估算，已按组累计）
    const chapterLen = g.spanChars || 0;

    const needSplitByCount = lessons.length > maxLessonsPerChapter;
    const needSplitByLen = chapterLen > maxCharsPerChapter && lessons.length > 1;
    const needSplit = needSplitByCount || needSplitByLen;

    if (!needSplit) {
      chapters.push({ title: baseTitle, bridge: g.rawBridge || null, lessons });
    } else {
      // 同时考虑课时数量和文本长度，取更保守的分块数
      const byCount = Math.ceil(lessons.length / maxLessonsPerChapter);
      const byLen = chapterLen > 0 ? Math.ceil(chapterLen / maxCharsPerChapter) : 1;
      const pieces = Math.max(byCount, byLen, 2);
      const perPiece = Math.ceil(lessons.length / pieces);
      const chunks = chunkArray(lessons, perPiece);
      chunks.forEach((chunk, idx) => {
        const suffix = "（" + (idx + 1) + "）";
        chapters.push({ title: baseTitle + suffix, bridge: g.rawBridge || null, lessons: chunk });
      });
    }
  }

  return { chapters };
}

// 解析「逐段提取」结果：接受 { chapterTitle?, lessons: [...] }（不要求 chapters）。
// 返回 { chapterTitle, lessons }，chapterTitle 为原文标题（无则 null）。
export function parseChunkJson(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("{"); const e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  try {
    const o = JSON.parse(t);
    if (o && Array.isArray(o.lessons)) {
      const chapterTitle = (typeof o.chapterTitle === "string" && o.chapterTitle.trim()) ? o.chapterTitle.trim() : null;
      // bridge 在 outlineChunkRules 里由「每章首个片段」产出（只基于该片段真实文本），
      // 归并时取首个非空值即可（见 mergePartialsByChapter）。
      const bridge = (typeof o.bridge === "string" && o.bridge.trim()) ? o.bridge.trim() : null;
      return { chapterTitle: chapterTitle, bridge: bridge, lessons: o.lessons };
    }
  } catch (_) {}
  return null;
}

// 判定单个片段的提取结果（B9，2026-09-12）。
// 为什么要有这个函数：旧实现在 app.js 的分块循环里只对**异常**计数（catch 里 failed++），
// 而「模型返回了、但 parseChunkJson 解析不出课时」这条路径既不计数、也不留任何痕迹 ——
// 于是那一段书就从大纲里静默消失，而大纲看上去完全正常（用户在侧边栏根本发现不了，
// 内容教不到也无人知晓）。这与 B7 的「截断被容错解析吞掉」是同一族问题。
// 现在把「这一段算不算成功」收成一个纯函数：① 调用方统一按它计数；② 可被单测锁死。
// 返回 { ok:true, partial } 或 { ok:false, reason:"parse"|"empty" }。
export function classifyChunkReply(reply, chunk) {
  const p = parseChunkJson(reply);
  if (!p) return { ok: false, reason: "parse" };
  if (!p.lessons || !p.lessons.length) return { ok: false, reason: "empty" };
  return {
    ok: true,
    partial: {
      absStart: chunk.start,
      absEnd: chunk.end,
      title: chunk.title || p.chapterTitle || null,
      bridge: p.bridge || null,
      lessons: p.lessons,
    },
  };
}

// 课时 id 幂等补全：模型返回的大纲（尤其综合失败草稿、偶漏 id）可能缺失 lesson.id，
// 导致 renderBookList 中 data-lid 为空、点课时直接 return 上不了课。
// 规则：缺 id 时按「章序号_课序号」生成稳定 id（ch{ci}_L{li}），已存在的保留。
export function ensureLessonIds(outline) {
  if (!outline || !Array.isArray(outline.chapters)) return;
  outline.chapters.forEach((ch, ci) => {
    if (!ch || !Array.isArray(ch.lessons)) return;
    ch.lessons.forEach((ls, li) => {
      if (ls && (!ls.id || typeof ls.id !== "string" || !ls.id.trim())) {
        ls.id = "ch" + ci + "_L" + li;
      }
    });
  });
}

// ---- 章节位置索引（纯函数，供「查看原文」按偏移切真迹）----
// 按章标题在原文中定位每章字符起止位置，并按比例分给章内课时。
// 关键：书首目录（TOC）里同样会出现章标题（常见带 ](#锚点) 链接），
// 朴素 indexOf 会命中目录而非正文 → 切出来的是目录残行、正文为空。
// 因此对每个出现位置按「像不像正文标题行」打分，只从正文候选里按章序单调选锚。
// 打分依据：行首或仅 # 前缀、短独占行 = 正文标题（加分）；含 ](# 链接、
// 点线/制表符+页码 = 目录条目（减分）。
// 位置索引的算法版本。定位逻辑升级后 +1，已存的大纲（localStorage）因版本落后
// 会在读取时自动重算一次——纯前端、零 token，用户不必重生成大纲。
export const CHAPTER_INDEX_VERSION = 2;

export function indexChapterPositions(material, outline) {
  if (!material || !outline || !Array.isArray(outline.chapters)) return;
  const mat = material; // 原文（不截断）
  const totalLen = mat.length;
  const chapters = outline.chapters;
  const N = chapters.length;
  if (N === 0) return;

  const findAll = (needle) => {
    const occ = [];
    if (!needle) return occ;
    let p = mat.indexOf(needle);
    while (p >= 0) { occ.push(p); p = mat.indexOf(needle, p + 1); }
    return occ;
  };
  const headingScore = (p, needle) => {
    const ls = mat.lastIndexOf("\n", p) + 1;
    let le = mat.indexOf("\n", p);
    if (le < 0) le = mat.length;
    const line = mat.slice(ls, le);
    const before = line.slice(0, p - ls);
    let s = 0;
    if (/^\s{0,4}(#{1,6}\s+)?$/.test(before)) s += 3; // 行首（可有 markdown 标题前缀）
    if (line.trim().length <= Math.max(needle.length + 8, 40)) s += 2; // 短独占行
    if (/\]\(#/.test(line)) s -= 4; // markdown 目录锚点链接
    if (/\.{6,}|…\s*\d+\s*$|\t\s*\d+\s*$/.test(line)) s -= 2; // 点线/页码式目录
    return s;
  };

  // 1) 每章求「正文标题」候选位置池（升序）。候选标题逐级降级：
  //    完整标题 → 「第X章」核心段 → 前 12 字。同一章用首个有候选的级别。
  const found = chapters.map((ch) => {
    const t = ((ch && ch.title) || "").trim();
    if (!t) return -1;
    const variants = [t];
    const m = t.match(/(第[^章\s]+[章节部分])/);
    if (m && m[1] !== t) variants.push(m[1]);
    if (t.length > 6) variants.push(t.slice(0, 12));
    for (const v of variants) {
      const occs = findAll(v);
      if (!occs.length) continue;
      const bodyOccs = occs.filter((p) => headingScore(p, v) > 0);
      // 有正文样候选就用它们；全都不像正文则退回全量位置（保持旧行为）
      const pool = (bodyOccs.length ? bodyOccs : occs).slice().sort((a, b) => a - b);
      return pool;
    }
    return -1;
  });

  // 1.5) 目录块检测（20260913）：纯文本排版的书（.txt / 从 docx 导出）常见「书首一段目录 +
  //      之后才是正文」，而目录行【不带任何 markdown 特征】：`第一章 环境` 单独成行 →
  //      行首 +3、短行 +2 = 5 分，与正文里的 `## 第一章 环境` 完全同分，headingScore 区分不开。
  //      于是所有章都锚到了书首目录那几行：前 N-1 章的范围塌成一行标题（实测 7 个字），
  //      最后一章因为 ends[N-1] = totalLen 而吞下整本书 —— 上课时老师拿到的"本课材料"
  //      就只有一行章标题，却被告知"已按本课知识点在所属章内定位切出"。
  //      判据：前若干章的首个候选密集落在一小段里（目录每行只有十几到几十字），
  //      且这些标题在该段【之后】仍有出现（否则目录就是唯一出处，不能丢）。
  const TOC_GAP_MAX = 200;   // 相邻两章标题在目录里的最大间距
  const TOC_SPAN_MAX = 1200; // 整个目录块的跨度上限
  let tocEnd = 0;
  {
    const firstPick = found.map((f) => (Array.isArray(f) && f.length ? f[0] : -1));
    let k = 0;
    while (k < N && firstPick[k] >= 0 && (k === 0 || firstPick[k] - firstPick[k - 1] <= TOC_GAP_MAX)) k++;
    if (k >= 3 && firstPick[k - 1] - firstPick[0] <= TOC_SPAN_MAX) {
      const end = firstPick[k - 1] + 1;
      const hasLater = found.slice(0, k).some((f) => f.some((p) => p >= end));
      if (hasLater) tocEnd = end;
    }
  }

  // 2) 计算每章 [charStart, charEnd]：
  //    每章从其候选池中取第一个 ≥ prevPos 的位置作锚（严格递增）；
  //    拿不到锚的章在相邻锚点之间按比例均分。
  //    （修复旧版「找不到标题时级联塌缩成 [0,totalLen] / 其余全空」的 bug）
  const starts = new Array(N).fill(-1);
  let prevPos = tocEnd; // 有目录块时从它之后开始找正文锚点，避免整本书都锚进目录
  const anchors = []; // 严格递增的已定位锚点
  for (let i = 0; i < N; i++) {
    if (Array.isArray(found[i])) {
      // +1 让锚点【严格递增】。旧写法是 prevPos = pick（原地不动），于是同名章、或只能匹配到
      // 同一处出现的章，会取到完全相同的锚点位置，再被下面的单调化顶成 +1 ——
      // 前一章只剩 1 个字符（实测 章1 [0,1) len=1）。取不到锚的章改走"相邻锚点间按比例均分"，
      // 那才是这种情况的正确退路。
      const pick = found[i].find((p) => p >= prevPos);
      if (typeof pick === "number") { anchors.push({ i, p: pick }); prevPos = pick + 1; }
    }
  }
  const pts = [{ i: -1, p: 0 }, ...anchors, { i: N, p: totalLen }];
  if (anchors.length === 0) {
    // 一章都没定位到 → 按 totalLen*i/N 均分（第一章从 0 开始、覆盖全书），
    // 而不是把 N 章塞进 (0,totalLen) 的 (N+1) 等份里（那会让书头 1/(N+1) 永远看不到）。
    for (let i = 0; i < N; i++) starts[i] = Math.floor(totalLen * i / N);
  } else {
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      const gapCount = b.i - a.i - 1; // a 与 b 之间未定位的章数
      const span = Math.max(b.p - a.p, gapCount + 1);
      if (a.i >= 0) starts[a.i] = a.p;
      for (let m = 1; m <= gapCount; m++) {
        starts[a.i + m] = a.p + Math.round(span * m / (gapCount + 1));
      }
    }
  }
  // 兜底 + 保证单调不减（理论不会 -1，但保险）
  for (let i = 0; i < N; i++) {
    if (starts[i] < 0) starts[i] = Math.floor(totalLen * i / N);
    if (i > 0 && starts[i] <= starts[i - 1]) starts[i] = starts[i - 1] + 1;
  }
  if (starts[N - 1] >= totalLen) starts[N - 1] = Math.max(0, totalLen - 1);
  const ends = starts.map((s, i) => (i === N - 1 ? totalLen : starts[i + 1]));

  // 3) 把章位置写回 outline 数据，再在章内定位每课
  chapters.forEach((ch, ci) => {
    if (!ch) return;
    ch._charStart = starts[ci];
    ch._charEnd = ends[ci];
  });
  indexLessonPositions(mat, outline);
  outline._indexVersion = CHAPTER_INDEX_VERSION;
}

// 是否需要（重）算位置索引：从未算过，或算过时用的算法版本落后于当前实现。
// 旧数据上已有 _charStart/_charEnd（可能是老版本的均分/目录误命中结果），
// 只判断「字段是否存在」会让它们永远用不上新的定位逻辑。
export function needsReindex(outline) {
  if (!outline || !Array.isArray(outline.chapters)) return false;
  if (outline._indexVersion !== CHAPTER_INDEX_VERSION) return true;
  return outline.chapters.some((ch) => typeof (ch && ch._charStart) !== "number") ||
    outline.chapters.some((ch) => ((ch && ch.lessons) || []).some((ls) => ls && typeof ls._charStart !== "number"));
}

// ---- 课时位置索引（章内关键词定位，必须在 indexChapterPositions 之后）----
// 课时标题/知识点是模型自拟的，原文里未必有对应小标题，但 keyPoints 里的概念名词
// 通常就出自原文。因此在【章区间内】搜索这些关键词定位每课，比整章均分准得多：
// 章内搜索范围小、误命中少；并用「均分位置」作先验，取离先验最近的命中，
// 避免同一概念在章内反复出现时被拉到错误的一头。
// 定位不到的课时仍退化为相邻锚点间的比例均分，并标记 _located=false，
// 调用方（sliceMaterialForLesson）据此决定是信这段还是退回整章。
export function indexLessonPositions(material, outline) {
  if (!material || !outline || !Array.isArray(outline.chapters)) return;
  const chapters = outline.chapters;
  chapters.forEach((ch) => {
    if (!ch) return;
    const lessons = Array.isArray(ch.lessons) ? ch.lessons.filter(Boolean) : [];
    const n = lessons.length;
    if (n === 0) return;
    const s0 = typeof ch._charStart === "number" ? Math.max(0, ch._charStart) : 0;
    const e0 = typeof ch._charEnd === "number" ? Math.min(material.length, ch._charEnd) : material.length;
    if (e0 <= s0) { lessons.forEach((ls) => { ls._charStart = s0; ls._charEnd = s0; ls._located = false; }); return; }
    if (n === 1) { lessons[0]._charStart = s0; lessons[0]._charEnd = e0; lessons[0]._located = true; return; }

    // 1) 每课收集章区间内的关键词命中位置（title + keyPoints，限量避免超长扫描）
    const cand = lessons.map((ls, li) => {
      const kws = [];
      const t = (ls.title || "").trim();
      if (t.length >= 2) kws.push(t);
      (Array.isArray(ls.keyPoints) ? ls.keyPoints : []).forEach((k) => {
        if (typeof k === "string" && k.trim().length >= 2) kws.push(k.trim());
      });
      const prior = s0 + Math.round((e0 - s0) * li / n); // 均分先验（兜底 + 消歧）
      const pos = [];
      kws.slice(0, 12).forEach((kw) => {
        let p = material.indexOf(kw, s0);
        let guard = 0;
        while (p >= 0 && p < e0 && guard < 200) { pos.push(p); guard++; p = material.indexOf(kw, p + 1); }
      });
      return { pos: pos.sort((a, b) => a - b), prior };
    });

    // 2) 按课序单调选锚：取「≥ 上一锚 且 离均分先验最近」的命中
    const anchors = [];
    let prev = s0;
    cand.forEach((c, li) => {
      if (!c.pos.length) return;
      let best = -1, bestD = Infinity;
      for (const p of c.pos) {
        if (p <= prev) continue;
        const d = Math.abs(p - c.prior);
        if (d < bestD) { bestD = d; best = p; }
      }
      if (best < 0) return; // 命中全在上一锚之前 → 不设锚，交给比例均分
      anchors.push({ li, p: best });
      prev = best;
    });

    // 3) 锚点之间按比例均分，得到每课 [start, end)
    const starts = new Array(n).fill(-1);
    const pts = [{ li: -1, p: s0 }, ...anchors, { li: n, p: e0 }];
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      const gapCount = b.li - a.li - 1;
      const span = Math.max(b.p - a.p, gapCount + 1);
      if (a.li >= 0) starts[a.li] = a.p;
      for (let m = 1; m <= gapCount; m++) {
        starts[a.li + m] = a.p + Math.round(span * m / (gapCount + 1));
      }
    }
    const anchored = new Set(anchors.map((a) => a.li));
    // 兜底 + 单调不减 + 夹在章区间内
    for (let i = 0; i < n; i++) {
      if (starts[i] < s0) starts[i] = s0;
      if (i > 0 && starts[i] <= starts[i - 1]) starts[i] = starts[i - 1] + 1;
      if (starts[i] >= e0) starts[i] = Math.max(s0, e0 - 1);
    }
    lessons.forEach((ls, li) => {
      ls._charStart = starts[li];
      ls._charEnd = (li === n - 1 ? e0 : starts[li + 1]);
      ls._located = anchored.has(li);
    });
  });
}
