/* Socratopia v0 · 因材施教决策层单元测试
 * 运行：node js/adaptive.test.mjs
 * 目的：decideNextMove 必须是确定性的——相同输入永远给相同输出，且每个教学动作都
 *       能被正向触发、不互相串台；policyHint 只在真正需要干预时产出指令，默认 proceed 不注入。
 */
import { decideNextMove, policyHint, MOVES, deriveMisconceptionsFromWrongQuiz, extractQualityTag, stripQualityForDisplay, deriveAnswerSignals, computeStuckStreak, computeQuestionOnlyStreak, detectExplicitRequest } from "./adaptive.js";

let pass = 0, fail = 0;
function t(label, cond) {
  if (cond) { pass++; console.log("  PASS", label); }
  else { fail++; console.log("  FAIL ***", label); }
}
function eq(actual, expected, label) {
  t(label + " (得到 " + JSON.stringify(actual) + ")", actual === expected);
}

// ---- 1. 误区优先：命中已知误区必走 counterexample，且 target 取第一条 ----
{
  const d = decideNextMove({ misconceptions: ["力是维持运动的原因", "混淆X与Y"] });
  eq(d.move, "counterexample", "误区→counterexample");
  eq(d.target, "力是维持运动的原因", "counterexample target 取首条误区");
  eq(d.hintLevel, 2, "counterexample hintLevel=2");
  t("counterexample 不因熟悉度高而被覆盖", decideNextMove({ misconceptions: ["m"], familiarity: "familiar" }).move === "counterexample");
}

// ---- 2. 无证据→diagnose（即便熟悉度高，无证据也得先测） ----
{
  const d = decideNextMove({ kpEvidence: false, familiarity: "familiar", misconceptions: [] });
  eq(d.move, "diagnose", "无证据→diagnose");
  eq(d.hintLevel, 1, "diagnose hintLevel=1");
}

// ---- 3. 卡住轮数驱动 hint / reveal ----
{
  eq(decideNextMove({ consecutiveStuck: 1 }).move, "hint", "卡1轮→hint");
  eq(decideNextMove({ consecutiveStuck: 2 }).move, "hint", "卡2轮→hint");
  const d2 = decideNextMove({ consecutiveStuck: 2 });
  eq(d2.hintLevel, 2, "hintLevel 随卡住轮数递增");
  eq(d2.n, 2, "hint 记录卡住轮数");
  eq(decideNextMove({ consecutiveStuck: 3 }).move, "reveal", "卡≥3轮→reveal");
  eq(decideNextMove({ consecutiveStuck: 5 }).move, "reveal", "卡5轮→reveal");
  eq(decideNextMove({ consecutiveStuck: 5 }).hintLevel, 3, "reveal hintLevel 封顶3");
}

// ---- 4. 作答质量驱动 justify / decompose / transfer / reflect ----
{
  eq(decideNextMove({ lastAnswerKind: "vague" }).move, "justify", "含糊→justify");
  eq(decideNextMove({ lastAnswerKind: "wrong" }).move, "decompose", "错→decompose");
  eq(decideNextMove({ lastAnswerKind: "correct" }).move, "transfer", "答对→transfer");
  const d = decideNextMove({ lastAnswerKind: "correct", justCorrected: true });
  eq(d.move, "reflect", "刚纠错+答对→reflect");
}

// ---- 5. 优先级不串台 ----
// 现行顺序：明示要答案 > 卡住≥3(reveal) > 误区(counterexample) > 卡住≥1(hint)
//           > 含糊(justify) > 答错(decompose) > 只问不教≥3(summarize)
//           > 刚纠错(reflect) > 答对(transfer) > 无证据(diagnose) > proceed
{
  // 【20260913 有意调整】reveal（连续卡住≥3）提到误区之前。
  // 原来「误区最高优先级，不被卡住覆盖」是有意设计，但有个未被考虑到的后果：
  // m.misconceptions 只增不减、全库没有任何删除/治愈路径，于是某个主题一旦记下误区，
  // 这条"卡住多轮就破例给答案"的兜底路径就【永远不可达】——学生连着卡 9 轮，
  // 系统还在命令老师"设计一个能暴露该误区的反例"，正是"为了提问而提问"。
  const d = decideNextMove({ misconceptions: ["m"], consecutiveStuck: 9, lastAnswerKind: "wrong", kpEvidence: false });
  eq(d.move, "reveal", "卡住≥3 优先于误区（否则兜底给答案永远不可达）");
  // 只卡 1~2 轮时，误区仍高于泛泛的脚手架提示：已知根因比通用提示更精准
  eq(decideNextMove({ misconceptions: ["m"], consecutiveStuck: 2 }).move, "counterexample", "卡住<3 时误区优先于 hint");
  eq(decideNextMove({ misconceptions: ["m"], lastAnswerKind: "wrong" }).move, "counterexample", "误区不被答错覆盖");
  eq(decideNextMove({ misconceptions: ["m"], lastAnswerKind: "wrong" }).target, "m", "counterexample 仍取首条误区");
  // 学生明示"直接告诉我"：压过一切（含误区与卡住）
  eq(decideNextMove({ explicitRequest: true, misconceptions: ["m"], consecutiveStuck: 9 }).move, "reveal", "明示要答案压过误区与卡住");
  eq(decideNextMove({ explicitRequest: true }).asked, true, "明示要答案时带 asked 标记（供 policyHint 换措辞）");
  eq(decideNextMove({ consecutiveStuck: 3 }).asked, undefined, "非明示的 reveal 不带 asked");
  // 无误区但无证据：即便卡住也应先 diagnose？——设计选择：卡住（已交互）优先于无证据前测
  eq(decideNextMove({ kpEvidence: false, consecutiveStuck: 2 }).move, "hint", "卡住优先于 diagnose");
  // 有证据且答对未纠错：transfer
  eq(decideNextMove({ kpEvidence: true, lastAnswerKind: "correct" }).move, "transfer", "有证据+答对→transfer");
}

// ---- 6. 默认 proceed：全新学习者、无任何信号 ----
{
  const d = decideNextMove({});
  eq(d.move, "proceed", "空信号→proceed");
  eq(d.hintLevel, 1, "proceed 默认 hintLevel=1 (none)");
  eq(decideNextMove({ familiarity: "familiar" }).hintLevel, 2, "proceed 熟悉→hintLevel=2");
  eq(decideNextMove({ familiarity: "some" }).hintLevel, 1, "proceed 一般→hintLevel=1");
  // 宿主传的是界面上的中文档位（index.html 的 data-fam），此前只认英文 "familiar"，
  // 两边永不相等 → 恒为 1 → 用户唯一的"按我的档位调强度"入口在确定性层完全空转。
  eq(decideNextMove({ familiarity: "比较熟" }).hintLevel, 2, "proceed 中文档位「比较熟」→hintLevel=2（宿主实际传的值）");
  eq(decideNextMove({ familiarity: "学过一点" }).hintLevel, 1, "proceed 中文档位「学过一点」→hintLevel=1");
  eq(decideNextMove({ familiarity: "完全没接触过（小白）" }).hintLevel, 1, "proceed 中文档位「小白」→hintLevel=1");
  eq(decideNextMove(undefined).move, "proceed", "传 undefined 不崩");
  eq(decideNextMove(null).move, "proceed", "传 null 不崩");
  eq(decideNextMove({ consecutiveStuck: -3 }).move, "proceed", "负数卡住当0处理");
}

// ---- 7. policyHint：仅在干预动作产出指令，proceed 返回空串（不注入） ----
{
  eq(policyHint(decideNextMove({})), "", "proceed 不注入指令");
  t("counterexample 指令含误区原文", policyHint(decideNextMove({ misconceptions: ["力维持运动"] })).includes("力维持运动"));
  t("hint 指令含卡住轮数", policyHint(decideNextMove({ consecutiveStuck: 2 })).includes("卡住 2 轮"));
  t("reveal 指令存在", policyHint(decideNextMove({ consecutiveStuck: 3 })).length > 0);
  t("transfer 指令存在", policyHint(decideNextMove({ lastAnswerKind: "correct" })).length > 0);
  t("diagnose 指令存在", policyHint(decideNextMove({ kpEvidence: false })).length > 0);
}

// ---- 8. 动作全集自洽：每个 MOVE 都能被至少一个输入触发 ----
{
  const triggers = {
    diagnose: { kpEvidence: false },
    justify: { lastAnswerKind: "vague" },
    counterexample: { misconceptions: ["x"] },
    decompose: { lastAnswerKind: "wrong" },
    hint: { consecutiveStuck: 1 },
    reveal: { consecutiveStuck: 3 },
    summarize: { questionOnlyStreak: 3 },
    transfer: { lastAnswerKind: "correct" },
    reflect: { lastAnswerKind: "correct", justCorrected: true },
    proceed: {},
  };
  MOVES.forEach((mv) => {
    const trig = triggers[mv];
    t("MOVE 可触发: " + mv, trig && decideNextMove(trig).move === mv);
  });
}

// ---- 9. deriveMisconceptionsFromWrongQuiz：答错即派生误区文本（0 token，可单测） ----
{
  const kpOf = (it) => it && it.kp ? it.kp : null;
  // 9.1 答对的不触发
  eq(deriveMisconceptionsFromWrongQuiz(
    [{ q: "x", answer: 0, kp: "牛顿第一定律" }, { q: "y", answer: 2, kp: "能量守恒" }],
    [0, 2], kpOf).length, 0, "全答对→不派生任何误区");
  // 9.2 答错且无 explicit misconception → 用 kp 生成模板文本
  const r1 = deriveMisconceptionsFromWrongQuiz(
    [{ q: "x", answer: 0, kp: "牛顿第一定律" }, { q: "y", answer: 2, kp: "能量守恒" }],
    [1, 2], kpOf); // 第1题错，第2题对
  eq(r1.length, 1, "错1题→派生1条");
  eq(r1[0], "对「牛顿第一定律」的理解存在误区（随堂测验答错）", "模板文本含 kp");
  // 9.3 题目自带 misconception 文本 → 优先采用（信噪比最高）
  const r2 = deriveMisconceptionsFromWrongQuiz(
    [{ q: "x", answer: 0, kp: "力", misconception: "力是维持运动的原因" }],
    [3], kpOf); // 答错
  eq(r2.length, 1, "explicit 误区→1条");
  eq(r2[0], "力是维持运动的原因", "explicit 误区文本被直接采用");
  // 9.4 同 kp 重复错 → 去重只留1条
  const r3 = deriveMisconceptionsFromWrongQuiz(
    [{ q: "a", answer: 0, kp: "牛顿第一定律" }, { q: "b", answer: 0, kp: "牛顿第一定律" }],
    [1, 1], kpOf);
  eq(r3.length, 1, "同 kp 重复错→去重为1条");
  // 9.5 防御：空/坏输入不崩
  eq(deriveMisconceptionsFromWrongQuiz(null, [0], kpOf).length, 0, "null quiz 不崩");
  eq(deriveMisconceptionsFromWrongQuiz([{ answer: 0 }], [5], kpOf).length, 0, "无 kp 且无 misconception 的错题→不派生");
  // 9.6 explicit 与模板混用：各取所需
  const r4 = deriveMisconceptionsFromWrongQuiz(
    [{ q: "a", answer: 0, kp: "力", misconception: "力是维持运动的原因" }, { q: "b", answer: 0, kp: "能量守恒" }],
    [1, 1], kpOf);
  eq(r4.length, 2, "explicit+模板混用→2条");
  t("含 explicit 原文", r4.includes("力是维持运动的原因"));
  t("含模板文本", r4.some((s) => s.indexOf("能量守恒") >= 0));
}

// ---- 10. extractQualityTag：从 LLM 回复剥离自评标记 ----
{
  // 10.1 末尾 correct 标记：剥离后文本不含标记，quality 正确
  const a = extractQualityTag("我觉得你答得对。\nQUALITY:correct");
  eq(a.quality, "correct", "末尾 correct→quality=correct");
  eq(a.text, "我觉得你答得对。", "correct 标记被剥离，正文保留");
  // 10.2 末尾 wrong + 尾随空行：剥离干净
  const b = extractQualityTag("不对。\n\nQUALITY:wrong\n\n");
  eq(b.quality, "wrong", "末尾 wrong→quality=wrong");
  eq(b.text, "不对。", "wrong 标记及尾随空行被剥离");
  // 10.3 无标记：原样返回，quality=none
  const c = extractQualityTag("请再想想力的方向。");
  eq(c.quality, "none", "无标记→quality=none");
  eq(c.text, "请再想想力的方向。", "无标记→正文原样");
  // 10.4 标记不在末尾非空行：容错，不剥离（避免破坏正文）
  const d = extractQualityTag("QUALITY:correct 这是他说的，不是我自评的");
  eq(d.quality, "none", "标记夹在中间→不识别，quality=none");
  eq(d.text, "QUALITY:correct 这是他说的，不是我自评的", "夹在中间的标记不剥离");
  // 10.5 none 标记：剥离，quality=none
  const e = extractQualityTag("你有问题想问？\nQUALITY:none");
  eq(e.quality, "none", "末尾 none→quality=none");
  eq(e.text, "你有问题想问？", "none 标记被剥离");
  // 10.6 大小写容错
  const f = extractQualityTag("答错了。\nquality:WRONG");
  eq(f.quality, "wrong", "大小写不敏感→wrong");
  // 10.7 空输入不崩
  eq(extractQualityTag("").quality, "none", "空输入→none");
  eq(extractQualityTag(null).text, "", "null 输入→空文本");
}

// ---- 11. deriveAnswerSignals：从对话历史派生真实作答质量信号 ----
{
  // 11.1 最近一次评估 correct
  const s1 = deriveAnswerSignals([{ role: "user", content: "x" }, { role: "assistant", content: "y", quality: "correct" }]);
  eq(s1.lastAnswerKind, "correct", "末尾 correct→lastAnswerKind=correct");
  eq(s1.justCorrected, false, "单条 correct→justCorrected=false");
  // 11.2 上 wrong 下 correct → 刚纠错
  const s2 = deriveAnswerSignals([
    { role: "user", content: "a" }, { role: "assistant", content: "u", quality: "wrong" },
    { role: "user", content: "b" }, { role: "assistant", content: "v", quality: "correct" },
  ]);
  eq(s2.lastAnswerKind, "correct", "末条 correct→lastAnswerKind=correct");
  eq(s2.justCorrected, true, "wrong→correct→justCorrected=true");
  // 11.3 上 vague 下 correct → 也视为刚讲清楚
  const s3 = deriveAnswerSignals([
    { role: "user", content: "a" }, { role: "assistant", content: "u", quality: "vague" },
    { role: "user", content: "b" }, { role: "assistant", content: "v", quality: "correct" },
  ]);
  eq(s3.justCorrected, true, "vague→correct→justCorrected=true");
  // 11.4 历史中只有一次评估，前面是 user：prev 缺省为 none
  const s4 = deriveAnswerSignals([{ role: "user", content: "a" }, { role: "assistant", content: "v", quality: "correct" }]);
  eq(s4.lastAnswerKind, "correct", "单次 correct→lastAnswerKind=correct");
  eq(s4.justCorrected, false, "无前序评估→justCorrected=false");
  // 11.5 连续两次 correct：不算 justCorrected
  const s5 = deriveAnswerSignals([
    { role: "user", content: "a" }, { role: "assistant", quality: "correct" },
    { role: "user", content: "b" }, { role: "assistant", quality: "correct" },
  ]);
  eq(s5.justCorrected, false, "correct→correct→justCorrected=false");
  // 11.6 空历史：安全默认
  const s6 = deriveAnswerSignals([]);
  eq(s6.lastAnswerKind, "none", "空历史→lastAnswerKind=none");
  eq(s6.justCorrected, false, "空历史→justCorrected=false");
  // 11.7 无 quality 字段的 assistant：忽略
  const s7 = deriveAnswerSignals([{ role: "user", content: "a" }, { role: "assistant", content: "v" }]);
  eq(s7.lastAnswerKind, "none", "无 quality 的 assistant→none");
}

// ==== 12. computeStuckStreak：这里是"短消息被误判成卡住"那个 bug 的回归护栏 ====
// 这组测试正是把派生逻辑从 app.js 搬进 adaptive.js 的直接原因：
// 原来它住在 app.js、没有任何测试，而下游 decideNextMove 却测得很全 ——
// "纯函数测得很全，宿主如何派生它的输入零覆盖"，于是误判长期存活。
console.log("\n[12] computeStuckStreak：答得短 ≠ 卡住");
{
  const u = (content) => ({ role: "user", content });
  const a = (quality) => ({ role: "assistant", content: "……", quality });

  // 核心回归：连续 3 条【答对】的短回答，绝不能被算成卡住 3 轮（那会触发 reveal 直接给答案）
  eq(computeStuckStreak([
    u("氧化反应"), a("correct"), u("因为熵增"), a("correct"), u("细胞膜"), a("correct"),
  ]), 0, "3 条答对的短回答→卡住 0（旧实现会算成 3，直接喂答案）");

  // 短回答 + 判定答错/含糊 → 才算卡住（保守，但不再是"短就有罪"）
  eq(computeStuckStreak([u("不知道啦"), a("vague"), u("大概吧"), a("wrong")]), 2, "短+含糊/答错→计入卡住");

  // 明说不会：不论长短、不论判定，都算卡住
  eq(computeStuckStreak([u("我不会"), a("vague"), u("真不知道"), a("none")]), 2, "明说不会→计入（与判定无关）");
  eq(computeStuckStreak([u("这道题到底该怎么推导才对呢，我完全没有思路")]), 1, "长句含「没思路」→计入");

  // 答对即终止连击：后面的卡住才算数，不能把更早的答对也算进来
  eq(computeStuckStreak([u("嗯嗯"), a("vague"), u("对"), a("correct"), u("不会"), a(null)]), 1, "最近一条才卡住→1，不被更早的连击污染");

  // 判定缺失（模型漏输出 QUALITY）时：短消息保守不计数，只认关键词
  eq(computeStuckStreak([u("嗯"), a(undefined)]), 0, "判定缺失+短消息→保守不计数");
  eq(computeStuckStreak([u("不会"), a(undefined)]), 1, "判定缺失但明说不会→仍计数");

  // 边界
  eq(computeStuckStreak([]), 0, "空历史→0");
  eq(computeStuckStreak(null), 0, "null→0");
  eq(computeStuckStreak([u("   ")]), 0, "空白消息→0");
}

// ==== 13. computeQuestionOnlyStreak / detectExplicitRequest ====
console.log("\n[13] 只问不教轮数 & 明示要答案");
{
  const asst = (content) => ({ role: "assistant", content });
  const u = (content) => ({ role: "user", content });

  eq(computeQuestionOnlyStreak([
    asst("那你觉得为什么会这样呢？"),
    asst("嗯，那如果换个条件呢？"),
    asst("再想想，还有别的可能吗？"),
  ]), 3, "连续 3 条只有问号的短回复→3（触发 summarize）");

  // 有实质讲解的回复会【终止】连击（它的作用是"已经小结过了，计数清零"）
  eq(computeQuestionOnlyStreak([
    asst("为什么？"), asst("然后呢？"),
    asst("好。这说明熵增是不可逆的。所以时间有了方向。那你想到了什么？"),
  ]), 0, "最近一条含两句以上陈述→不算只问，连击清零");
  eq(computeQuestionOnlyStreak([
    asst("好。这说明熵增是不可逆的。所以时间有了方向。那你想到了什么？"),
    asst("为什么？"), asst("然后呢？"),
  ]), 2, "小结之后又连问 2 轮→2（小结把计数清零了）");
  eq(computeQuestionOnlyStreak([asst("这是一段没有任何问号的讲解。")]), 0, "没有问号→0");
  eq(computeQuestionOnlyStreak([]), 0, "空历史→0");
  // 断言它真的能驱动出 summarize
  eq(decideNextMove({ questionOnlyStreak: computeQuestionOnlyStreak([
    asst("为什么？"), asst("然后呢？"), asst("还有呢？"),
  ]) }).move, "summarize", "派生值直接喂进决策→summarize");

  t("明示：直接告诉我", detectExplicitRequest("你别绕了，直接告诉我答案吧"));
  t("明示：告诉我答案", detectExplicitRequest("告诉我答案"));
  t("明示：别问了", detectExplicitRequest("别问了"));
  t("明示：不用引导我", detectExplicitRequest("不用引导我了，讲吧"));
  t("非明示：正常提问", !detectExplicitRequest("为什么会这样呢？"));
  t("非明示：正常作答", !detectExplicitRequest("因为熵增不可逆"));
  t("非明示：空串", !detectExplicitRequest(""));
  t("非明示：null 不崩", !detectExplicitRequest(null));

  // summarize 的指令必须明确说"不要再提问"（这是"不为了提问而提问"的落点）
  const ph = policyHint(decideNextMove({ questionOnlyStreak: 3 }));
  t("summarize 指令含「不要再提问」", ph.includes("不要再提问"));
  // 明示要答案时，reveal 的措辞必须是"照办、别反问"
  const phAsked = policyHint(decideNextMove({ explicitRequest: true }));
  t("明示要答案时 reveal 指令要求「不要先反问」", phAsked.includes("不要先反问"));
  t("非明示的 reveal 仍是破例措辞", policyHint(decideNextMove({ consecutiveStuck: 3 })).includes("破例"));
}

// ==== 14. extractQualityTag 的容错（2026-09-13 收紧） ====
console.log("\n[14] extractQualityTag：标记之后的内容不能被吞、多写一句也认得出");
{
  // ① 标记之后还有正文：旧实现 lines.splice(i) 会把它整段删掉
  const a = extractQualityTag("这是正文。\nQUALITY:correct");
  eq(a.text, "这是正文。", "标记在最后一行 → 正文保留、标记剥离");
  eq(a.quality, "correct", "标记在最后一行 → 识别为 correct");

  // ② 模型多写一句收尾语（违反"最后一行"约定）：旧实现直接判为无标记，
  //    于是标记原文会显示给用户、质量信号丢失（P1 决策退化成无信号）
  const b = extractQualityTag("这是正文。\nQUALITY:wrong\n那就继续吧");
  eq(b.quality, "wrong", "标记后又写了一句 → 仍然识别得到");
  t("标记之后的那句话被保留", b.text.includes("那就继续吧"));
  t("标记本身不出现在给用户的文本里", !b.text.includes("QUALITY"));

  // ③ 容忍有上限：往前最多看 3 个非空行，免得正文里偶然出现的同形行被当成标记
  const c = extractQualityTag("QUALITY:correct\n一\n二\n三\n这是真正的最后一句");
  eq(c.quality, "none", "标记离末尾太远 → 不认（避免误判正文）");
  t("认不出时原文原样保留", c.text.includes("这是真正的最后一句"));

  // ④ 尾随空行照旧清理
  const d = extractQualityTag("正文\n\nQUALITY:none\n\n\n");
  eq(d.text, "正文", "尾随空行被清掉");
  eq(d.quality, "none", "none 也算有效标记");

  // ⑤ 无标记：原文不动
  const e = extractQualityTag("只有正文，没有任何标记。");
  eq(e.quality, "none", "无标记 → none");
  eq(e.text, "只有正文，没有任何标记。", "无标记 → 原文不变");
}

// ==== 15. stripQualityForDisplay：流式渲染时不能把内部标记闪给用户 ====
console.log("\n[15] stripQualityForDisplay：逐字渲染时不暴露 QUALITY 标记");
{
  eq(stripQualityForDisplay("正文\nQUALITY:correct"), "正文", "完整标记被剥掉");
  eq(stripQualityForDisplay("正文\nQUA"), "正文", "半截标记（刚打到 QUA）也被盖住");
  eq(stripQualityForDisplay("正文\nQUALITY:"), "正文", "冒号刚出现");
  eq(stripQualityForDisplay("正文\nQUALITY:cor"), "正文", "判定词打了一半");
  eq(stripQualityForDisplay("正文\n  QUALITY : none"), "正文\n  QUALITY : none",
    "冒号前有空格 → 不是合法标记形态，原样保留（交给 extractQualityTag 判）");
  // 误伤防护：正文本来就可能以 Q / QU 结尾
  eq(stripQualityForDisplay("这就是 Q 值的定义。"), "这就是 Q 值的定义。", "句中 Q 不受影响");
  eq(stripQualityForDisplay("为什么会有 Q"), "为什么会有 Q", "以单字符 Q 结尾的正文不被误砍");
  eq(stripQualityForDisplay("这个 QU 代表什么"), "这个 QU 代表什么", "以 QU 结尾但后面还有字 → 不受影响");
  eq(stripQualityForDisplay("正文\n那就继续吧"), "正文\n那就继续吧", "标记之后的收尾语保留");
  // 关键不变量：结果永远是入参的前缀（流式增量追加依赖这一点）
  const samples = ["正文\nQUALITY:correct", "正文\nQUA", "为什么会有 Q", "a\n\n", ""];
  t("结果始终是入参前缀（增量追加的前提）",
    samples.every((s) => s.startsWith(stripQualityForDisplay(s))));
  eq(stripQualityForDisplay(""), "", "空串安全");
  eq(stripQualityForDisplay(null), "", "null 安全");
}

console.log("\n自适应决策层：结果 " + pass + " 通过 / " + fail + " 失败");
if (fail > 0) process.exit(1);
