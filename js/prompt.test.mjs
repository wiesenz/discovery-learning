/* Socratopia v0 · 系统提示词组装的确定性 / 缓存友好性测试
 * 运行：node js/prompt.test.mjs
 * 目的：保证 buildStaticSystem 在「同节课内」逐字节稳定（前缀缓存命中），
 *       且任何易变内容（熟悉度/番茄提示/记忆/画像/续学）绝不污染静态段。
 */
import {
  buildStaticSystem, buildDynamicSystem, buildSystemPrompt, buildChatMessages,
  outlineForLessonStart, sliceMaterialForLesson,
} from "./prompt.js";

let pass = 0, fail = 0;
function t(label, cond) {
  if (cond) { pass++; console.log("  PASS", label); }
  else { fail++; console.log("  FAIL ***", label); }
}

// 构造一个稳定的上课 chat ctx（模拟一次真实调用）
function makeCtx(overrides = {}) {
  const base = {
    mode: "chat",
    roleName: "三月七",
    role: { persona: "活泼风格", voice: "用括号动作描写" },
    topic: "牛顿第一定律",
    book: {
      title: "物理课本",
      material: "短材料不足8000字直接整段返回用于测试切片逻辑稳定。",
      outline: {
        bookTitle: "物理课本",
        teachingRoute: "从现象到本质",
        globalDerivation: "全书逻辑链：运动-力-能量",
        chapters: [{ title: "第一章", lessons: [{ id: "L1", title: "课1", focus: "F", keyPoints: ["k1", "k2"], logicFlow: "LF" }] }],
      },
    },
    lessonId: "L1",
    familiarity: "完全陌生",
    userAlias: "开拓者",
    tomatoHint: "（番茄节奏：已专注 3 轮）",
    resumeInfo: null,
    wrongBlock: "",
    reviewBlock: "",
    isReviewLesson: false,
    memoryBlock: "【学员长期记忆】- 已掌握：x\n- 易错：y",
    userProfileBlockStr: "【用户画像】偏好图示",
    roster: "",
    material: "短材料",
  };
  return Object.assign({}, base, overrides);
}

console.log("\n== 1. 静态段确定性（同输入两次逐字节一致） ==");
const c1 = makeCtx();
const s1 = buildStaticSystem("chat", c1);
const s2 = buildStaticSystem("chat", makeCtx());
t("两次构建静态段逐字节一致", s1 === s2);
t("静态段包含角色人设", s1.includes("活泼风格"));
t("静态段包含教材切片锚点", s1.includes("<<<<<<"));
t("静态段包含本课知识点钉入（防衰减）", s1.includes("本课应覆盖的知识点"));
t("静态段包含 personalizedRules", s1.includes("因材施教") || s1.includes("个性化"));

console.log("\n== 2. 静态段不随动态字段变化（缓存命中关键） ==");
const volatileChanged = makeCtx({
  familiarity: "非常熟悉",
  tomatoHint: "（番茄节奏：已专注 99 轮）",
  memoryBlock: "【学员长期记忆】完全不同内容",
  userProfileBlockStr: "【用户画像】完全不同",
  resumeInfo: { summary: "上次小结内容" },
});
const s3 = buildStaticSystem("chat", volatileChanged);
t("动态字段变化后静态段仍逐字节一致", s1 === s3);

console.log("\n== 3. 易变内容只在动态段，不在静态段 ==");
const dyn = buildDynamicSystem("chat", c1);
t("动态段含熟悉程度", dyn.includes("完全陌生"));
t("动态段含番茄提示", dyn.includes("番茄节奏"));
t("静态段不含熟悉程度", !s1.includes("完全陌生"));
t("静态段不含番茄提示", !s1.includes("番茄节奏"));

console.log("\n== 4. buildSystemPrompt = 静态 + 动态 合并 ==");
const merged = buildSystemPrompt("chat", c1);
const rebuilt = [s1];
const d1 = buildDynamicSystem("chat", c1);
if (d1) rebuilt.push(d1);
t("合并结果 == 静态 + 动态连接", merged === rebuilt.filter(Boolean).join("\n\n"));

console.log("\n== 5. buildChatMessages 拆分结构（缓存核心） ==");
const bm = buildChatMessages(c1);
t("head 只有静态 system 一个元素", bm.head.length === 1 && bm.head[0].role === "system" && bm.head[0].content === bm.staticSystem);
t("tail 是动态 system（动态非空时）", bm.tail.length === 1 && bm.tail[0].role === "system" && bm.tail[0].content === bm.dynamicSystem);
t("只负责拆分、不再产出 msgs（位置交给 assembleChatMessages 决定）", bm.msgs === undefined);
t("动态为空时只剩 answerQualityRules 常驻段（路线1：20260907 修订，aa20551 后 chat 动态段永不为空）", (() => {
  const empty = buildChatMessages(makeCtx({ familiarity: "", tomatoHint: "", memoryBlock: "", userProfileBlockStr: "", resumeInfo: null }));
  return empty.dynamicSystem.length > 0 && empty.dynamicSystem.indexOf("QUALITY:") >= 0 && empty.tail.length === 1;
})());

console.log("\n== 6. 无易变函数/时间戳（防静默破坏缓存） ==");
t("静态段函数体无 Date.now", !buildStaticSystem.toString().includes("Date.now"));
t("静态段函数体无 new Date", !buildStaticSystem.toString().includes("new Date"));
t("静态段函数体无 Math.random", !buildStaticSystem.toString().includes("Math.random"));
t("大纲函数无随机源", !outlineForLessonStart.toString().includes("Math.random"));

console.log("\n== 7. 各模式不抛错且返回非空 ==");
for (const m of ["intro", "lessonStart", "lessonEnd", "group", "review"]) {
  try {
    const out = buildSystemPrompt(m, makeCtx({ mode: m }));
    t("模式 " + m + " 返回非空", typeof out === "string" && out.length > 0);
  } catch (e) {
    t("模式 " + m + " 不抛错", false);
    console.log("    error:", e && e.message);
  }
}

console.log("\n== 8. 续学：待补讲知识点进入动态段（防回退） ==");
const resumeCtx = makeCtx({
  resumeInfo: { summary: "上次小结内容" },
  uncoveredNote: "知识点A、知识点B",
});
const dynR = buildDynamicSystem("chat", resumeCtx);
t("动态段含上次小结", dynR.includes("上次小结内容"));
t("动态段含待补讲知识点", dynR.includes("知识点A、知识点B"));
t("续学内容不污染静态段", !buildStaticSystem("chat", resumeCtx).includes("知识点A"));

console.log("\n== 9. P0/P1：出题聚焦与确定性策略进入动态段（防回退） ==");
const leCtx = makeCtx({
  mode: "lessonEnd",
  memoryBlock: "【学员长期记忆】- 易错：y",
  quizFocusBlock: "【本次测验重点】薄弱：惯性",
});
const leDyn = buildDynamicSystem("lessonEnd", leCtx);
t("lessonEnd 动态段含 memoryBlock", leDyn.includes("易错：y"));
t("lessonEnd 动态段含 quizFocusBlock（薄弱点进出题提示词）", leDyn.includes("惯性"));

const chatCtx = makeCtx({ policyHintBlock: "【本轮教学策略建议】针对已知误区" });
const chatDyn = buildDynamicSystem("chat", chatCtx);
t("chat 动态段含 policyHintBlock（确定性策略建议）", chatDyn.includes("本轮教学策略建议"));

// 【20260913 有意调整】lessonEnd 的动态段现在也会注入【用户画像】。
// 原因：lessonEnd 是 AI 课后观察的【唯一写入点】，而它此前看不到已有画像、
// 也看不到用户的「不准」清单 —— 于是 AI 会反复写刚被否掉的东西（唯一拦截是逐字精确去重，
// 换个标点就绕过）。写画像的那次调用必须看得见现状，闭环才成立。
// 所以下面这条从"只要没有聚焦块就必须为空"改为"所有输入都空时才为空"，
// 并补一条正向断言：画像确实进了 lessonEnd。
t("lessonEnd 动态段含 userProfileBlockStr（画像闭环：写画像的调用必须看得见已有画像）",
  leDyn.includes("偏好图示"));
const leEmpty = buildDynamicSystem("lessonEnd",
  makeCtx({ mode: "lessonEnd", memoryBlock: "", quizFocusBlock: "", userProfileBlockStr: "" }));
t("lessonEnd 全部输入皆空时动态段为空，不无端产生内容", leEmpty === "");

// ---- sliceMaterialForLesson：课时材料切片应命中「本课在章内的真实位置」----
// 旧实现用「章内按比例均分」的假课时坐标，会把别课的内容当成本课材料喂给老师。
const pad = "填充内容足够长的正文。".repeat(400); // ~4000 字/段
const longMat = "第一章 语言基础\n" +
  pad + "\n这里开讲【变量作用域】的规则。\n" + pad +
  "\n接着讲【闭包与自由变量】。\n" + pad +
  "\n最后讲【装饰器语法糖】。\n" + pad;
const longOutline = { chapters: [{ title: "第一章 语言基础", lessons: [
  { id: "p1", title: "变量作用域", keyPoints: ["变量作用域", "作用域规则"] },
  { id: "p2", title: "闭包", keyPoints: ["闭包", "自由变量"] },
  { id: "p3", title: "装饰器", keyPoints: ["装饰器", "语法糖"] },
  { id: "p4", title: "玄学概念", keyPoints: ["原文中根本不存在的概念"] },
] }] };
const longBook = { material: longMat, outline: longOutline };
t("材料足够长（走切片而非整本）", longMat.length > 16000);
const sl1 = sliceMaterialForLesson(longOutline.chapters[0].lessons[0], longBook);
const sl2 = sliceMaterialForLesson(longOutline.chapters[0].lessons[1], longBook);
const sl3 = sliceMaterialForLesson(longOutline.chapters[0].lessons[2], longBook);
t("第1课切片含本课关键词", sl1.includes("变量作用域"));
t("第1课切片不含第2课内容", !sl1.includes("闭包与自由变量"));
t("第2课切片含本课关键词", sl2.includes("闭包与自由变量"));
t("第2课切片不含第1/3课内容", !sl2.includes("变量作用域") && !sl2.includes("装饰器语法糖"));
t("第3课切片含本课关键词", sl3.includes("装饰器语法糖"));
t("定位成功的切片标注章内定位", sl2.includes("在所属章内定位切出"));
const sl4 = sliceMaterialForLesson(longOutline.chapters[0].lessons[3], longBook);
t("定位不到的课时仍返回非空切片", sl4.trim().length > 100);
t("定位不到时标注为本章片段（而非谎称精确定位）", sl4.includes("未能精确定位"));

// 回归：课时 keyPoints 未逐字出现在原文（极常见）时，未定位课时不得退回整章，
// 必须用「章内均分兜底」坐标——否则第 N 课会拿到全书开头（内容漂移，见 lesson-logic E2E）。
const driftMat = ("第一部分AAAA").repeat(1200) + "\n\n" + ("第二部分BBBB").repeat(1200); // ~19k 字，超短书阈值
const driftOutline = { chapters: [{ title: "漂移章", lessons: [
  { id: "d1", title: "上半", keyPoints: ["上"] },
  { id: "d2", title: "下半", keyPoints: ["下"] },
] }] };
const driftBook = { material: driftMat, outline: driftOutline };
t("漂移用例材料超短书阈值", driftMat.length > 16000);
const drift1 = sliceMaterialForLesson(driftOutline.chapters[0].lessons[0], driftBook);
const drift2 = sliceMaterialForLesson(driftOutline.chapters[0].lessons[1], driftBook);
t("第2课切片命中后半段（不漂移）", drift2.includes("第二部分BBBB"));
t("第2课切片不含开头（修复内容漂移）", !drift2.includes("第一部分AAAA"));

console.log("\n==== RESULT: " + pass + " passed, " + fail + " failed ====");
process.exit(fail ? 1 : 0);
