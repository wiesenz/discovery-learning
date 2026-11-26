/* =====================================================================
 *  Socratopia v0 · 因材施教决策层（确定性策略纯函数）
 *  ---------------------------------------------------------------------
 *  第一性原理：苏格拉底式教学是一个「感知学习者认知状态 → 决定下一步教学动作」
 *  的控制回路。此前「下一步怎么问」完全交给 LLM 临场散文推断，导致行为不可测、
 *  不可调试、不跨会话积累、不可调。本模块把「决策」从 LLM 的脑子里搬到代码里：
 *  decideNextMove 是一个纯函数，输入学习者认知信号，输出唯一确定的下一步动作；
 *  LLM 只负责把选定的动作「渲染成人话」。
 *
 *  本模块无任何隐藏状态、不读 DOM、不依赖全局；所有输入显式传参，可直接单测。
 *
 *  用法：
 *    import { decideNextMove, policyHint } from "./adaptive.js";
 *    const decision = decideNextMove(signals);   // { move, target, hintLevel, why, n }
 *    const line = policyHint(decision);           // 注入系统提示词的短指令（可能为空串）
 * ===================================================================== */

// 8 个教学动作。其中 diagnose / justify / hint / reveal / transfer / decompose / reflect
// 在 config.js 的散文规则里已存在，本模块只是把它们从「散文」变成「确定性代码」；
// counterexample（按已知误区挑反例）是此前缺失、却增益最稳的一类。
export const MOVES = [
  "diagnose",       // 诊断性前测：该知识点无证据，先轻量校准
  "justify",        // 要理由：答得含糊/极短，让其用自己的话论证
  "counterexample", // 反例：命中已知误区，用反例/新情境精确砸
  "decompose",      // 拆解：答错了，拆成更小子问题逐步引导
  "hint",           // 脚手架提示：卡住时给更小的方向性提示
  "reveal",         // 兜底给答案：连续卡住多轮 / 学生明示要答案，破例直给
  "summarize",      // 搭桥小结：连着问了多轮没有实质输出，该把已推出的串成一小段
  "transfer",       // 迁移：刚答对且流利，换情境应用题
  "reflect",        // 元认知：刚突破/纠错成功，反问「卡在哪、怎么想通」
  "proceed",        // 维持：无特殊信号，常规苏格拉底追问
];

// 由熟悉度推导默认脚手架强度（仅作 proceed 的兜底，不覆盖上面的确定性信号）
function familiarityHintLevel(fam) {
  // 20260913 修复：宿主的熟悉度来自界面上的三档中文枚举（index.html 的 data-fam：
  // 「完全没接触过（小白）」/「学过一点」/「比较熟」），而这里原本只认英文 "familiar"，
  // 两边永远不相等 → 恒返回 1 → 用户唯一那个"按我的档位调强度"的入口在确定性层完全空转。
  // 两套取值都认（旧存档 / 单测里可能仍是英文档位）。
  if (fam === "familiar" || fam === "比较熟") return 2; // 熟：少铺垫、快节奏、上边界挑战
  return 1;                                             // none / some / 小白 / 学过一点 / undefined
}

/**
 * 依据学习者认知信号，确定性地决定本轮教学动作。
 *
 * 【输入说明，20260913 逐项核对过"是否真的被读取"】
 *  · 全部入参都是可选的；宿主实际只传下面标了 ✅ 的那些。
 *  · kpEvidence ⚠️ 目前宿主【从不传 false】，所以 diagnose 分支在生产里不会触发
 *    （首次教学的前测改由 config.js 的散文规则兜）。分支与单测都保留 —— 它是待接线的
 *    扩展点，不是坏代码；但要清楚：改它之前，它在线上等于不存在。
 *  · （已删）原先还有一个 s.mastery 参数写在文档里，但函数体从未读过它、宿主也早已不传，
 *    属于"文档承诺了、实现不支持"的假事实，20260913 移除。
 *
 * @param {object} s
 * @param {string[]} [s.misconceptions]     已知历史误区短语列表 ✅（宿主传 activeMisconceptions()）
 * @param {number}   [s.consecutiveStuck]   连续卡住轮数（≥0）✅
 * @param {number}   [s.questionOnlyStreak] 连续"只提问没有实质输出"的轮数 ✅
 * @param {boolean}  [s.explicitRequest]    学习者是否明示"直接告诉我答案" ✅
 * @param {string}   [s.lastAnswerKind]     "correct"|"wrong"|"vague"|"none" ✅
 * @param {string}   [s.familiarity]        "none"|"some"|"familiar"，也接受界面上的中文档位 ✅
 * @param {boolean}  [s.justCorrected]      刚刚完成一次纠错 ✅
 * @param {boolean}  [s.kpEvidence]         该知识点是否已有任何掌握证据（见上，当前未接线）
 * @returns {{move:string,target:?string,hintLevel:number,why:string,n:number}}
 *   注：hintLevel 与 why 目前【没有消费方】—— buildSystemPrompt 只用 policyHint 渲染出的文案。
 *   它们是有单测覆盖的返回值（记录了"这个动作本该用多强的脚手架、为什么选它"），
 *   先留着当决策留痕；哪天要用（比如按 hintLevel 调提示词强度）直接取即可，别再去 grep 找消费者。
 */
export function decideNextMove(s) {
  const st = s || {};
  const misconceptions = Array.isArray(st.misconceptions) ? st.misconceptions : [];
  const consecutiveStuck = typeof st.consecutiveStuck === "number" && st.consecutiveStuck >= 0 ? st.consecutiveStuck : 0;
  const lastAnswerKind = st.lastAnswerKind || "none";
  const familiarity = st.familiarity || "none";
  const justCorrected = !!st.justCorrected;
  // 学生这一轮是否明示"直接告诉我答案/别问了"（由 detectExplicitRequest 从原文派生）
  const explicitRequest = !!st.explicitRequest;
  // 连续多少轮"只有提问、没有实质输出"（由 computeQuestionOnlyStreak 派生）
  const questionOnlyStreak = typeof st.questionOnlyStreak === "number" && st.questionOnlyStreak >= 0 ? st.questionOnlyStreak : 0;
  // kpEvidence 默认视为「有依据」：仅当显式传 false 才走诊断前测，
  // 避免默认无证据导致每轮都逼前测（诊断应是低频的首次接触动作，而非默认路径）。
  const kpEvidence = st.kpEvidence === false ? false : true;

  // 0) 学生【明示】要答案 —— 最高优先级。
  //    config.js 的散文规则本来就写了这条豁免（学生说"直接告诉我"要照办），
  //    但代码层此前没有对应通路：这类话不匹配任何"卡住"关键词，也不一定被判 vague，
  //    于是系统会继续追问、甚至命令老师"让他论证为什么"——最该停止提问的场景恰好失效。
  if (explicitRequest) {
    return { move: "reveal", target: null, hintLevel: 3, why: "学生明确要求直接给出答案，按规则不再追问", n: consecutiveStuck, asked: true };
  }
  // 1) 连续卡住 ≥3 轮 —— 按规则破例直接给答案。
  //    20260913 提到误区之前：原顺序是「误区 > 卡住」，而误区只会被追加、永不消费
  //    （全库无删除/治愈路径），于是某个主题一旦记下误区，这里就永远不可达——
  //    "卡住多轮就破例给答案"这条兜底路径在有误区的主题里彻底失效，只剩无限追问。
  //    卡住是更紧急的信号：先解困，再谈精确纠偏。
  if (consecutiveStuck >= 3) {
    return { move: "reveal", target: null, hintLevel: 3, why: "连续卡住≥3轮，破例直接给答案并附说明", n: consecutiveStuck };
  }
  // 2) 命中已知历史误区 —— 用反例精确砸，而非泛泛追问（仍高于普通脚手架提示）
  if (misconceptions.length) {
    return {
      move: "counterexample",
      target: misconceptions[0],
      hintLevel: 2,
      why: "命中已知历史误区，需用反例/新情境精确砸，引导其自行发现矛盾",
      n: misconceptions.length,
    };
  }
  // 3) 卡住中 —— 给更小的方向性脚手架提示（强度随卡住轮数递增，封顶 3）
  if (consecutiveStuck >= 1) {
    return { move: "hint", target: null, hintLevel: Math.min(3, consecutiveStuck), why: "已连续卡住，给更小的方向性脚手架提示，不直接给答案", n: consecutiveStuck };
  }
  // 4) 答得含糊/极短 —— 让其用自己的话论证
  if (lastAnswerKind === "vague") {
    return { move: "justify", target: null, hintLevel: 1, why: "答得含糊，请让其用自己的话复述/论证为什么，确认真懂", n: 0 };
  }
  // 5) 答错了 —— 拆成更小子问题逐步引导
  if (lastAnswerKind === "wrong") {
    return { move: "decompose", target: null, hintLevel: 2, why: "答错了，拆成更小子问题一步步引导自行推导", n: 0 };
  }
  // 5.5) 只问不教到第 3 轮 —— 强制搭桥小结。
  //      这是"不要为了提问而提问"在确定性层唯一的落点：config.js 早就写明
  //      「连续追问 2~3 轮后主动把已推出的零散结论搭成一小段」，但状态机里此前
  //      **根本没有"小结"这个动作**，代码无法下达这个指令，只能下令"问"或"给答案"。
  //      放在 remedial 信号（hint/justify/decompose）之后：先处理学生的即时状态，
  //      再处理老师的节奏；但排在 reflect/transfer 之前——连着问了 3 轮，该先夯实再迁移。
  if (questionOnlyStreak >= 3) {
    return { move: "summarize", target: null, hintLevel: 0, why: "已连续 " + questionOnlyStreak + " 轮只提问没有实质输出，先搭桥小结再继续", n: questionOnlyStreak };
  }
  // 6) 刚纠错成功 —— 元认知反问固化
  if (lastAnswerKind === "correct" && justCorrected) {
    return { move: "reflect", target: null, hintLevel: 0, why: "刚突破/纠错成功，用元认知反问帮他固化", n: 0 };
  }
  // 7) 刚答对且流利 —— 换情境迁移题
  if (lastAnswerKind === "correct") {
    return { move: "transfer", target: null, hintLevel: 1, why: "刚答对且流利，换新情境应用题考能否迁移", n: 0 };
  }
  // 8) 该知识点显式无掌握证据（且上述信号皆无）—— 低频诊断前测校准节奏
  if (kpEvidence === false) {
    return { move: "diagnose", target: null, hintLevel: 1, why: "该知识点显式无掌握证据，先做轻量前测校准节奏与推论/披露比重", n: 0 };
  }
  // 9) 无特殊信号 —— 维持常规苏格拉底追问（强度按熟悉度兜底）
  return { move: "proceed", target: null, hintLevel: familiarityHintLevel(familiarity), why: "无特殊信号，维持苏格拉底式追问", n: 0 };
}

/**
 * 把决策渲染成注入系统提示词的短指令。返回 "" 表示「无需注入」（保持默认行为，不干扰）。
 * @param {{move:string,target:?string,hintLevel:number,why:string,n:number}} d
 * @returns {string}
 */
export function policyHint(d) {
  if (!d || !d.move) return "";
  switch (d.move) {
    case "counterexample":
      return "针对已知误区「" + (d.target || "") + "」，请设计一个能暴露它的反例或新情境，引导学习者自己发现矛盾；不要直接说破。";
    case "diagnose":
      return "本轮建议先做诊断性前测：用 1~2 个极简回忆题测一下他真实掌握到哪，再据此定引导节奏与「推论/披露」比重。";
    case "reveal":
      return d.asked
        ? "学习者已明确表示想直接知道答案。请照办：用一两句大白话把结论讲清楚（不要先反问、不要再引导他自己推），紧接着把「为什么」点透，最后用一个小应用题确认他接住了。"
        : "学习者已连续卡住多轮，可按规则破例直接给出答案（附「这是破例直接教你的哦」之类说明），之后用一个小应用题确认。";
    case "summarize":
      return "已连续 " + (d.n || 3) + " 轮只有提问、没有实质输出。这一轮【不要再提问】：用一两句把刚才已经推出的零散结论搭成一小段小结（如「所以我们其实推出了……对吧？」），让他看到进展、有个落点。小结完再决定要不要继续问。";
    case "hint":
      return "学习者已卡住 " + (d.n || 1) + " 轮，请给一个更小的方向性脚手架提示，不要直接给答案。";
    case "justify":
      return "他答得含糊/极短，请让他用自己的话复述或论证「为什么」，确认真懂了。";
    case "decompose":
      return "他答错了，请把问题拆成更小的子问题，一步步引导他自己推导出正确思路。";
    case "reflect":
      return "他刚突破/纠错成功，请用一个元认知反问帮他固化：「刚才卡在哪、是怎么想通的？」";
    case "transfer":
      return "他刚答对且流利，请换一个课上没讲过的新情境应用题，考他能否把概念迁移过去。";
    case "proceed":
    default:
      return "";
  }
}

/**
 * 从随堂测验的答错结果，确定性地派生「需要立即写入学习记忆的误区文本」。
 * 0 token：全部来自题目对象已有的字段，不发起任何 LLM 调用。
 *
 * 触发规则（只在「答错的题」上触发，避免噪音）：
 *  - 题目自带 misconception 文本（LLM 生成时，针对 quizFocusBlock 列出的已知误区所填）
 *    → 直接采用，信噪比最高；
 *  - 否则用题目规范化后的知识点（kpOf 派生）生成模板文本，作为「该知识点存在理解误区」的标记。
 *
 * 返回去重后的字符串数组；不负责持久化（持久化由宿主 recordMisconceptions 完成）。
 * @param {Array}  quiz    测验题数组（每题含 answer / 可选 misconception / kp 等）
 * @param {Array}  picked  每题用户所选索引（与 quiz 同序）
 * @param {(it:object)=>?string} [kpOf] 由题目派生规范化知识点短语的函数（如 quiz.js 的 normKpOf）
 * @returns {string[]}
 */
export function deriveMisconceptionsFromWrongQuiz(quiz, picked, kpOf) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(quiz) || !Array.isArray(picked)) return out;
  quiz.forEach((it, i) => {
    if (!it) return;
    if (picked[i] === it.answer) return; // 仅答错的题
    const explicit = (it.misconception && String(it.misconception).trim())
      ? String(it.misconception).trim()
      : null;
    if (explicit) {
      const key = explicit.toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(explicit); }
      return;
    }
    const nk = kpOf ? kpOf(it) : null;
    if (nk) {
      const t = "对「" + nk + "」的理解存在误区（随堂测验答错）";
      const key = t.toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(t); }
    }
  });
  return out;
}

/**
 * 从 LLM 一轮 chat 回复文本里提取「作答质量自评标记」（QUALITY:xxx），并把该标记从
 * 正文剥离，避免作为可见内容渲染。纯函数、可单测。
 *
 * 标记约定见 config.js 的 answerQualityRules：要求 AI 在回复【最后一行】单独输出
 *   QUALITY:correct | wrong | vague | none
 * 此处容错解析：仅匹配末尾最后一个非空行；无标记则返回原文本 + quality:"none"。
 *
 * @param {string} text  LLM 原始回复
 * @returns {{text:string, quality:string}}
 */
export function extractQualityTag(text) {
  const raw = (text == null ? "" : String(text));
  const re = /^[ \t]*QUALITY:[ \t]*(correct|wrong|vague|none)[ \t]*$/i;
  const lines = raw.split("\n");
  let quality = "none";
  // 从末尾往前找标记，允许它前面有尾随空行。
  // 20260913 两处收紧：
  //  ① 旧写法 `lines.splice(i)` 删掉标记行【及其后全部内容】。约定的"其后只有空行"一旦
  //     不成立（模型把收尾的话写在标记之后），那句正文就被静默吞掉。现在只删标记这一行。
  //  ② 旧写法只认"最后一个非空行"。模型偶尔多写一句收尾语（"那就继续吧"）就会导致
  //     整条标记识别失败 —— 质量信号丢失（P1 决策退化成无信号），而且标记原文会
  //     原样显示给用户。现在容忍地往前多看两行。
  let checked = 0;
  for (let i = lines.length - 1; i >= 0 && checked < 3; i--) {
    if (lines[i].trim() === "") continue;
    checked++;
    const m = lines[i].match(re);
    if (m) {
      quality = m[1].toLowerCase();
      lines.splice(i, 1); // 只删标记行本身
      break;
    }
  }
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return { text: lines.join("\n"), quality };
}

// 末尾可能正在到达的 QUALITY 内部标记（含半截：QU / QUA / QUALITY:cor …）。
// 冒号后允许 0~8 个小写字母，才能把 "QUALITY:cor" 这类中间态也盖住。
// 刻意【不】收单字符 "Q"：正文本来就可能以 Q 结尾（"为什么会有 Q"），砍掉它是真实误伤；
// 而标记的第一个字符 Q 只会在流式里闪一帧，肉眼几乎看不见。两害相权取轻。
const QUALITY_TAIL_RE = /[\s]*(?:QU|QUA|QUAL|QUALI|QUALIT|QUALITY)(?::[ \t]*[a-z]{0,8})?$/i;

/**
 * 把末尾的 QUALITY 标记从"给用户看的文本"里剥掉（含只到一半的）。
 * 20260913 从 app.js 迁入：它和 extractQualityTag 是同一件事的两面（一个给决策用、一个给显示用），
 * 分居两个文件时"标记形态"改一处就得记得改另一处 —— 上面那个正则和 extractQualityTag 里的
 * 正则必须同步，放一起才看得见这层耦合。顺便也进了单测（见 js/adaptive.test.mjs 第 15 组）。
 *
 * 为什么需要它：完整回复走的是 extractQualityTag（整段剥离），但流式渲染是**逐字追加**的，
 * 标记会一路显示给用户（"QUALITY:correct" 一闪而过，甚至停在屏幕上）。
 * 只看末尾 40 个字符，开销可忽略。
 * @param {string} s 流式累积的文本
 * @returns {string} 可安全显示的文本（始终是入参的前缀）
 */
export function stripQualityForDisplay(s) {
  const str = (s == null ? "" : String(s));
  const tailStart = Math.max(0, str.length - 40);
  const m = str.slice(tailStart).match(QUALITY_TAIL_RE);
  return m ? str.slice(0, tailStart + m.index) : str;
}

/**
 * 从对话历史派生 P1 决策所需的真实「作答质量信号」。
 * 历史里每条 assistant 消息可携带 .quality（由 extractQualityTag 在渲染前写入），
 * 表示 AI 对「学生上一条回答」的判定。纯函数、可单测。
 *
 * @param {Array<{role:string, quality?:string}>} hist  apiHist() 返回的消息数组
 * @returns {{lastAnswerKind:string, justCorrected:boolean}}
 *   - lastAnswerKind：最近一次评估的质量（"correct"|"wrong"|"vague"|"none"）
 *   - justCorrected：上一次评估为 wrong/vague、且最近一次为 correct（即「刚纠错成功」）
 */
export function deriveAnswerSignals(hist) {
  const quals = [];
  if (Array.isArray(hist)) {
    // 对话本就是 user/assistant 交替：从末尾往前收集最近 2 条 assistant 的 quality
    // （用户消息只是间隔，跳过即可；每条 assistant 评估的是它前面紧邻的 user 回答）
    for (let i = hist.length - 1; i >= 0 && quals.length < 2; i--) {
      const m = hist[i];
      if (m && m.role === "assistant" && m.quality) quals.unshift(m.quality);
    }
  }
  const last = quals[quals.length - 1] || "none";
  const prev = quals[quals.length - 2] || "none";
  const justCorrected = (prev === "wrong" || prev === "vague") && last === "correct";
  return { lastAnswerKind: last, justCorrected };
}

/* =====================================================================
 *  以下三个是 decideNextMove 的【输入派生函数】，2026-09-13 从 app.js 迁入。
 *
 *  迁入的理由不只是"app.js 行数红线"，更是为了修掉一个真实的覆盖盲区：
 *  这些逻辑原本写在 app.js 里，而它们的下游 decideNextMove 在 js/adaptive.test.mjs
 *  里被逐分支测得很全 —— 于是结果是「纯函数测得很全，宿主如何派生它的输入零覆盖」。
 *  真实后果：computeStuckStreak 曾把"≤6 字的消息"一律当成"卡住"，
 *  于是「氧化反应」「因为熵增」这种又快又对的回答会被算成卡住，连续 3 条就触发
 *  reveal（破例直接给答案）——对答得最流利的学生反向施教，且没有任何测试会报。
 *  搬到这里之后，它们能被单测直接喂真实历史验证（见 js/adaptive.test.mjs 第 11~13 组）。
 * ===================================================================== */

/** 取第 i 条消息之后、最近一条带 quality 判定的 assistant 消息的判定值。
 *  AI 每轮把它对"学生这条回答"的评价挂在【自己那条回复】上，所以学生的第 i 条
 *  回答对应的判定要去后面找。找不到返回 null（= 未知，调用方需按保守处理）。 */
function qualityAfter(hist, i) {
  for (let j = i + 1; j < hist.length; j++) {
    const m = hist[j];
    if (m && m.role === "assistant" && m.quality) return m.quality;
  }
  return null;
}

// 学生"卡住了"的自然说法。补上「没有思路 / 没头绪」这类口语变体——
// 原表只有「没思路」，而学生更常写「完全没有思路」，那就不匹配了（20260913 实测发现）。
const STUCK_RE = /不知道|不会|没思路|没有思路|没头绪|卡住|想不出|帮帮|提示|hint|stuck|懵|怎么写|怎么做/i;

/**
 * 从真实对话历史派生「连续卡住轮数」：统计末尾连续几轮学习者处在卡住状态。
 *
 * 判定规则（20260913 重写）：
 *  - 明说不会/要提示（关键词）→ 卡住。这是最强信号，与判定值无关。
 *  - 极短消息（≤6 字）→ **只有在被判定为答错/含糊时**才算卡住。
 *    旧写法把"短"直接等同"卡住"，把「氧化反应」这类又快又对的回答也算进去，
 *    连续三条就触发 reveal 直接喂答案 —— 对最流利的学生反向施教。
 *  - 已判定答对 → 这轮不是卡住，且连击到此为止（不再往前数）。
 *  - 判定未知（模型漏输出 QUALITY）→ 极短消息按"不知道"处理，不计数。
 *    宁可少触发脚手架（散文规则仍会兜），也不能误判成"卡住"而喂答案。
 *
 * @param {Array<{role:string,content?:string,quality?:string}>} hist
 * @returns {number} 连续卡住轮数（0 表示没卡住）
 */
export function computeStuckStreak(hist) {
  if (!Array.isArray(hist)) return 0;
  let streak = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (!m || m.role !== "user") continue;
    const c = (m.content || "").trim();
    if (!c) continue;
    const q = qualityAfter(hist, i);
    if (q === "correct") break; // 答对了 → 不是卡住，且连击结束
    if (STUCK_RE.test(c)) { streak++; continue; }
    if (c.length <= 6 && (q === "wrong" || q === "vague")) { streak++; continue; }
    break;
  }
  return streak;
}

/** 单条回复是否"只问不教"：有问号，但几乎没有陈述性内容（没有实质讲解/小结）。
 *  启发式，用于给"提问密度"一个可计算的信号——不追求精确，只求能触发守卫。 */
function isQuestionOnly(text) {
  if (!/[？?]/.test(text)) return false;                          // 没有问号 → 不是"只问"
  const tells = (text.match(/[。！!；;]/g) || []).length;
  if (tells >= 2) return false;                                   // 至少两句陈述 → 有实质输出
  if (text.length > 220) return false;                            // 长回复通常含铺垫/讲透
  return true;
}

/**
 * 从对话历史派生「连续只提问、没有实质输出」的轮数。
 * 供 decideNextMove 在连着问了好几轮时强制下达"搭桥小结"（summarize）——
 * 这是"不要为了提问而提问"在代码层唯一的落点。
 * @param {Array<{role:string,content?:string}>} hist
 * @returns {number}
 */
export function computeQuestionOnlyStreak(hist) {
  if (!Array.isArray(hist)) return 0;
  let streak = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (!m || m.role !== "assistant") continue;
    const c = (m.content || "").trim();
    if (!c) continue;
    if (isQuestionOnly(c)) { streak++; continue; }
    break;
  }
  return streak;
}

// 学生"明示要答案"的说法。刻意收得紧一些：宁可漏（散文规则仍会兜），
// 不可误伤——把普通的追问请求当成"他不想学了"会直接把课讲废。
const EXPLICIT_RE = /直接(?:告诉|说|讲|给|公布|揭晓)我|告诉我答案|给我答案|直接给答案|直接说答案|公布答案|揭晓答案|别(?:再)?问了|不用(?:再)?引导|不要引导|别让我猜/i;

/**
 * 学生这句话是不是在明示"别问了，直接告诉我"。
 * config.js 的散文规则里本来就写了这条豁免，但代码层此前没有对应通路，
 * 于是这类话既不匹配"卡住"关键词、也不一定被判 vague，系统会继续追问。
 * @param {string} text 最后一条用户消息原文
 * @returns {boolean}
 */
export function detectExplicitRequest(text) {
  const c = (text == null ? "" : String(text)).trim();
  if (!c) return false;
  return EXPLICIT_RE.test(c);
}
