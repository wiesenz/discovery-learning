/* =====================================================================
 *  Socratopia v0 · 系统提示词组装（js/prompt.js）
 *  ---------------------------------------------------------------------
 *  纯函数层：把「系统提示词」按 mode 组装为「静态段（整节课/会话稳定）」
 *  与「动态段（每轮可能变化）」两部分。至于这两段分别放在消息数组的哪个位置，
 *  由宿主按 config.cacheLayout 决定（见 js/core.js 的 assembleChatMessages）——
 *  位置直接决定 provider 的「最长公共前缀」缓存能覆盖到哪，是本模块存在的核心原因。
 *
 *  所有运行时派生数据（记忆、画像、番茄提示、续学、错题、群聊记录等）
 *  都由调用方通过 ctx 注入，本模块不读取 localStorage / 不访问 DOM，
 *  以保证可独立单元测试、且不引入隐藏的状态耦合。
 *
 *  浏览器：通过 <script type="module"> 加载；Node 测试用 import。
 * ===================================================================== */
import { APP_CONFIG } from "../config.js";
import { indexChapterPositions, needsReindex } from "./outline.js";

// core.js 是 UMD（挂 window.SocratopiaCore）；浏览器里取全局，Node 里回退 require。
const SocratopiaCore = (typeof window !== "undefined" && window.SocratopiaCore) ||
  (typeof require !== "undefined" ? require("./core.js") : {});
const estimateTokens = (SocratopiaCore && SocratopiaCore.estimateTokens) || (() => 0);

// ---- 纯函数（从 app.js 迁入，无 DOM / localStorage 依赖） ----
export function findLessonById(book, lid) {
  if (!book || !book.outline) return null;
  const chapters = book.outline.chapters || [];
  for (let ci = 0; ci < chapters.length; ci++) {
    const ch = chapters[ci];
    const lessons = ch.lessons || [];
    for (let li = 0; li < lessons.length; li++) {
      if (lessons[li].id === lid || (lid === undefined && li === 0)) {
        return { lesson: lessons[li], chapter: ch, chapterIndex:  ci, lessonIndex: li };
      }
    }
  }
  return null;
}

// ⚠️ 上面那个 findLessonById 的「唯一实现」地位，2026-09-08 那次只写进了注释、没真做：
//    当时的注释声称「app.js 从本模块导入此函数（去重后为唯一实现），必须 export」，
//    但事实上 app.js 既有自己的同名实现、也从未导入本模块的这份，而这份连 export 都没有。
//    真正的去重发生在 20260913：本函数加 export，app.js 改为调用它（只把当前教材绑上去）。
//    教训：注释描述"已经做过的事"时，必须与代码同时落地——否则它会变成最难查的那种假事实
//    （读代码的人会相信它，从而漏改另一份副本）。
// 取某课时应看的原文区间：优先用「在所属章内按知识点定位到」的区间（_located=true），
// 定位不到就退回整章（章边界来自原文真实标题，比按课时均分可靠）。
// 缺索引时现算一次（纯函数、零 token），兼容老大纲数据。
function lessonMaterialRange(material, book, lesson) {
  const od = book && book.outline;
  const chapters = (od && Array.isArray(od.chapters)) ? od.chapters : [];
  if (!chapters.length) return null;
  // 旧大纲（算法版本落后，如还没有章内课时定位）也重算一次，零 token 免重生成
  if (needsReindex(od)) indexChapterPositions(material, od);
  for (const ch of chapters) {
    const lessons = (ch && ch.lessons) || [];
    const li = lessons.findIndex((ls) => ls === lesson || (lesson.id && ls && ls.id === lesson.id));
    if (li < 0) continue;
    const chStart = typeof ch._charStart === "number" ? ch._charStart : 0;
    const chEnd = typeof ch._charEnd === "number" ? ch._charEnd : material.length;
    const ls = lessons[li];
    // 优先用本课已算出的区间（无论是「关键词精确定位」还是「章内均分兜底」都算在内）：
    // 只要 indexLessonPositions 给了合法坐标就直接用，避免「未精确定位就退回整章」导致内容漂移
    // （旧逻辑对 _located=false 的课时直接退回整章，使第 N 课拿到全书开头，见 lesson-logic E2E）。
    if (ls && typeof ls._charStart === "number" && typeof ls._charEnd === "number" && ls._charEnd > ls._charStart) {
      return { start: ls._charStart, end: ls._charEnd, located: ls._located === true };
    }
    return { start: chStart, end: chEnd, located: false };
  }
  return null;
}

export function sliceMaterialForLesson(lesson, book) {
  const mat = (book && book.material) || "";
  if (!mat || !lesson) return "";
  const fullMaterial = mat.trim();
  if (fullMaterial.length <= APP_CONFIG.limits.shortBookChars) return fullMaterial;
  const MAX_SLICE = APP_CONFIG.limits.lessonSliceChars; // 单课切片上限（由窗口派生，原硬编码 8000 已远低模型能力）
  const range = lessonMaterialRange(fullMaterial, book, lesson);
  if (range && range.end > range.start) {
    let { start, end } = range;
    if (end - start > MAX_SLICE) {
      if (range.located) {
        end = start + MAX_SLICE; // 已定位：本课内容就在区间开头，从头取即可
      } else {
        // 未定位（整章回退）：以本课在章内的位置为中心开窗，而不是从头截断
        const mid = start + Math.round((end - start) / 2);
        start = Math.max(0, mid - Math.round(MAX_SLICE / 2));
        end = Math.min(fullMaterial.length, start + MAX_SLICE);
      }
    }
    const slice = fullMaterial.slice(start, end);
    if (slice.trim().length > 0) {
      return slice + "\n\n（…以上为本课对应的教材片段，" +
        (range.located ? "已按本课知识点在所属章内定位切出。" : "本课在章内未能精确定位，已给出以本课位置为中心的本章片段。") + "）";
    }
  }
  const flat = [];
  if (book && book.outline && book.outline.chapters) {
    (book.outline.chapters || []).forEach((ch) => (ch.lessons || []).forEach((ls) => flat.push(ls)));
  }
  const idx = flat.findIndex((l) => l && l.id === lesson.id);
  if (idx < 0 || !flat.length) {
    return fullMaterial.slice(0, MAX_SLICE) + "\n\n（…材料较长，已截断；老师请聚焦本课主题引导。）";
  }
  const start = Math.floor(fullMaterial.length * idx / flat.length);
  const end = Math.floor(fullMaterial.length * (idx + 1) / flat.length);
  const slice = fullMaterial.slice(start, end);
  return (slice.length > MAX_SLICE ? slice.slice(0, MAX_SLICE) : slice) +
    "\n\n（…以上为本课对应的教材片段，已按课时顺序比例切出。）";
}

export function outlineForLessonStart(od) {
  if (!od) return "（无大纲）";
  const full = JSON.stringify(od, null, 0);
  if (estimateTokens(full) <= APP_CONFIG.limits.outlineSendBudgetTok) return full; // 绝大多数书安全直发
  const compact = {
    bookTitle: od.bookTitle,
    teachingRoute: od.teachingRoute,
    globalDerivation: od.globalDerivation,
    chapters: (od.chapters || []).map((ch) => ({
      title: ch.title,
      lessons: (ch.lessons || []).map((ls) => ({ id: ls.id, title: ls.title, focus: ls.focus })),
    })),
  };
  let json = JSON.stringify(compact, null, 0);
  if (estimateTokens(json) <= APP_CONFIG.limits.outlineSendBudgetTok) return json;
  // 极端厚书：仅保留章节标题与每章课时数，提示用户看课程树
  const skeleton = { chapters: (od.chapters || []).map((ch) => ({ title: ch.title, lessonCount: (ch.lessons || []).length })) };
  return JSON.stringify(skeleton, null, 0) + "\n（注：大纲过长已压缩为章节骨架；完整课时列表见左侧课程树。）";
}

// ctx 约定（全部由调用方注入，保证本模块无隐藏状态）：
//  mode, roleName, role{ persona, voice }, topic, book, lessonId,
//  material (非课时模式的整本材料), familiarity, userAlias,
//  tomatoHint, resumeInfo{ summary }, wrongBlock, reviewBlock,
//  isReviewLesson, memoryBlock, userProfileBlockStr, roster,
//  quizFocusBlock (lessonEnd 出题聚焦), policyHintBlock (chat 确定性策略建议)
function appendFinalInstruction(mode, ctx, parts) {
  // review 模式在原实现里提前 return，没有结尾指令；其余模式才有。
  if (mode === "intro") {
    parts.push("现在，请以「" + ctx.roleName + "」的身份（保持上面的人设与说话语气），称学习者为「" + ctx.userAlias + "」，严格按照上面的开场导读规则，产出导读内容。");
  } else if (mode === "lessonEnd") {
    parts.push("现在，请以「" + ctx.roleName + "」的身份（人设与语气只体现在 JSON 各字段的措辞上），按下课总结规则，产出严格 JSON（summary + quiz）。");
  } else if (mode === "group") {
    parts.push("现在，请以群聊主持人身份，组织老师点评（每位老师用自己的人设与称呼，不要串成一个人）。");
  } else if (mode === "lessonStart" || mode === "chat") {
    const who = ctx.topic ? ("「" + ctx.topic + "」") : "当前主题";
    parts.push("现在，请以「" + ctx.roleName + "」的身份，用提问引导" + ctx.userAlias + "学习" + who + "。等" + ctx.userAlias + "先开口，或用第一个引导性问题开启。");
  }
}

// 静态段：整节课/整会话内逐字节稳定（角色 / 规则 / 教材切片 / 大纲 / 主题）。
export function buildStaticSystem(mode, ctx) {
  const role = ctx.role || {};
  const parts = [];

  if (mode === "intro") {
    parts.push(APP_CONFIG.introRules);
    // 20260913 修复：intro 此前【完全没有角色注入】（只有 introRules + 收尾一句"以「角色名」的身份"）。
    // 而同一屏的等待气泡用的是角色专属 thinkingPhrases（"唔…咱正在脑子里翻小本本呢…"）——
    // 于是用户看到的第一条回复是：气泡在演三月七、正文却是中性 AI 助手口吻，甚至自称"我是一个 AI 学习助手"。
    // 首因效应最强的一屏就跳戏，故与 lessonStart/chat 对齐：人设 + 语气。
    if (role.persona) parts.push("【你的角色人设】\n" + role.persona);
    if (role.voice) parts.push("【你的说话语气与表达方式】\n" + role.voice);
    parts.push(APP_CONFIG.emoteRules);
  } else if (mode === "lessonEnd") {
    parts.push(APP_CONFIG.lessonEndRules);
    // 20260913 修复：lessonEnd 同样无人设/语气——整节课用角色口吻上完，一点「📚 下课」，
    // 知识总结卡与每道题的解析突然变回标准客服腔；而 config.js 的 lessonEndRules 里
    // 明确要求 summary / explanation "保持你的角色口吻"。这又是会被收藏、回看的产出。
    // 注意：本模式必须返回纯 JSON，故人设之后【重申输出约束】——否则人设（位置更靠后、
    // 更"近"）会盖过 lessonEndRules 里"不要任何额外角色台词"的要求。
    if (role.persona) parts.push("【你的角色人设】\n" + role.persona);
    if (role.voice) parts.push("【你的说话语气与表达方式】\n" + role.voice);
    if (role.persona || role.voice) {
      parts.push("（上面的人设与语气只用于决定 JSON 里各字段【措辞】的口吻；不要因此输出任何额外台词、问候或解释，仍然只返回一个严格 JSON 对象。）");
    }
    const locE = ctx.lessonId ? findLessonById(ctx.book, ctx.lessonId) : null;
    if (locE && locE.lesson && locE.lesson.keyPoints && locE.lesson.keyPoints.length) {
      let blk = "【本课关键知识点清单（keyPoints，用于覆盖度自评）】\n";
      blk += locE.lesson.keyPoints.map((k, i) => (i + 1) + ". " + k).join("\n");
      if (locE.lesson.focus) blk += "\n\n核心目标（focus）：" + locE.lesson.focus;
      if (locE.lesson.logicFlow) blk += "\n\n本课论证脉络（logicFlow）：" + locE.lesson.logicFlow;
      blk += "\n\n请对照上面的清单，逐条判断哪些讲到了、哪些没讲到，如实填入 coveredKeyPoints / uncoveredKeyPoints。";
      parts.push(blk);
    }
  } else if (mode === "group") {
    parts.push(APP_CONFIG.groupRules);
    // 顺序调整（20260913）：人设表挪到【上课记录之前】。原顺序是 rules → transcript → roster，
    // 多角色人设被整段上课记录挤到后面，注意力权重被稀释；规则紧接着人设也更连贯。
    if (ctx.roster) parts.push(ctx.roster);
    if (ctx.transcript) parts.push("【上课记录】\n" + ctx.transcript);
    // 20260913：不再让全体共用"当前选中角色"的称呼（那会与各角色人设里写死的称呼互相打架，
    // 详见 app.js 里 roster 的说明）。改为：每位老师按自己人设里的称呼叫学员。
    parts.push("当前老师是：「" + ctx.roleName + "」——群聊里代表他/她发言，用他/她自己的人设与语气。" +
      "其他老师插话时也各自按上述人设里的称呼来叫学员，【不要】统一改成同一个称呼。" +
      "（若某人设没写称呼，用「同学」这类中性说法。）");
  } else if (mode === "review") {
    parts.push(APP_CONFIG.reviewRules);
    parts.push(APP_CONFIG.studyTechniquesRules);
    if (role.persona) parts.push("【你的角色人设】\n" + role.persona);
    if (role.voice) parts.push("【你的说话语气与表达方式】\n" + role.voice);
    parts.push(APP_CONFIG.emoteRules);
    parts.push(APP_CONFIG.knowledgeRules);
    if (ctx.reviewBlock) parts.push(ctx.reviewBlock);
    if (ctx.topic) parts.push("【学习主题】" + ctx.topic);
  } else if (mode === "lessonStart") {
    parts.push(APP_CONFIG.lessonStartRules);
    parts.push(APP_CONFIG.socraticRules);
    parts.push(APP_CONFIG.inferenceJudgmentRules);
    parts.push(APP_CONFIG.familiarityRules);
    parts.push(APP_CONFIG.studyTechniquesRules);
    parts.push(APP_CONFIG.codePracticeRules);
    if (role.persona) parts.push("【你的角色人设】\n" + role.persona);
    if (role.voice) parts.push("【你的说话语气与表达方式】\n" + role.voice);
    parts.push(APP_CONFIG.emoteRules);
    parts.push(APP_CONFIG.knowledgeRules);
    if (ctx.book && ctx.book.outline) {
      const od = ctx.book.outline;
      parts.push("【本教材课程大纲（框架性概览，用于定位当前课时）】\n" + outlineForLessonStart(od));
      const outlineWithinBudget = estimateTokens(JSON.stringify(od, null, 0)) <= APP_CONFIG.limits.outlineSendBudgetTok;
      if (od.globalDerivation && outlineWithinBudget) parts.push("【全书推导脉络（点明本课在全书逻辑链中的位置，不要大段复述）】\n" + od.globalDerivation);
      if (od.teachingRoute && outlineWithinBudget) parts.push("【全书教学路线】\n" + od.teachingRoute);
    }
    if (ctx.topic) parts.push("【学习主题】" + ctx.topic);
  } else {
    // chat：规则 + 主题 + 教材切片（整节课稳定）+ persona/voice/emote/knowledge
    parts.push(APP_CONFIG.socraticRules);
    parts.push(APP_CONFIG.inferenceJudgmentRules);
    parts.push(APP_CONFIG.familiarityRules);
    parts.push(APP_CONFIG.studyTechniquesRules);
    parts.push(APP_CONFIG.codePracticeRules);
    if (ctx.topic) parts.push("【本次学习主题】" + ctx.topic);
    if (ctx.lessonId) {
      const loc = findLessonById(ctx.book, ctx.lessonId);
      const lessonSlice = loc ? sliceMaterialForLesson(loc.lesson, ctx.book) : "";
      if (lessonSlice) {
        parts.push("【本次学习指定的知识来源（本课教材切片，仅可依据此资料引导学生）】\n<<<<<<\n" + lessonSlice + "\n>>>>>>" +
          "\n\n【重要】学习者未读过整本书，本课之外的概念/术语若要用到，请先用大白话铺垫再使用，严禁默认他已读。");
      } else {
        parts.push("【知识来源】请基于本课时的教材内容引导学生。如需补充资料外的常识，请先说明「这部分资料里没有」再补充。");
      }
      const lp = loc && loc.lesson;
      if (lp) {
        let blk = "【本课应覆盖的知识点（每轮提醒，请勿漏讲）】\n";
        blk += "- 核心目标（focus）：" + (lp.focus || "（无）") + "\n";
        blk += "- 关键知识点（keyPoints）：" + ((lp.keyPoints && lp.keyPoints.length) ? lp.keyPoints.join("、") : "（无）") + "\n";
        if (lp.logicFlow) blk += "- 本课论证脉络（logicFlow）：" + lp.logicFlow + "\n";
        if (ctx.book && ctx.book.outline && ctx.book.outline.globalDerivation) blk += "- 全书推导脉络（本课在其中的位置）：" + ctx.book.outline.globalDerivation + "\n";
        blk += "请在引导中逐步覆盖上述知识点；若某些点已通过前面的对话讲透，可自然带过，但不要在未覆盖的情况下跳过。";
        parts.push(blk);
      }
    } else if (ctx.material) {
      const MAX = APP_CONFIG.limits.lessonSliceChars;
      const truncated = ctx.material.length > MAX
        ? ctx.material.slice(0, MAX) + "\n\n（…材料较长，此处仅展示前 " + MAX + " 字。建议生成大纲后按课时学习，老师会在每节课聚焦对应片段。）"
        : ctx.material;
      parts.push("【本次学习指定的知识来源（仅可依据此资料引导学生）】\n<<<<<<\n" + truncated + "\n>>>>>>");
    } else {
      parts.push("【知识来源】本次未提供资料。请基于公认可靠的知识引导；若涉及需引用资料的内容，请说明你目前没有指定资料。");
    }
    if (role.persona) parts.push("【你的角色人设】\n" + role.persona);
    if (role.voice) parts.push("【你的说话语气与表达方式】\n" + role.voice);
    parts.push(APP_CONFIG.emoteRules);
    parts.push(APP_CONFIG.knowledgeRules);
    // personalizedRules 是静态规则，放进静态段（msgs[0]）以扩大缓存前缀覆盖
    parts.push(APP_CONFIG.personalizedRules);
  }

  appendFinalInstruction(mode, ctx, parts);
  return parts.join("\n\n");
}

// 动态段：每轮可能变化（熟悉度 / 番茄提示 / 记忆 / 画像 / 续学 / 复习），放第二条 system。
export function buildDynamicSystem(mode, ctx) {
  const dyn = [];
  if ( mode === "lessonStart") {
    if (ctx.familiarity) dyn.push("【学习者熟悉程度】" + ctx.familiarity);
    if (ctx.memoryBlock) dyn.push(ctx.memoryBlock);
    if (ctx.userProfileBlockStr) dyn.push(ctx.userProfileBlockStr);
    dyn.push(APP_CONFIG.personalizedRules);
  } else if (mode === "chat") {
    if (ctx.familiarity) dyn.push("【当前学习者自报的熟悉程度】" + ctx.familiarity);
    dyn.push(APP_CONFIG.answerQualityRules); // 路线1：让 LLM 每轮顺带自评质量，供 P1 确定性决策
    if (ctx.tomatoHint) dyn.push(ctx.tomatoHint);
    if (ctx.resumeInfo) {
      dyn.push(APP_CONFIG.resumeRules);
      dyn.push("【上次小结（本课中途下课时的学习总结，作为续学断点）】\n" + ctx.resumeInfo.summary);
      if (ctx.wrongBlock) dyn.push(ctx.wrongBlock);
      if (ctx.uncoveredNote) dyn.push("【待补讲的知识点（上次下课自评未覆盖）】" + ctx.uncoveredNote +
        "\n请在续学中优先把这些点讲到、引导到，再视情况推进其他内容。");
    }
    if (ctx.isReviewLesson && ctx.reviewBlock) {
      dyn.push(APP_CONFIG.reviewRules);
      dyn.push(ctx.reviewBlock);
    }
    if (ctx.memoryBlock) dyn.push(ctx.memoryBlock);
    if (ctx.userProfileBlockStr) dyn.push(ctx.userProfileBlockStr);
    if (ctx.policyHintBlock) dyn.push(ctx.policyHintBlock);
  } else if (mode === "review") {
    if (ctx.memoryBlock) dyn.push(ctx.memoryBlock);
    if (ctx.userProfileBlockStr) dyn.push(ctx.userProfileBlockStr);
    dyn.push(APP_CONFIG.personalizedRules);
  } else if (mode === "lessonEnd") {
    // P0：出题聚焦——让随堂测验看到学习者真实薄弱点/误区/错题，测验才有针对性
    if (ctx.memoryBlock) dyn.push(ctx.memoryBlock);
    if (ctx.quizFocusBlock) dyn.push(ctx.quizFocusBlock);
    // 20260913 修复【画像闭环】：lessonEnd 是 AI 课后观察的【唯一写入点】
    // （app.js 的 addAiObservations），而它此前看不到已有画像、也看不到用户的「不准」清单
    // （两者都在 userProfileBlockStr 里，只有 chat/lessonStart/review 注入）。
    // 后果：AI 会反复写刚被否掉的东西——唯一的拦截是 addGlobalEntry 的逐字精确去重，
    // 换个标点、换个说法就绕过去了。写画像的那次调用必须看得见现状，闭环才成立。
    if (ctx.userProfileBlockStr) dyn.push(ctx.userProfileBlockStr);
  } else if (mode === "group") {
    // 20260913 修复：群聊复盘此前动态段为空（原注释还把它当"设计如此"）——
    // 于是【最该懂这个学生的场景恰好完全失忆】：几位老师讨论"他学得怎么样"时，
    // 手里没有长期记忆、没有薄弱点、没有错题、没有画像，只能看到本次上课记录，
    // 点评必然退化成通用评价。这里补上与 chat 同源的记忆 + 画像。
    if (ctx.memoryBlock) dyn.push(ctx.memoryBlock);
    if (ctx.userProfileBlockStr) dyn.push(ctx.userProfileBlockStr);
  }
  // intro 为一次性调用，动态段为空（其上下文只有资料本身，无学员数据可言）
  return dyn.filter(Boolean).join("\n\n");
}

// 兼容旧调用：返回合并后的单一 system 文本（用于一次性模式 intro/lessonEnd/group）。
export function buildSystemPrompt(mode, ctx) {
  const staticSec = buildStaticSystem(mode, ctx);
  const dynamicSec = buildDynamicSystem(mode, ctx);
  const out = [staticSec];
  if (dynamicSec) out.push(dynamicSec);
  return out.filter(Boolean).join("\n\n");
}

// 供高频 chat 路径使用：只负责【拆分】，不决定放在哪。
// 静态段 → 消息数组开头；动态段 → 由调用方（app.js）按 config.cacheLayout 决定
// 放历史之前（head，兼容模式）还是之后（tail，缓存最优）。
// 具体拼装与边界情况见 js/core.js 的 assembleChatMessages（纯函数，有单测）。
export function buildChatMessages(ctx) {
  const staticSec = buildStaticSystem("chat", ctx);
  const dynamicSec = buildDynamicSystem("chat", ctx);
  return {
    head: staticSec ? [{ role: "system", content: staticSec }] : [],
    tail: dynamicSec ? [{ role: "system", content: dynamicSec }] : [],
    staticSystem: staticSec,
    dynamicSystem: dynamicSec,
  };
}
