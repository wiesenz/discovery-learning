/* =====================================================================
 *  Socratopia v0 · 纯函数单元测试（node js/core.test.js）
 *  ---------------------------------------------------------------------
 *  无第三方依赖，纯 Node 跑。覆盖最容易出错的 JSON 容错解析与 token 估算。
 * ===================================================================== */
const C = require("./core.js");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}
function eq(name, a, b) { ok(name + " (得到 " + JSON.stringify(a) + ")", a === b); }

console.log("estimateTokens");
eq("空串为 0", C.estimateTokens(""), 0);
eq("160 字约 100 token", C.estimateTokens("字".repeat(160)), 100);
eq("null 安全", C.estimateTokens(null), 0);

console.log("parseLessonJson");
ok("正常 JSON", !!C.parseLessonJson('{"summary":"x","quiz":[]}').summary);
ok("带 markdown 代码块", !!C.parseLessonJson('```json\n{"summary":"好的","quiz":[]}\n```').summary);
ok("前后夹缠文字", C.parseLessonJson('嗨，这是结果：{"summary":"总结","quiz":[]} 完毕').summary === "总结");
ok("尾逗号可修复", C.parseLessonJson('{"summary":"a","quiz":[],}').summary === "a");
ok("无 summary 返回 null", C.parseLessonJson('{"foo":"bar"}') === null);
ok("完全非法返回 null", C.parseLessonJson("今天天气不错") === null);
ok("仅 summary 字段被正则兜底", C.parseLessonJson('垃圾{"summary":"兜底总结"}更多垃圾').summary === "兜底总结");
ok("转义引号保留", C.parseLessonJson('{"summary":"他说\\"你好\\"","quiz":[]}').summary === '他说"你好"');
ok("含 notes 字段", !!C.parseLessonJson('{"summary":"x","quiz":[],"notes":{"coreQuestions":["q1"]}}').notes);
ok("notes.myAnswers 透传", (C.parseLessonJson('{"summary":"x","notes":{"myAnswers":"我学到了"}}').notes || {}).myAnswers === "我学到了");
ok("summary 为空字符串也接受", C.parseLessonJson('{"summary":"","quiz":[]}') !== null);
ok("截断 JSON 仍正则兜底 summary", C.parseLessonJson('{"summary":"兜底","quiz":[{"q":"题"}').summary === "兜底");
ok("嵌套对象/数组正则提取", (C.parseLessonJson('{"summary":"s","memory":{"mastered":["a"]},"notes":{"coreQuestions":["q"]}}').memory || {}).mastered[0] === "a");
ok("字段顺序打乱仍可解析", !!C.parseLessonJson('{"notes":{"coreQuestions":[]},"summary":"s"}').summary);
ok("summary 含转义引号与换行", C.parseLessonJson('{"summary":"第一行\\n第二行\\"重点\\""}').summary.indexOf("\n") >= 0);

console.log("parseOutlineJson");
ok("正常大纲", !!C.parseOutlineJson('{"chapters":[{"title":"第一章","lessons":[]}]}').chapters);
ok("无 chapters 返回 null", C.parseOutlineJson('{"foo":1}') === null);
ok("带代码块", !!C.parseOutlineJson('```\n{"chapters":[]}\n```').chapters);

console.log("parseRoleJson");
ok("正常 JSON", C.parseRoleJson('{"persona":"p","voice":"v","openingLine":"o","userAlias":"u","thinkingPhrases":["t1"]}').persona === "p");
ok("仅 voice 也接受", C.parseRoleJson('{"voice":"v"}').voice === "v");
ok("仅 persona 也接受", C.parseRoleJson('{"persona":"p"}').persona === "p");
ok("无 persona/voice 返回 null", C.parseRoleJson('{"foo":"bar"}') === null);
ok("非法文本返回 null", C.parseRoleJson("今天天气不错") === null);
ok("带 markdown 代码块", C.parseRoleJson('```json\n{"persona":"p","voice":"v"}\n```').persona === "p");
ok("前后夹缠文字", C.parseRoleJson('这是：{"persona":"p","voice":"v"} 完').voice === "v");
ok("thinkingPhrases 过滤空串", C.parseRoleJson('{"persona":"p","thinkingPhrases":["a","","b"]}').thinkingPhrases.length === 2);
ok("persona 首尾空白被 trim", C.parseRoleJson('{"persona":"  p  ","voice":"v"}').persona === "p");

console.log("truncateMaterialInPrompt");
const prompt = "系统规则\n<<<<<<\n" + "资料".repeat(2000) + "\n>>>>>>\n更多规则";
const trunc = C.truncateMaterialInPrompt(prompt, 500);
ok("超长被截断", trunc.length < prompt.length);
ok("材料段标记保留", trunc.indexOf("<<<<") >= 0 && trunc.indexOf(">>>>>>") >= 0);

console.log("friendlyApiError");
eq("AbortError 给友好提示", C.friendlyApiError({ name: "AbortError" }), "已停止（点击了「⏹ 停止」或请求超时）");
eq("普通错误回退 message", C.friendlyApiError({ message: "接口返回 401" }), "接口返回 401");
eq("无 message 回退 String", C.friendlyApiError("boom"), "boom");

console.log("normalizeKpToLesson");
ok("空 kp 返回空串", C.normalizeKpToLesson("", ["稀缺心态"]) === "");
ok("候选为空返回原 kp", C.normalizeKpToLesson("稀缺心态", []) === "稀缺心态");
ok("完全相同直接归并", C.normalizeKpToLesson("稀缺心态", ["稀缺心态", "其他"]) === "稀缺心态");
ok("kp 含候选子串 → 归并到短规范短语", C.normalizeKpToLesson("稀缺心态的三个特征", ["稀缺心态", "其他"]) === "稀缺心态");
ok("候选含 kp 子串 → 归并到本课 keyPoint", C.normalizeKpToLesson("稀缺心态", ["稀缺心态的三个特征"]) === "稀缺心态的三个特征");
ok("无相似返回原 kp（不误并）", C.normalizeKpToLesson("程序卡死原因", ["死循环卡死"]) === "程序卡死原因");
ok("部分重叠 LCS≥0.5 归并", C.normalizeKpToLesson("循环导致卡死", ["死循环卡死"]) === "死循环卡死");
ok("选最贴近候选而非相似度低的", C.normalizeKpToLesson("稀缺心态特征", ["稀缺心态", "完全无关x"]) === "稀缺心态");

console.log("reanchorLessonsByContent");
const mat = "第一章 稀缺心态\n稀缺心态有三个特征。\n第二章 繁荣\n繁荣需要规划。";
const ce = mat.indexOf("第二章");
const outline = {
  chapters: [
    { title: "第一章 稀缺心态", _charStart: 0, _charEnd: ce, lessons: [
      { title: "稀缺心态的三个特征", focus: "什么是稀缺心态", keyPoints: ["稀缺心态"] },
    ] },
    { title: "第二章 繁荣", _charStart: ce, _charEnd: mat.length, lessons: [
      { title: "繁荣的规划", keyPoints: ["繁荣规划", "不存在的词zzz"] },
    ] },
  ],
};
C.reanchorLessonsByContent(mat, outline);
const L1 = outline.chapters[0].lessons[0];
ok("知识点命中后标记 _anchored", L1._anchored === true);
ok("课时切片锚到知识点所在区段（起点随章）", L1._charStart === 0);
ok("课时切片终点覆盖知识点之后", L1._charEnd > L1._charStart);
const L2 = outline.chapters[1].lessons[0];
ok("章内课时单调（不重叠）", L2._charStart >= L1._charEnd);
ok("章末课时收口到章尾", L2._charEnd === mat.length);
// 锚点短语不在章内 → 非末课保留原（比例）定位，不误动；末课收口到章尾
const mat2 = "aaaa Chapter1 bbbb\nChapter2 cccc\n";
const ce2 = mat2.indexOf("Chapter2");
const outline2 = { chapters: [{ title: "Chapter1", _charStart: 0, _charEnd: ce2, lessons: [
  { title: "课1", _charStart: 2, _charEnd: 6, keyPoints: ["zzz不存在"] },
  { title: "课2", _charStart: 6, _charEnd: ce2, keyPoints: ["qqq不存在"] },
] }] };
C.reanchorLessonsByContent(mat2, outline2);
const Lx = outline2.chapters[0].lessons[0];
ok("无锚点的非末课保留原有定位", Lx._charStart === 2 && Lx._charEnd === 6);
ok("无锚点时不标记 _anchored", Lx._anchored === undefined);
ok("末课收口到章尾", outline2.chapters[0].lessons[1]._charEnd === ce2);

// 间隙漏读修复：相邻两课都被锚定且锚点间相距较远时，课一 end 应延伸到课二 start，过渡段不漏读
const fillerA = "x".repeat(2500), fillerB = "x".repeat(3500);
const mat3 = "第A章" + fillerA + "稀缺心态" + fillerB + "三个特征" + "x".repeat(500);
const ce3 = mat3.length;
const outline3 = { chapters: [{ title: "第A章", _charStart: 0, _charEnd: ce3, lessons: [
  { title: "课一", _charStart: 0, _charEnd: ce3, keyPoints: ["稀缺心态"] },
  { title: "课二", _charStart: 0, _charEnd: ce3, keyPoints: ["三个特征"] },
] }] };
C.reanchorLessonsByContent(mat3, outline3);
const G1 = outline3.chapters[0].lessons[0], G2 = outline3.chapters[0].lessons[1];
ok("两课均被锚定", G1._anchored === true && G2._anchored === true);
const naturalHi1 = mat3.indexOf("稀缺心态") + 1400;
ok("填缝生效：课一 end 超出原始 hi（延伸覆盖了过渡段）", G1._charEnd > naturalHi1);
ok("相邻课无漏读：课一 end >= 课二 start", G1._charEnd >= G2._charStart);
ok("填缝后两课仍连续不重叠", G2._charStart >= G1._charEnd);
// 已由 indexLessonPositions 精确定位（_located=true）的课时，reanchor 不应覆盖它
// ——否则两套定位逻辑打架，把已对准的课时又拉回「最小命中 - 600」
const mat4 = "第A章" + "x".repeat(1000) + "稀缺心态" + "x".repeat(1000);
const outline4 = { chapters: [{ title: "第A章", _charStart: 0, _charEnd: mat4.length, lessons: [
  { title: "课一", _charStart: 500, _charEnd: 1500, _located: true, keyPoints: ["稀缺心态"] },
] }] };
C.reanchorLessonsByContent(mat4, outline4);
ok("已精确定位（_located）的课时起点不被 reanchor 覆盖", outline4.chapters[0].lessons[0]._charStart === 500);
ok("已精确定位的课时不会被打上 _anchored", outline4.chapters[0].lessons[0]._anchored === undefined);

// ---- emaQuizScore / fusedMasteryScore（间隔校准纯函数）----
ok("EMA：首次测验直接取答对率", C.emaQuizScore(null, 0.8) === 0.8);
ok("EMA：再次测验只走一半（阻尼小样本抖动）", C.emaQuizScore(0.8, 0) === 0.4);
ok("EMA：连续两次满分从 0.5 收敛", C.emaQuizScore(0.5, 1) === 0.75);
ok("EMA：非法输入保留旧值", C.emaQuizScore(0.6, 2) === 0.6);
ok("EMA：无旧值且输入非法 → null", C.emaQuizScore(null, -1) === null);
ok("融合：无实测时用主观分", C.fusedMasteryScore(0.9, null) === 0.9);
ok("融合：有实测时 0.7实测+0.3主观", C.fusedMasteryScore(0.5, 1) === 0.85);
ok("融合：主观分缺失按 0.5 兜底", C.fusedMasteryScore(null, 0) === 0.15);
ok("融合：实测拉得动主观分（0.5/0.2 → 弱）", C.fusedMasteryScore(0.5, 0.2) === 0.29);

// ---- ensureQuizAnswers（随堂测验 answer 归一化，防整份误判错）----
const qz = (a) => C.ensureQuizAnswers([{ q: "x", choices: ["1", "2", "3", "4"], answer: a }])[0].answer;
ok("整数索引原样透传", qz(2) === 2);
ok("字母 A → 0", qz("A") === 0);
ok("小写 c 带空格 → 2（大小写不敏感）", qz(" c ") === 2);
ok("序号 1 → 0（1 起算）", qz("1") === 0);
ok("序号 4 → 3", qz("4") === 3);
ok("越界 9 钳到最后一个有效项", qz(9) === 3);
ok("负数钳到 0", qz(-1) === 0);
ok("非数字字符串兜底为 0", qz("abc") === 0);
ok("null 兜底为 0", qz(null) === 0);
ok("短选项集（2 项）越界钳到 1", C.ensureQuizAnswers([{ choices: ["a", "b"], answer: 5 }])[0].answer === 1);
ok("非数组输入返回空数组", Array.isArray(C.ensureQuizAnswers(null)) && C.ensureQuizAnswers(null).length === 0);
ok("缺 choices 的题原样保留（不造数据）", C.ensureQuizAnswers([{ q: "x" }])[0].answer === undefined);
ok("不修改原对象（返回副本）", (() => {
  const src = [{ choices: ["a", "b"], answer: "B" }];
  C.ensureQuizAnswers(src);
  return src[0].answer === "B";
})());

// ---- escapeHtml（全站 innerHTML 转义唯一入口，XSS 回归护栏）----
console.log("escapeHtml");
const eh = (s) => C.escapeHtml(s);
ok("尖括号被转义", eh("<script>") === "&lt;script&gt;");
ok("双引号被转义（data-* 属性上下文安全）", eh('a"b') === "a&quot;b");
ok("单引号被转义", eh("a'b") === "a&#39;b");
ok("和号被转义", eh("a&b") === "a&amp;b");
ok("典型 XSS 载荷不再含裸尖括号", !/[<>]/.test(eh('"><img src=x onerror=alert(1)>')));
ok("典型 XSS 载荷不再含裸引号", !/["']/.test(eh('"><img src=x onerror=alert(1)>')));
ok("null → 空串（不能输出字符串 'null'）", eh(null) === "");
ok("undefined → 空串", eh(undefined) === "");
ok("数字 0 保留为 '0'（不能被当成空值吞掉）", eh(0) === "0");
ok("布尔 false 保留为 'false'", eh(false) === "false");
ok("普通中文原样通过", eh("苏格拉底式提问") === "苏格拉底式提问");
ok("已转义内容会被二次转义（幂等不是本函数的职责）", eh("&lt;") === "&amp;lt;");
ok("同一输入多次调用结果一致", eh("<a>") === eh("<a>"));

// ---- max_tokens 降级阶梯（B6：provider 拒绝过大输出上限时的退路）----
// 旧实现固定退到 8192，整书大纲仍可能被截断；现改为「从报错抠上限 / 逐级减半」。
console.log("maxTokensFallbackChain");
ok("64K 请求 → [32768,16384,8192,4096]",
  JSON.stringify(C.maxTokensFallbackChain(65536)) === JSON.stringify([32768, 16384, 8192, 4096]),
  JSON.stringify(C.maxTokensFallbackChain(65536)));
ok("8K 请求 → 直接退 4096", JSON.stringify(C.maxTokensFallbackChain(8192)) === JSON.stringify([4096]));
ok("≤4096 请求 → 仍返回 [4096]（不产生 0/负值）", JSON.stringify(C.maxTokensFallbackChain(4000)) === JSON.stringify([4096]));
ok("非法输入安全回退 [4096]", JSON.stringify(C.maxTokensFallbackChain(NaN)) === JSON.stringify([4096]));
ok("阶梯严格递减", (() => { const c = C.maxTokensFallbackChain(65536); return c.every((v, i) => i === 0 || v < c[i - 1]); })());

console.log("extractMaxTokensCap");
ok("英文 'at most 8192 completion tokens'",
  C.extractMaxTokensCap("max_tokens is too large: 65536. This model supports at most 8192 completion tokens") === 8192);
ok("英文 'must be less than or equal to 8192'（DeepSeek 实际措辞）",
  C.extractMaxTokensCap("max_tokens must be less than or equal to 8192") === 8192);
ok("英文 'maximum of 16384'", C.extractMaxTokensCap("maximum of 16384 tokens allowed") === 16384);
ok("中文 '最大支持 8192'", C.extractMaxTokensCap("该模型最大支持 8192 个输出 token") === 8192);
ok("不误把我们请求的过大值当上限", C.extractMaxTokensCap("max_tokens is too large: 65536") === null);
ok("无上限措辞返回 null", C.extractMaxTokensCap("rate limit exceeded") === null);
ok("空文本安全返回 null", C.extractMaxTokensCap("") === null && C.extractMaxTokensCap(null) === null);

// ---- 原文高亮分段（「查看原文」课时标记 + 查找命中）----
// 这些边界只在真跑时才暴露：旧大纲坐标越界、查找词落在课时区段内部导致区间重叠、
// 输入乱序等。故逐条钉死。
const seg = (t, r) => C.buildHighlightSegments(t, r);
const back = (segs) => segs.map((x) => x.text).join("");
const kinds = (segs) => segs.map((x) => x.kind === null ? "-" : x.kind).join(",");

console.log("buildHighlightSegments");
ok("空文本返回空数组", JSON.stringify(seg("", [])) === "[]");
ok("无区间 → 整段普通文本", JSON.stringify(seg("abc", [])) === JSON.stringify([{ text: "abc", kind: null }]));
ok("单区间切出 普通/标记/普通 三段",
  JSON.stringify(seg("abcdef", [{ start: 2, end: 4, kind: "lesson" }])) ===
  JSON.stringify([{ text: "ab", kind: null }, { text: "cd", kind: "lesson" }, { text: "ef", kind: null }]));
ok("区间贴开头不产生空普通段", kinds(seg("abcdef", [{ start: 0, end: 2, kind: "x" }])) === "x,-");
ok("区间贴结尾不产生空普通段", kinds(seg("abcdef", [{ start: 4, end: 6, kind: "x" }])) === "-,x");
ok("覆盖全文 → 只有一段", kinds(seg("abcdef", [{ start: 0, end: 6, kind: "x" }])) === "x");
ok("乱序输入仍按位置输出（只在端点处切分）",
  kinds(seg("abcdef", [
    { start: 4, end: 5, kind: "b" }, { start: 0, end: 1, kind: "a" }])) === "a,-,b,-" &&
  back(seg("abcdef", [
    { start: 4, end: 5, kind: "b" }, { start: 0, end: 1, kind: "a" }])) === "abcdef");
ok("相邻同 kind 自动合并成一段",
  seg("abcd", [{ start: 0, end: 2, kind: "h" }, { start: 2, end: 4, kind: "h" }]).length === 1);

// 越界 / 非法输入：旧大纲的坐标可能来自别的算法版本，绝不能因此抛错或标错
ok("越界区间被钳制到文本长度内",
  JSON.stringify(seg("abc", [{ start: 1, end: 99, kind: "x" }])) ===
  JSON.stringify([{ text: "a", kind: null }, { text: "bc", kind: "x" }]));
ok("负起点被钳制为 0",
  JSON.stringify(seg("abc", [{ start: -5, end: 2, kind: "x" }])) ===
  JSON.stringify([{ text: "ab", kind: "x" }, { text: "c", kind: null }]));
ok("空区间（start===end）被丢弃", kinds(seg("abc", [{ start: 1, end: 1, kind: "x" }])) === "-");
ok("起点非数字的区间被丢弃（不猜位置）", kinds(seg("abc", [{ start: "x", end: 2, kind: "k" }])) === "-");
ok("end 缺失的区间被丢弃", kinds(seg("abc", [{ start: 0, kind: "k" }])) === "-");
ok("null 区间元素安全跳过", kinds(seg("abc", [null, { start: 0, end: 1, kind: "k" }])) === "k,-");
ok("ranges 非数组时安全返回整段", JSON.stringify(seg("abc", null)) === JSON.stringify([{ text: "abc", kind: null }]));

// 重叠裁决：查找命中(priority 2) 必须盖在课时标记(priority 1) 上——
// 否则「在课时段落里搜词」会一个字都标不出来。
ok("高 priority 覆盖低 priority",
  kinds(seg("abcdef", [
    { start: 0, end: 6, kind: "lesson", priority: 1 },
    { start: 2, end: 3, kind: "hit", priority: 2 },
  ])) === "lesson,hit,lesson");
ok("同 priority 重叠段归先传入者，非重叠的尾段仍归后者",
  kinds(seg("abcde", [
    { start: 0, end: 3, kind: "first", priority: 1 },
    { start: 2, end: 5, kind: "second", priority: 1 },
  ])) === "first,second" &&
  back(seg("abcde", [
    { start: 0, end: 3, kind: "first", priority: 1 },
    { start: 2, end: 5, kind: "second", priority: 1 },
  ])) === "abcde");
ok("高 priority 的区间从中间切开低 priority 区间时不得丢字",
  back(seg("abcdef", [
    { start: 0, end: 6, kind: "lesson", priority: 1 },
    { start: 2, end: 4, kind: "hit", priority: 2 },
  ])) === "abcdef");

// 还原性：无论怎么切，拼回去必须与原文逐字相同（漏字/重字是最危险的静默 bug）
(() => {
  const text = "第一段。第二段要查找的关键词在这里。第三段也有一个关键词。";
  const segs = seg(text, [
    { start: 0, end: 12, kind: "lesson", priority: 1 },
    { start: 15, end: 18, kind: "hit", priority: 2 },
    { start: 999, end: 1000, kind: "hit", priority: 2 },
  ]);
  ok("任意切分后拼回原文逐字一致", back(segs) === text);
})();

console.log("findTextMatches");
ok("空 query 返回空数组", C.findTextMatches("abc", "").length === 0);
ok("空文本返回空数组", C.findTextMatches("", "a").length === 0);
ok("null 安全", C.findTextMatches(null, null).length === 0);
ok("单次命中给出正确偏移",
  JSON.stringify(C.findTextMatches("abc关键词def", "关键词")) === JSON.stringify([{ start: 3, end: 6 }]));
ok("多次命中全部给出",
  C.findTextMatches("关键词一，关键词二，关键词三", "关键词").length === 3);
ok("大小写不敏感（英文）",
  C.findTextMatches("DeepSeek 与 deepseek", "deepseek").length === 2);
ok("大小写不敏感但坐标对齐原文（不被折叠长度影响）",
  JSON.stringify(C.findTextMatches("ABab", "ab")) ===
  JSON.stringify([{ start: 0, end: 2 }, { start: 2, end: 4 }]));
ok("不重叠推进：'aa' 在 'aaaa' 中命中 2 次而非 3 次",
  C.findTextMatches("aaaa", "aa").length === 2);
ok("max 上限生效",
  C.findTextMatches("a".repeat(100), "a", 10).length === 10);
ok("max 非法时用默认上限（不会无上限）",
  C.findTextMatches("a".repeat(60), "a", 0).length === 60);
ok("命中区间可被 buildHighlightSegments 直接消费",
  kinds(seg("xx关键词xx", C.findTextMatches("xx关键词xx", "关键词").map((m) => ({ start: m.start, end: m.end, kind: "hit" })))) === "-,"+"hit,"+"-");

console.log("apiTimeoutMs（B8：超时按输出预算派生，不再全罩一个写死的 5 分钟）");
{
  const CFG = { baseMs: 120000, perTokMs: 50, capMs: 600000 };
  eq("未传 maxTokens 按 provider 默认 4096 计", C.apiTimeoutMs(undefined, CFG), 324800);
  eq("maxTokens=4096 显式给出同值", C.apiTimeoutMs(4096, CFG), 324800);
  eq("结构化为 8192 时 ≈530s", C.apiTimeoutMs(8192, CFG), 529600);
  eq("大纲类大输出夹到上限 600s", C.apiTimeoutMs(65536, CFG), 600000);
  const seq = [4096, 8192, 16384, 32768, 65536].map((t) => C.apiTimeoutMs(t, CFG));
  ok("随输出预算单调不减", seq.every((v, i) => i === 0 || v >= seq[i - 1]));
  // 关键性质：大纲预算下必须比旧的写死值（300000）更宽松，否则本修复等于空转
  ok("大纲预算下 > 旧的写死 300s（否则未修）", C.apiTimeoutMs(65536, CFG) > 300000);
  ok("任何输入都不低于 baseMs", C.apiTimeoutMs(1, CFG) >= 120000 && C.apiTimeoutMs(-5, CFG) >= 120000);
  ok("任何输入都不超过 capMs", C.apiTimeoutMs(1e9, CFG) <= 600000);
  // 脏配置/脏入参一律回落默认：绝不能返回 NaN（NaN 会让 setTimeout 立即触发 → 请求被秒 abort）
  ok("cfg 为 null 时用内置默认", C.apiTimeoutMs(4096, null) === 324800);
  ok("perTokMs 非法时回落默认 50", C.apiTimeoutMs(4096, { baseMs: 120000, perTokMs: 0, capMs: 600000 }) === 324800);
  ok("capMs 小于 baseMs 时不倒挂", C.apiTimeoutMs(65536, { baseMs: 120000, perTokMs: 50, capMs: 1000 }) === 120000);
  ok("maxTokens 传字符串/NaN 时按默认 4096", C.apiTimeoutMs("abc", CFG) === 324800 && C.apiTimeoutMs(NaN, CFG) === 324800);
  ok("返回值恒为有限数", [null, undefined, 0, -1, 1e9, "8k"].every((v) => isFinite(C.apiTimeoutMs(v, CFG))));
}

console.log("\nassembleChatMessages（前缀缓存布局）");
{
  const hist = [
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "u3" },
  ];
  const base = { staticSystem: "STAT", dynamicSystem: "DYN", systemNote: "", hist: hist, layout: "tail" };

  const tail = C.assembleChatMessages(base);
  ok("tail：尾巴放在最后一条 user 之前", tail.tailPlaced === true
    && tail.msgs[1].content === "u1" && tail.msgs[3].content === "u2"
    && tail.msgs[5].content === "DYN" && tail.msgs[6].content === "u3");
  ok("tail：静态段恒为 [0]、无尾随 system", tail.msgs[0].content === "STAT"
    && tail.msgs[tail.msgs.length - 1].role === "user");

  // 核心性质（这才是缓存能命中的原因）：下一轮的「命中前缀」是上一轮前缀的超集。
  // 构造真实的两轮：第 1 轮历史 = [u1,a1,u2]，第 2 轮 = [u1,a1,u2,a2,u3]。
  const t1 = C.assembleChatMessages({
    staticSystem: "STAT", dynamicSystem: "DYN", hist: [
      { role: "user", content: "u1" }, { role: "assistant", content: "a1" }, { role: "user", content: "u2" },
    ], layout: "tail",
  });
  const t2 = C.assembleChatMessages({
    staticSystem: "STAT", dynamicSystem: "DYN", hist: [
      { role: "user", content: "u1" }, { role: "assistant", content: "a1" },
      { role: "user", content: "u2" }, { role: "assistant", content: "a2" }, { role: "user", content: "u3" },
    ], layout: "tail",
  });
  const prefix = (msgs) => msgs.slice(0, msgs.findIndex((m) => m.content === "DYN"));
  const p1 = prefix(t1.msgs), p2 = prefix(t2.msgs);
  ok("tail：下一轮前缀在上一轮前缀的基础上增长（逐字节稳定）",
    p2.length > p1.length && p1.every((m, i) => m.content === p2[i].content));
  const h2 = C.assembleChatMessages({
    staticSystem: "STAT", dynamicSystem: "DYN", hist: [
      { role: "user", content: "u1" }, { role: "assistant", content: "a1" },
      { role: "user", content: "u2" }, { role: "assistant", content: "a2" }, { role: "user", content: "u3" },
    ], layout: "head",
  });
  ok("head：下一轮前缀仍是静态段（历史全 miss，即旧行为）", prefix(h2.msgs).length === 1);

  const head = C.assembleChatMessages(Object.assign({}, base, { layout: "head" }));
  ok("head：易变段紧跟静态段、排在历史之前", head.tailPlaced === false
    && head.msgs[0].content === "STAT" && head.msgs[1].content === "DYN" && head.msgs[2].content === "u1");

  const withNote = C.assembleChatMessages(Object.assign({}, base, { layout: "head", systemNote: "NOTE" }));
  ok("dyn 在 note 之前（与旧 payload 顺序一致）",
    withNote.msgs[1].content === "DYN" && withNote.msgs[2].content === "NOTE");

  const noUser = C.assembleChatMessages(Object.assign({}, base, { hist: [{ role: "assistant", content: "a0" }] }));
  ok("找不到 user 时退化 head，且不产生尾随 system", noUser.tailPlaced === false
    && noUser.msgs[noUser.msgs.length - 1].content === "a0");

  const noDyn = C.assembleChatMessages(Object.assign({}, base, { dynamicSystem: "", systemNote: "" }));
  ok("无动态段时只有静态 + 历史", noDyn.tailPlaced === false && noDyn.msgs.length === 6
    && noDyn.msgs[1].content === "u1");

  const dirty = C.assembleChatMessages(Object.assign({}, base, { layout: "whatever" }));
  ok("layout 脏值回落 tail", dirty.tailPlaced === true);

  const before = JSON.stringify(hist);
  C.assembleChatMessages(base);
  ok("不修改传入的 hist 数组", JSON.stringify(hist) === before);

  ok("空入参不抛", (() => { try { C.assembleChatMessages(); return true; } catch (e) { return false; } })());
}

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
