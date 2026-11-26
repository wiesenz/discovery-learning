/* =====================================================================
 *  js/config.test.mjs —— APP_CONFIG.limits 派生自洽性单测
 *  ---------------------------------------------------------------------
 *  守护的不变量（2026-09-08 重构后补）：
 *    所有「长度预算」都由 ctxWindow 派生，但各项还带写死的下限
 *    （chunk 20000 / 单课切片 40000 / shortBook 16000 / 群聊 12000 / 拆章 60000）。
 *    这些下限本意是「别把块切得太碎」，但如果不拿窗口再夹一次，小窗口模型下
 *    它们会反超窗口本身 —— 表现为：
 *      · outlineWholeBookMaxChars 算成负数 → 整书路径永不可达（100 字的书也走分块）
 *      · chunkSoftChars / lessonSliceChars 超过软上限 → 分块或切片直接撑爆上下文
 *    本测试把「任何预算都不得超出窗口输入容量」钉死，防止该 bug 回归。
 *
 *  运行：node js/config.test.mjs
 * ===================================================================== */

import { APP_CONFIG } from "../config.js";
// core.js 是 UMD(classic script)，在 ESM 里按 CJS 默认导入取到整个导出对象
// （不能写具名导入 —— cjs-module-lexer 认不出对象字面量里的 `apiTimeoutMs:` 写法）
import Core from "./core.js";

const C = 1.6; // CHARS_PER_TOK，与 config.js / core.js 的估算口径一致

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log("  ✓ " + name);
  } else {
    fail++;
    console.log("  ✗ " + name + (detail ? "  → " + detail : ""));
  }
}

// 会被测的窗口档位：覆盖小窗口（历史上会炸）、中等、以及默认的 1M
const WINDOWS = [8000, 16000, 32000, 46000, 64000, 128000, 1000000];
// 字符型预算（会被拿去和窗口容量比较）
const CHAR_KEYS = [
  "outlineWholeBookMaxChars",
  "chunkSoftChars",
  "lessonSliceChars",
  "shortBookChars",
  "groupTranscriptCapChars",
  "maxCharsPerChapter",
];

const original = APP_CONFIG.ctxWindow;

console.log("limits 派生自洽性（各窗口档位）");
for (const cw of WINDOWS) {
  APP_CONFIG.ctxWindow = cw;
  const L = APP_CONFIG.limits;
  const soft = cw * 0.85;
  const inputChars = Math.max(0, Math.floor(soft * C)); // 窗口能容纳的输入字符上限

  // 1) 全部为有限数且非负
  const allNumeric = CHAR_KEYS.every((k) => typeof L[k] === "number" && Number.isFinite(L[k]));
  ok(`ctxWindow=${cw} 各项均为有限数`, allNumeric,
    allNumeric ? "" : CHAR_KEYS.map((k) => k + "=" + L[k]).join(","));
  const allNonNeg = CHAR_KEYS.every((k) => L[k] >= 0);
  // 注：整书门槛为 0 是「该窗口下整书直读确实不可行」的合法表达（8K/16K 窗口塞不下
  //     整本书 + 约 20K token 的系统提示与输出），不是 bug；负数才是 bug。
  ok(`ctxWindow=${cw} 各项非负（整书门槛为 0 表示不可用，合法）`, allNonNeg,
    allNonNeg ? "" : CHAR_KEYS.map((k) => k + "=" + L[k]).join(","));

  // 2) 关键不变量：任何字符预算都不得超出窗口输入容量
  for (const k of CHAR_KEYS) {
    ok(`ctxWindow=${cw} ${k}=${L[k]} 未超窗口容量(${inputChars})`, L[k] <= inputChars + 1,
      L[k] > inputChars + 1 ? `${k} 折合 ${Math.round(L[k] / C)} token > 软上限 ${Math.round(soft)}` : "");
  }
}

// ---- 输出预算（max_tokens）----
// 2026-09-08 修：整书优先后大纲要一次吐出全书 JSON，但两条路径原先都没传 max_tokens，
// 落到 provider 默认 4096 → 吐到一半被截断 → JSON 不完整 → 「大纲生成不了」。
// 这里钉死：输出预算必须显式给足，同时不得超出模型能力与窗口软上限。
console.log("输出预算 outlineOutputMaxTok（防大纲 JSON 被截断回归）");
for (const cw of WINDOWS) {
  APP_CONFIG.ctxWindow = cw;
  const L = APP_CONFIG.limits;
  const soft = cw * 0.85;
  ok(`ctxWindow=${cw} outlineOutputMaxTok 为有限数`,
    typeof L.outlineOutputMaxTok === "number" && Number.isFinite(L.outlineOutputMaxTok),
    "实际 " + L.outlineOutputMaxTok);
  ok(`ctxWindow=${cw} outlineOutputMaxTok 不低于 provider 默认 4096`,
    L.outlineOutputMaxTok >= 4096, "实际 " + L.outlineOutputMaxTok);
  ok(`ctxWindow=${cw} outlineOutputMaxTok 未超模型能力(${APP_CONFIG.maxOutputTokens})`,
    L.outlineOutputMaxTok <= APP_CONFIG.maxOutputTokens, "实际 " + L.outlineOutputMaxTok);
  ok(`ctxWindow=${cw} outlineOutputMaxTok 未超窗口软上限(${Math.round(soft)})`,
    L.outlineOutputMaxTok <= soft, "实际 " + L.outlineOutputMaxTok);
  ok(`ctxWindow=${cw} outlineAdviceMaxTok 有效`, L.outlineAdviceMaxTok >= 2000,
    "实际 " + L.outlineAdviceMaxTok);
}

// ---- 结构化 JSON 输出预算（B7 回归护栏，2026-09-10）----
// 旧 bug：下课总结 / 角色补全 / 画像重梳理三处期望严格 JSON 的调用都没传 max_tokens，
// 落到 provider 默认 4096。下课产出的最坏形状（summary + 3~5 题 × 4 条逐项解析 + memory +
// userProfile + notes + 覆盖度）约 4400 字符，模型写详细时翻倍 → 截断 → JSON 不完整 →
// 表现为「小结解析失败」，且错误文案不指向真因（与 B1 大纲截断同族）。
console.log("结构化 JSON 输出预算 structuredOutputMaxTok（B7 回归护栏）");
for (const cw of WINDOWS) {
  APP_CONFIG.ctxWindow = cw;
  const L = APP_CONFIG.limits;
  const soft = cw * 0.85;
  ok(`ctxWindow=${cw} structuredOutputMaxTok 为有限数`,
    typeof L.structuredOutputMaxTok === "number" && Number.isFinite(L.structuredOutputMaxTok),
    "实际 " + L.structuredOutputMaxTok);
  ok(`ctxWindow=${cw} structuredOutputMaxTok 不低于 provider 默认 4096`,
    L.structuredOutputMaxTok >= 4096, "实际 " + L.structuredOutputMaxTok);
  ok(`ctxWindow=${cw} structuredOutputMaxTok 未超模型能力(${APP_CONFIG.maxOutputTokens})`,
    L.structuredOutputMaxTok <= APP_CONFIG.maxOutputTokens, "实际 " + L.structuredOutputMaxTok);
  ok(`ctxWindow=${cw} structuredOutputMaxTok 未超窗口软上限(${Math.round(soft)})`,
    L.structuredOutputMaxTok <= soft, "实际 " + L.structuredOutputMaxTok);
}
// 非空转护栏：默认档位必须**严格大于** 4096 —— 等于 4096 就等于没修（仍是 provider 默认值）
APP_CONFIG.ctxWindow = 1000000;
const S_DEFAULT = APP_CONFIG.limits.structuredOutputMaxTok;
ok("默认 1M 档位 structuredOutputMaxTok 严格大于 provider 默认（否则本修复为空转）",
  S_DEFAULT > 4096, "实际 " + S_DEFAULT);
// 随 maxOutputTokens 收紧：换成输出上限更小的模型时不得反超该模型能力
// （本块自己存还，不复用下方 originalMaxOut —— 那是个尚未声明的 const，提前引用会 TDZ 报错）
const maxOutBeforeB7 = APP_CONFIG.maxOutputTokens;
APP_CONFIG.maxOutputTokens = 8192;
ok("maxOutputTokens=8192 时 structuredOutputMaxTok 不超过 8192",
  APP_CONFIG.limits.structuredOutputMaxTok <= 8192, "实际 " + APP_CONFIG.limits.structuredOutputMaxTok);
APP_CONFIG.maxOutputTokens = 4096;
ok("maxOutputTokens=4096（小输出模型）时退到 4096 而非反超",
  APP_CONFIG.limits.structuredOutputMaxTok === 4096, "实际 " + APP_CONFIG.limits.structuredOutputMaxTok);
APP_CONFIG.maxOutputTokens = maxOutBeforeB7;
APP_CONFIG.ctxWindow = 1000000;

// ---- B8 回归护栏：请求超时必须与「该次请求的输出预算」联动 ----
// 旧 bug：全部调用共用一个写死的 300s（app.js 的 API_TIMEOUT_MS）。它只按"整书 prefill 慢"
// 调过一次（180→300s），而整书直读门槛随后从 8000 字抬到 192 000 字（24 倍），超时再没复核。
// 模型慢时（推理型 10~20 token/s）65536 token 的产出要 3000s+，5 分钟就被 abort，
// 用户看到的是"大纲生成失败"，真因却是超时。现在按输出预算派生（core.apiTimeoutMs）。
console.log("请求超时 × 输出预算（B8 回归护栏）");
{
  const T = APP_CONFIG.apiTimeout;
  ok("apiTimeout 三参数均为正数",
    T && T.baseMs > 0 && T.perTokMs > 0 && T.capMs > 0, JSON.stringify(T));
  ok("capMs ≥ baseMs（上限不得低于基础开销）", T.capMs >= T.baseMs);
  const tChat = Core.apiTimeoutMs(4096, T);
  const tStruct = Core.apiTimeoutMs(APP_CONFIG.limits.structuredOutputMaxTok, T);
  const tOutline = Core.apiTimeoutMs(APP_CONFIG.limits.outlineOutputMaxTok, T);
  ok("聊天类(4096) 不低于 baseMs", tChat >= T.baseMs, "实际 " + tChat);
  ok("结构化 > 聊天（输出预算更大就该等更久）", tStruct > tChat, `${tStruct} vs ${tChat}`);
  ok("大纲 > 结构化", tOutline > tStruct, `${tOutline} vs ${tStruct}`);
  ok("均不超 capMs", [tChat, tStruct, tOutline].every((v) => v <= T.capMs));
  // 非空转护栏：大纲预算下必须**严格大于**旧的写死值 300000，否则本修复没有任何效果
  ok("大纲超时严格大于旧的写死 300s（否则本修复为空转）", tOutline > 300000, "实际 " + tOutline);
  // 真实口径：整书直读用的就是 outlineOutputMaxTok 作 max_tokens（见 app.js 的调用点）
  ok("整书直读请求的超时 = apiTimeoutMs(outlineOutputMaxTok)",
    tOutline === Core.apiTimeoutMs(APP_CONFIG.limits.outlineOutputMaxTok, APP_CONFIG.apiTimeout));
}

// ---- 默认 1M 档位的确切取值（行为回归护栏：改动夹值逻辑不得悄悄改变 1M 下的行为）----
console.log("默认 1M 档位取值（回归护栏）");
APP_CONFIG.ctxWindow = 1000000;
const D = APP_CONFIG.limits;
ok("outlineWholeBookMaxChars = 192000（1M+DeepSeek 可靠区 60%）", D.outlineWholeBookMaxChars === 192000, "实际 " + D.outlineWholeBookMaxChars);
ok("chunkSoftChars = 80000（有效区 25%）", D.chunkSoftChars === 80000, "实际 " + D.chunkSoftChars);
ok("lessonSliceChars = 108800", D.lessonSliceChars === 108800, "实际 " + D.lessonSliceChars);
ok("shortBookChars = 16000", D.shortBookChars === 16000, "实际 " + D.shortBookChars);
ok("maxCharsPerChapter = 544000", D.maxCharsPerChapter === 544000, "实际 " + D.maxCharsPerChapter);
ok("groupTranscriptCapChars = 136000", D.groupTranscriptCapChars === 136000, "实际 " + D.groupTranscriptCapChars);
ok("structuredOutputMaxTok = 8192（结构化 JSON 输出预算）", D.structuredOutputMaxTok === 8192, "实际 " + D.structuredOutputMaxTok);

// ---- 单调性：窗口变大，整书门槛不应变小（派生方向正确）----
console.log("派生方向（窗口越大，整书门槛不减）");
let prev = -1;
let monotonic = true;
for (const cw of WINDOWS) {
  APP_CONFIG.ctxWindow = cw;
  const v = APP_CONFIG.limits.outlineWholeBookMaxChars;
  if (v < prev) monotonic = false;
  prev = v;
}
ok("outlineWholeBookMaxChars 随窗口单调不减", monotonic);

// ---- B5 不变式：拆章阈值不得小于单块上限（否则任何多块章都会被无谓拆成 (1)(2)(3)）----
console.log("拆章阈值 ≥ 单块上限（B5 基口径护栏）");
for (const cw of WINDOWS) {
  APP_CONFIG.ctxWindow = cw;
  const L = APP_CONFIG.limits;
  ok(`ctxWindow=${cw} maxCharsPerChapter(${L.maxCharsPerChapter}) ≥ chunkSoftChars(${L.chunkSoftChars})`,
    L.maxCharsPerChapter >= L.chunkSoftChars);
}

// 还原，避免污染同进程内后续用例
APP_CONFIG.ctxWindow = original;

// ---- B1 回归护栏：整书门槛必须与「输出预算」联动 ----
// 旧 bug：整书门槛只由可靠区派生，与 maxOutputTokens 零耦合。把 maxOutputTokens 调到
// 8K/16K（换成小输出模型）后仍按 192K 放行整书直读 → 大纲 JSON 被截断 → 「结果无法解析」。
// 现将门槛按输出预算反算并取小；这里钉死「输出小 → 门槛收紧、且随输出预算单调不减」。
console.log("整书门槛 × 输出预算耦合（B1 回归护栏）");
const originalMaxOut = APP_CONFIG.maxOutputTokens;
APP_CONFIG.ctxWindow = 1000000;
APP_CONFIG.maxOutputTokens = 65536;
const wbBig = APP_CONFIG.limits.outlineWholeBookMaxChars;
APP_CONFIG.maxOutputTokens = 8192;
const wbSmall = APP_CONFIG.limits.outlineWholeBookMaxChars;
ok("输出预算调小后整书门槛收紧（不再盲目放行整本）", wbSmall < wbBig,
  `8K→${wbSmall} vs 64K→${wbBig}`);
ok("输出预算调小后整书门槛仍为正数（短资料快捷路径仍可用）", wbSmall > 0, "实际 " + wbSmall);
let prevWb = -1, wbMonotonic = true;
for (const mo of [4096, 8192, 16384, 32768, 65536]) {
  APP_CONFIG.maxOutputTokens = mo;
  const v = APP_CONFIG.limits.outlineWholeBookMaxChars;
  if (v < prevWb) wbMonotonic = false;
  prevWb = v;
}
ok("整书门槛随输出预算单调不减", wbMonotonic);
APP_CONFIG.maxOutputTokens = originalMaxOut;
// 默认档位（1M + 64K 输出）不应被输出预算侧改变行为：仍是 192000
ok("默认档位整书门槛不受输出侧影响（仍 192000）",
  APP_CONFIG.limits.outlineWholeBookMaxChars === 192000,
  "实际 " + APP_CONFIG.limits.outlineWholeBookMaxChars);

// ---- B4：单章最多课时数已入 config（原先 12 写死在 js/outline.js）----
ok("outlineMaxLessonsPerChapter 为正整数",
  Number.isInteger(APP_CONFIG.outlineMaxLessonsPerChapter) && APP_CONFIG.outlineMaxLessonsPerChapter > 0,
  "实际 " + APP_CONFIG.outlineMaxLessonsPerChapter);

// ---- 提示词质量锁：课时开场必须数据驱动承上 + 入题锚定材料 ----
// （2026-09-08 修复「换章突兀 / 为提问而提问」：章导语 bridge + 入题落到材料原话）
console.log("课时开场规则（承上/入题）短语锁");
ok("lessonStartRules 要求章级承上 bridge", APP_CONFIG.lessonStartRules.includes("章级承上 bridge"));
ok("lessonStartRules 禁止杜撰上一章内容", APP_CONFIG.lessonStartRules.includes("不要杜撰"));
ok("lessonStartRules 入题必须锚定材料原话", APP_CONFIG.lessonStartRules.includes("落到本课材料里的具体原话"));
ok("lessonStartRules 禁止为提问而提问", APP_CONFIG.lessonStartRules.includes("不要为了提问而提问"));
ok("lessonStartRules 点题用 whyImportant 价值锚点", APP_CONFIG.lessonStartRules.includes("whyImportant"));
ok("outlineRules 要求每章产出 bridge 字段", APP_CONFIG.outlineRules.includes('"bridge"'));
ok("outlineRules 课时含 whyImportant 字段", APP_CONFIG.outlineRules.includes('"whyImportant"'));
// 长书分块路径必须与整书直读路径产出完全一致的字段：bridge/whyImportant 不能只对短书生效
ok("outlineChunkRules 章级产出 bridge 字段", APP_CONFIG.outlineChunkRules.includes('"bridge"'));
ok("outlineChunkRules 课时产出 whyImportant 字段", APP_CONFIG.outlineChunkRules.includes('"whyImportant"'));
ok("outlineChunkRules 要求每章必出 bridge", APP_CONFIG.outlineChunkRules.includes("bridge 每章必出"));
ok("outlineChunkRules 要求每课必出 whyImportant", APP_CONFIG.outlineChunkRules.includes("每课必须输出 whyImportant"));
// 死字段清理：materialHint 已从大纲 schema 移除（材料定位改由 keyPoints 章内关键词检索，不再需要模型标注范围）
ok("outlineRules 不再含死字段 materialHint", !APP_CONFIG.outlineRules.includes("materialHint"));

// ---- socraticRules 课内导航锁：防「为提问而提问」在课中复发 ----
// （batch 2：每个追问对齐 logicFlow 节点、连续追问后搭桥小结、已懂即停）
console.log("socraticRules 课内导航（问题目的/搭桥节奏/已懂即停）短语锁");
ok("socraticRules 要求问题对齐 logicFlow 节点", APP_CONFIG.socraticRules.includes("对齐到本课 logicFlow"));
ok("socraticRules 要求连续追问后搭桥小结", APP_CONFIG.socraticRules.includes("搭桥小结是合法动作"));
ok("socraticRules 要求已懂即停", APP_CONFIG.socraticRules.includes("已懂即停"));
ok("socraticRules 禁止凑数问题", APP_CONFIG.socraticRules.includes("凑数"));

console.log("\n" + (fail === 0 ? `config 测试全部通过 ✓ (${pass} 项)` : `config 测试有失败 ✗ (${pass} 通过 / ${fail} 失败)`));
if (fail > 0) process.exitCode = 1;
