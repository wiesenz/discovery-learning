/* =====================================================================
 *  Socratopia v0 · 应用逻辑（一般不用改这里）
 *  想调引导风格/角色，去 config.js。
 *  新增：① 下课生成「知识总结卡 + 随堂测验卡」 ② 群聊复盘 ③ 角色别名
 *        ④ 对话表情/肢体动作描写（*...* 渲染为虚化斜体）⑤ 角色头像上传（按角色存本机）
 *        ⑥ 续学错题直接知识点提醒（不设问）⑦ 因材施教用户画像（跨会话积累/修正）⑧ 群聊复盘按课时隔离
 * ===================================================================== */
// 依赖：config.js 的导出 + roles/*.js 的副作用注册（ESM）。
// vendor/ 与 js/core.js 仍以 classic <script> 加载（全局 pdfjsLib / JSZip / mammoth / SocratopiaCore）。
import { APP_CONFIG } from "./config.js";
import { buildSystemPrompt, buildChatMessages, sliceMaterialForLesson, findLessonById as findLessonInBook } from "./js/prompt.js";
import { decideNextMove, policyHint, extractQualityTag, stripQualityForDisplay, deriveAnswerSignals, computeStuckStreak, computeQuestionOnlyStreak, detectExplicitRequest } from "./js/adaptive.js";
// 图片输入（20260916）：把「粘贴/拖入/选文件」得到的图挂到用户消息上。
// 纯逻辑（该不该挂、缩到多大、怎么拼 content 块、哪些能落盘）全在 js/image-input.js，有单测。
import {
  MAX_IMAGES, IMAGE_MAX_DIM, IMAGE_THUMB_DIM, IMAGE_QUALITY, THUMB_QUALITY, IMAGE_TOKEN_EST,
  isImageType, pickImageFiles, filesFromDataTransfer, shouldAttachFromPaste, fitSize,
  splitByCapacity, isSafeImageDataUrl, displayableUrls,
  toApiMessages, stripImagesForStorage, countImageTokens, humanBytes,
} from "./js/image-input.js";
/* =====================================================================
 * 角色 seed（示例 / 占位）——「角色不内置」的设计：
 * 角色是独立文件（roles/*.js），每个文件只负责 registerRole({...})，
 * 与授课核心逻辑（config.js 的 socraticRules 等）零耦合，可随意删增替换。
 *
 * 删除 / 替换某个角色（两步）：
 *   1. 删掉 roles/ 下对应的 .js 文件；
 *   2. 删掉下面一行 import。
 * 新增角色：复制任一文件改一改，再补一行 import 即可。
 *
 * 下面两个是【版权角色】示例（三月七 / 星见雅，均出自米哈游作品），
 * 商用前请删除并换成原创角色，或直接留空——让客户用设置面板里的
 * 「＋ 新建角色」自行定制（运行时生效，不经过这里）。
 * ===================================================================== */
import "./roles/sanbingqi.js"; // 示例角色：三月七（版权角色，商用前删除 / 替换）
import "./roles/xingjianya.js"; // 示例角色：星见雅（版权角色，商用前删除 / 替换）
// 大纲纯函数（20260821.3 拆分第一刀）：从 app.js 迁出，见 js/outline.js
import { splitBookIntoChunks, classifyChunkReply, ensureLessonIds, mergePartialsByChapter, indexChapterPositions, needsReindex } from "./js/outline.js";
// 角色编辑表单校验 + 联网提示拼接（20260827 合规化改造后抽出，单测在 js/role-editor.test.mjs）
import { createRoles } from "./js/roles.js";
// 教材文档解析（PDF / EPUB / DOCX，20260902.1 拆出）：零业务依赖，只吃 File 吐字符串
import { extractTextFromFile, extractPlainTextFile } from "./js/extractors.js";
// 群聊复盘（20260902.1 拆出）：状态收敛在闭包内，宿主能力走 deps 注入
import { createGroupChat } from "./js/group.js";
// 应用状态中心（20260904.1）：教材上下文 + 学习数据 + 本地存储层
import { createStore, safeTopicMap } from "./js/store.js";
// DOM 引用表 / 键名表 / 防抖（20260913 抽出）：纯声明，独立成文件才看得清"HTML ↔ JS 引用"的对照关系
import { LS, debounce, createEls, todayISO, addDays, THINKING_TICK_MS, nextThinkingPhase } from "./js/dom.js";
// 随堂测验答题浮层（20260906.1 拆出）：状态收敛在闭包内，宿主能力走 deps 注入
import { createQuiz } from "./js/quiz.js";
// 学习画像 UI 层（20260906.1 拆出）：数据层在 js/profile.js，本模块只管视图与交互状态
import { createProfileUI } from "./js/profile-ui.js";
// 查看原文浮层（20260910.1 拆出）：状态收敛在闭包内，宿主能力走 deps 注入
import { createSourceViewer } from "./js/source-viewer.js";
// 接口传输层（20260912.1 拆出）：超时/降级重试/取消语义都在这里，配套 js/api.test.mjs
import { createApi } from "./js/api.js";
// 注：画像 UI 层（渲染 / 合并 / AI 重新梳理）已于 20260906.1 迁至 js/profile-ui.js，
// 由它直接 import 本模块；宿主这里只保留真正会用到的数据接口。
import {
  composeProfileBlock,
  addGlobalEntry,
  addAiObservations,
  loadGlobalProfile,
  extractRememberText,
  getDemotedContents,
} from "./js/profile.js";

(function () {
  "use strict";

  // localStorage 键名表 / DOM 元素引用表 / 防抖 都在 js/dom.js（20260913 抽出）：
  // 那部分是纯声明（id → 元素的映射），放在 4000 行的单体里既占预算又无助于可读性。
  // 教材级数据键不在这里——那些由 bookKey 派生，见 js/store.js 的 bookLS()。
  const els = createEls();
  const chips = Array.from(document.querySelectorAll(".chip"));

  // 纯函数工具：定义在 js/core.js（全局 SocratopiaCore），抽出来便于单元测试与复用。
  // 这里用解构别名，保持下方调用处写法不变。
  const { estimateTokens, truncateMaterialInPrompt, parseLessonJson, parseOutlineJson, parseRoleJson, friendlyApiError, reanchorLessonsByContent, normalizeKpToLesson, emaQuizScore, fusedMasteryScore, ensureQuizAnswers, escapeHtml, maxTokensFallbackChain, extractMaxTokensCap, apiTimeoutMs, buildHighlightSegments, findTextMatches, assembleChatMessages } = SocratopiaCore;

  const state = { familiarity: "", bookQuery: "", chatQuery: "", intro: false };
  let isBusy = false; // 全局忙碌标志（发送/生成中），防止操作菜单并发触发
  let messages = [];      // {role:'user'|'assistant'|'system', content, card?}
  // 群聊状态（groupMessages / groupReviewedKey / groupLessonId / genToken）已于 20260902.1
  // 迁入 js/group.js 的 createGroupChat 闭包，宿主统一经 group.* 接口访问。
  // （groupReviewedLessonId 于 20260913 改为复合键 groupReviewedKey：课时 id 跨书重名。）
  // ---- 教材上下文 + 学习数据 ----
  // 20260904.1 收敛进 js/store.js 的单一 state 容器：此前它们是散落的模块级 let，
  // currentBook 被 128 处直读、library 37 处——域与域之间没有边界，改一处牵全身。
  // 统一经 S.xxx 访问；js/contract.test.mjs [3] 会拦住写回裸 currentBook 的新代码。
  const store = createStore();
  const S = store.state;
  const bookLS = store.bookLS; // 保留原调用写法，27 处引用不必改

  // ---- 接口传输层实例（20260912.1 拆出 js/api.js）----
  // ---- 本次会话用量账本（token / 缓存命中 / 估算费用）----
  // 只存在内存里，刷新即清零 ——「本次会话」要名副其实，不写 localStorage、不进导出备份。
  // 数据来源统一为 js/api.js 的 logCacheUsage（stream / 非 stream、所有请求路径共用那个出口），
  // 所以这里不需要在每个调用点挂回调，也不会漏掉大纲 / 群聊这类旁路请求。
  const usageStats = { calls: 0, prompt: 0, hit: 0, completion: 0 };

  function accumulateUsage(u) {
    if (!u) return;
    usageStats.calls += 1;
    const pt = Number(u.prompt_tokens) || 0;
    // 三家字段名不同，与 js/api.js 的 logCacheUsage 保持同一套优先级，避免两处口径漂移
    const hit = (u.prompt_cache_hit_tokens != null) ? Number(u.prompt_cache_hit_tokens)
      : ((u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens != null)
        ? Number(u.prompt_tokens_details.cached_tokens)
        : (u.cached_tokens != null ? Number(u.cached_tokens) : 0));
    usageStats.prompt += pt;
    usageStats.hit += Math.min(hit || 0, pt || (hit || 0)); // 脏数据保护：命中量不该超过输入量
    usageStats.completion += Number(u.completion_tokens) || 0;
    renderUsageStats();
  }

  function fmtToken(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n || 0));
  }

  function renderUsageStats() {
    if (!els.usageStats) return;
    if (!usageStats.calls) { els.usageStats.textContent = "本次会话还没有请求。"; return; }
    const pct = usageStats.prompt ? Math.round((usageStats.hit / usageStats.prompt) * 100) : 0;
    let s = usageStats.calls + " 次请求 · 输入 " + fmtToken(usageStats.prompt) + " token"
      + "（缓存命中 " + fmtToken(usageStats.hit) + "，" + pct + "%）"
      + " · 输出 " + fmtToken(usageStats.completion) + " token";
    // 金额只在 config.pricing 填了单价时才算 —— 价格随服务商调整，代码里不内置任何单价
    const p = APP_CONFIG.pricing || {};
    const miss = Math.max(0, usageStats.prompt - usageStats.hit);
    const cost = (miss * (Number(p.inputMiss) || 0) + usageStats.hit * (Number(p.inputHit) || 0)
      + usageStats.completion * (Number(p.output) || 0)) / 1e6;
    if (cost > 0) s += " · 约 ¥" + cost.toFixed(cost < 0.01 ? 4 : 2);
    els.usageStats.textContent = s;
  }

  // ⚠️ 必须放在 createRoles 之前：createRoles 要注入 callAPIWith，而 const 有 TDZ，
  // 放在后面会在角色装配时直接抛 "Cannot access 'api' before initialization"。
  // toast 是函数声明（提升），这里只传引用、不调用，安全。
  const api = createApi({
    els: {
      apiBase: els.apiBase, apiKey: els.apiKey, apiModel: els.apiModel,
      apiTemp: els.apiTemp, stopBtn: els.stopBtn, testConn: els.testConn,
    },
    config: APP_CONFIG,
    toast,
    maxTokensFallbackChain,
    extractMaxTokensCap,
    apiTimeoutMs,
    onUsage: accumulateUsage,
  });

  // ---- 角色域实例（20260906.1 拆出 js/roles.js）----
  // 角色注册表（ROLES / customRoles）的所有权一并移交给该模块：宿主只读不写。
  const roles = createRoles({
    els: {
      // roleNew 不再传：js/roles.js 解构了 els 却从不读它，而"＋ 新建角色"的点击绑定
      // 在宿主自己身上（见本文件后面的 els.roleNew.addEventListener）。少一个误导性的 deps 键。
      roleSelect: els.roleSelect, roleEdit: els.roleEdit, roleDel: els.roleDel,
      roleAutoFill: els.roleAutoFill, apiKey: els.apiKey,
      roleEditModal: els.roleEditModal, roleEditTitle: els.roleEditTitle, roleEditSub: els.roleEditSub,
      roleEditName: els.roleEditName, roleEditSeries: els.roleEditSeries,
      roleEditAlias: els.roleEditAlias, roleEditOpening: els.roleEditOpening,
      roleEditPersona: els.roleEditPersona, roleEditVoice: els.roleEditVoice,
      roleEditThinking: els.roleEditThinking, roleGenToggle: els.roleGenToggle,
      roleGenDetails: els.roleGenDetails,
    },
    LS,
    toast,
    setBusy,
    isBusy: () => isBusy, // 宿主里是 let，必须传 getter，否则捕获的是永久 false 的快照
    parseRoleJson,
    friendlyApiError,
    callAPIWith: api.call,
    getAvatar,
    saveSettings,
    updateAvatarPreview,
    lsSet, // 20260913：让角色域也用统一写入入口（此前它自己 try/catch 空吞，配额满时静默丢角色）
    // ⚠️ 这里与 group 构成一条【双向依赖】，两条都在本文件里由宿主中介：
    //    此处 roles → group（角色改了要重绘群聊气泡）；另有 group → roles
    //    （见 createGroupChat 的 userAlias: () => roles.userAlias()）。
    //    模块加载层没有环（没有任何插件 import 另一个插件），但逻辑层是真环——
    //    改任一侧的初始化时机都可能踩空。
    // ⚠️ 且这里引用的 `group` 是 const，声明在【本行之后约 3000 行】。当前不会爆，
    //    唯一原因是 onRolesChanged 只在 js/roles.js 的 saveRole/deleteRole 里调用，
    //    而那两条都是用户点击触发的，必然晚于脚本执行完。（对照：api→roles 那条同性质的
    //    顺序约束在上方有显式注释，这条此前没有。）
    //    若将来有人在 loadRoles/initRoles 里补一句 onRolesChanged()，会立刻抛
    //    "Cannot access 'group' before initialization"。
    onRolesChanged: () => { renderMessages(); group.renderGroupMessages(); },
  });

  // 「番茄思维量」追踪：按深度交互轮次（而非时长）累计本节课的认知负荷。
  // 每约 POMODORO_TOMATO_EXCHANGES 轮 ≈ 一个番茄（约 25 分钟专注思考的思维量）。
  let lessonExchangeCount = 0;        // 本节课（本次会话）已完成的深度交互轮次
  let lastTomatoPrompted = 0;         // 已触发过休息提示的「番茄序号」，避免每条消息都提示
  const POMODORO_TOMATO_EXCHANGES = 6; // 每 6 轮深度问答 ≈ 一个番茄
  // 控制器与 finish_reason 已随传输层迁入 js/api.js（经 api.abort(slot) /
  // api.finishReason() 访问）；契约测试 [5] 会拦住把它们写回 app.js 的改动。

  // 启动时清理残留的 in_progress 状态（防止多节课同时显示"进行中"）。
  // 带 interrupted 标记（上次直接关掉了窗口/标签页、没点下课）且确有学习内容的，
  // 转成 ended+paused → 下次进入该课时会出现「继续学习」续学卡，进度不丢。
  function cleanupStaleProgress() {
    try {
      const prog = loadLessonProg();
      let changed = false;
      for (const lid in prog) {
        const entry = prog[lid];
        if (!entry || entry.status !== "in_progress") continue;
        if (entry.interrupted) {
          const chat = loadLessonChat(lid);
          // 与下课分级口径一致：用户侧累计至少 minSubstanceChars 字才算有实质学习 → 转续学态；
          // 只是开场就关了、无实质学习 → 回退未开始（不留「继续学习」误导）
          const userChars = (chat || []).filter((m) => m.role === "user").reduce((s, m) => s + (m.content || "").trim().length, 0);
          const depth = APP_CONFIG.lessonDepth || { minSubstanceChars: 30 };
          if (userChars >= depth.minSubstanceChars) {
            entry.status = "ended";
            entry.paused = true;
            // 保留 interrupted 标记：续学卡据此显示「意外中断」文案；正常下课时会清掉
          } else {
            entry.status = "not_started";
            delete entry.paused;
            delete entry.summary;
            delete entry.interrupted;
            delete entry.interruptedAt;
          }
        } else {
          entry.status = "not_started"; // 无中断标记的残留（历史遗留/异常退出）：回退未开始
          delete entry.interrupted;
          delete entry.interruptedAt;
        }
        changed = true;
      }
      if (changed) saveLessonProg(prog);
    } catch (e) {}
  }

  // 构造 prompt.js 所需的 ctx：把 app.js 闭包里的运行时状态与 localStorage 派生片段，
  // 以「数据」形式注入了 prompt 模块（prompt.js 本身不读 DOM / localStorage），便于测试与缓存。
  /**
   * @param {string} mode
   * @param {object} [opts] opts.transcript —— 群聊复盘专用：本节课真实上课记录文本。
   *   由群聊模块经 getLessonTranscript 依赖取好后传入，本函数不自行读取课时状态，
   *   以维持「插件不直读宿主状态」的边界。
   */
  function buildPromptCtx(mode, opts) {
    const roleName = els.roleSelect.value;
    const role = roles.currentRole();
    const book = S.currentBook;
    const lessonId = S.currentLessonId;
    const topic = (book && book.title) || "";
    const familiarity = state.familiarity;
    // topics 里查不到该主题时 mem 兜底成 {}，此时 mastered/weak/misconceptions 全是 undefined，
    // 直接读 .length 会抛空指针。20260904 修复：改为先取默认值再判长度。
    // （此崩溃发生在启动流程里，会被 roles.loadRoles().then(...).catch 吞掉并误报成
    //  「⚠️ 角色加载失败」，同时跳过 renderStorageUsage / updateAvatarPreview，
    //   表现为每次进页面都弹假报错、存储用量永远卡在「计算中…」。）
    const mem = S.memory.topics[currentTopicKey()] || {};
    // memMis 走 activeMisconceptions：已被测验证明掌握的误区不再注入（否则老师每轮重挖旧坑）
    const memM = mem.mastered || [], memW = mem.weak || [], memMis = activeMisconceptions(mem);
    let roster = "";
    if (mode === "group") {
      roster = "【参与群聊的老师人设】\n";
      const registry = roles.getRegistry();
      Object.keys(registry).forEach((n) => {
        const r = registry[n] || {};
        // 20260913：带上【每位老师自己的称呼】。此前 roster 只有 persona+voice，而称呼
        // 统一用"当前选中角色"的 alias（见 js/prompt.js 的 group 静态段）——于是多角色同场时
        // 必然打架：三月七的人设里写死"你称呼用户为「开拓者」"，而群聊指令说"用户称呼为「同道」"，
        // 三月七怎么叫都错。现在每位老师按自己人设里的称呼叫。
        roster += "■ " + n + "（" + (r.series || "自定义") + "）：\n" + (r.persona || "") +
          (r.voice ? "\n【说话语气】" + r.voice : "") +
          "\n【你对学员的称呼】" + (r.userAlias || "（人设里未指定，用「同学」这类中性称呼）") + "\n\n";
      });
    }
    let memoryBlock = "";
    // 20260913：把 group 纳入（群聊复盘此前完全拿不到长期记忆与画像，
    // 见 js/prompt.js 的 buildDynamicSystem 说明）
    if (mode === "chat" || mode === "lessonStart" || mode === "review" || mode === "lessonEnd" || mode === "group") {
      if (memM.length || memW.length || memMis.length) {
        let blk = "【学员长期记忆（关于本主题的跨会话记录，请据此个性化引导）】\n";
        if (memM.length) blk += "- 已掌握：" + memM.join("、") + "\n";
        if (memW.length) blk += "- 易错/未掌握：" + memW.join("、") + "\n";
        if (memMis.length) blk += "- 历史误区：" + memMis.join("、") + "\n";
        blk += "请跳过已掌握内容，重点照顾易错点与误区，循序渐进。";
        if (mem.nextReview && todayISO() >= mem.nextReview) {
          blk += "\n- 【间隔复习提醒】本主题上次学于 " + (mem.lastStudied || "?") + "，按计划今天起应复习。请优先用「主动回忆 + 一个新情境应用」帮学习者巩固，再视情况推进新课。";
          blk += reviewExtras();
        }
        memoryBlock = blk;
      }
    }
    const userProfileBlockStr = userProfileBlock();
    const tomatoHint = pomodoroRhythmHint();
    const resumeInfo = resumeContinuationInfo(lessonId);
    const wrongBlock = (mode === "chat") ? wrongQuizReminderBlock(lessonId) : "";
    // P0：出题聚焦块——让 lessonEnd（出测验题的模式）能看到学习者真实薄弱点/误区/错题
    const quizFocus = (mode === "lessonEnd") ? quizFocusBlock() : "";
    // P1：确定性教学策略——把「下一步怎么教」从 LLM 散文推断搬进可测纯函数。
    // 仅 chat 高频路径注入；proceed（无特殊信号）不注入，保持默认行为。
    // 20260913：五个输入信号现在全部接真实值（此前 consecutiveStuck 的判据在 app.js 里
    // 无测试覆盖，且把"答得短"误当"卡住"；mastery/kpEvidence 至今仍是死参数，见 js/adaptive.js）。
    let policyHintBlock = "";
    if (mode === "chat") {
      const m2 = S.memory.topics[currentTopicKey()] || {};
      // 路线1：用真实作答质量信号（从对话历史里 assistant 消息携带的 quality 派生）驱动 P1 决策
      const hist = apiHist();
      const ans = deriveAnswerSignals(hist);
      const decision = decideNextMove({
        misconceptions: activeMisconceptions(m2),
        consecutiveStuck: computeStuckStreak(hist),
        questionOnlyStreak: computeQuestionOnlyStreak(hist),
        // 学生明示"直接告诉我"：看最后一条用户消息（它是本轮要回应的那句话）
        explicitRequest: detectExplicitRequest(lastUserText(hist)),
        lastAnswerKind: ans.lastAnswerKind,
        familiarity: state.familiarity,
        justCorrected: ans.justCorrected,
        // 注：kpEvidence 省略→默认视为「有依据」，避免每轮都逼前测（diagnose 因此不可达，
        //     属已知取舍；前测改由 config.js 的散文规则兜）。mastery 参数在 adaptive.js 里从未被读取。
      });
      const ph = policyHint(decision);
      // 措辞注意：策略可能是 summarize（小结）或 reveal（直接讲），**不一定是提问**。
      // 旧措辞写死"请据此组织本轮提问"，会在策略要求"这一轮不要再提问"时和它打架。
      if (ph) policyHintBlock = "【本轮教学策略建议（系统依据学习档案确定性生成；LLM 仅负责把策略渲染为人话）】\n" + ph;
    }
    let uncoveredNote = "";
    if (resumeInfo) {
      const covProg = loadLessonProg()[lessonId];
      if (covProg && covProg.coverage && covProg.coverage.uncovered && covProg.coverage.uncovered.length) {
        uncoveredNote = covProg.coverage.uncovered.join("、");
      }
    }
    const isReviewLesson = (mode === "chat" && S.currentLessonId === "__review__");
    const reviewBlock = (mode === "review" || isReviewLesson) ? reviewMaterialBlock() : "";
    const material = (book && book.material || "").trim();
    return {
      mode, roleName, role, book, lessonId, topic, familiarity, material, userAlias: roles.userAlias(),
      tomatoHint, resumeInfo, wrongBlock, uncoveredNote, reviewBlock, isReviewLesson, memoryBlock, userProfileBlockStr, roster,
      quizFocusBlock: quizFocus, policyHintBlock,
      transcript: (opts && opts.transcript) || "",
    };
  }
  // 最后一条用户消息原文（本轮要回应的那句话）。buildPromptCtx 在新用户消息 push 之后
  // 才构建，所以末尾通常就是它；找不到则返回空串。
  function lastUserText(hist) {
    const h = hist || [];
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i] && h[i].role === "user") return h[i].content || "";
    }
    return "";
  }
  // 注：「连续卡住轮数」「只问不教轮数」「学生是否明示要答案」三个派生函数
  // 已于 20260913 迁到 js/adaptive.js，以便随 decideNextMove 一起被单测覆盖
  // （此前它们住在 app.js，是全链路唯一没有安全网的接缝——正是"短消息被误判成卡住"
  //   能长期存活的原因）。

  // ---- 教材库 ----
  function genId() { return "bk_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7); }
  function loadLibrary() {
    try { S.library = JSON.parse(localStorage.getItem(LS.library)) || []; } catch (e) { S.library = []; }
    if (!Array.isArray(S.library)) S.library = [];
    // 存量修复：为已保存但缺 lesson.id 的旧大纲补全 id（幂等，仅补缺失）
    let fixed = false;
    S.library.forEach((bk) => {
      if (bk && bk.outline) {
        const before = JSON.stringify(bk.outline);
        ensureLessonIds(bk.outline);
        if (JSON.stringify(bk.outline) !== before) fixed = true;
      }
    });
    if (fixed) saveLibrary();
  }
  // ---- localStorage 写入统一入口 ----
  // 2026-09-13：此前所有写入都是 try { setItem } catch (e) {} —— 空 catch 把配额满
  // （QuotaExceededError）也一并吞了。后果是"写入失败但界面报成功"：上传的教材、
  // 生成的大纲、下课的记忆全部没落盘，刷新即回到旧版本甚至整门课消失，而用户全程
  // 只看到「已保存 / 大纲已生成」。教材库把所有书的原文装在同一个键里，几本书就能
  // 触到 5MB 上限，这条路径并不罕见。
  // 现在统一走这里：失败必须让用户知道，并给出可行动的出路（导出备份后清理）。
  // 提示只报一次（storageWarned），避免连续写入时刷屏；一旦有写入成功即复位。
  let storageWarned = false;
  function lsSet(key, value, what) {
    try {
      localStorage.setItem(key, value);
      storageWarned = false;
      return true;
    } catch (e) {
      const full = !!e && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.code === 22 || e.code === 1014);
      if (!storageWarned) {
        storageWarned = true;
        toast(full
          ? "⚠️ 本机存储已满，" + (what || "这次的改动") + "没能保存。请点「⚙️ 设置 → 导出配置」先做备份，再删掉不用的课程，或清理浏览器数据后重试。"
          : "⚠️ " + (what || "这次的改动") + "保存失败（" + ((e && e.name) || "未知错误") + "）。建议先在「⚙️ 设置」里导出配置备份。",
          6000);
        try { renderStorageUsage(); } catch (e2) { /* 用量面板刷新失败不阻断主流程 */ }
      }
      return false;
    }
  }
  function saveLibrary() { lsSet(LS.library, JSON.stringify(S.library), "教材库"); }
  function getCurrentBook() {
    const id = localStorage.getItem(LS.currentBook);
    return S.library.find((b) => b.id === id) || S.library[0] || null;
  }
  function selectBook(id) {
    saveChat(); // 切换前先把当前课程的聊天落盘，确保各课程聊天互不串
    S.currentBook = S.library.find((b) => b.id === id) || null;
    S.currentLessonId = null; // 切换教材时重置课时
    state.intro = false; // 切换教材时退出导读态（重新进入需点“生成开场导读”）
    S.selectedLessonId = null; // 切换教材时重置选中的课时
    state.bookQuery = ""; // 切换教材时清空课程搜索过滤，避免残留过滤继续隐藏列表
    if (els.bookSearch) els.bookSearch.value = "";
    if (S.currentBook) {
      // 走 lsSet：此前这里是裸 setItem，配额满时异常会从 selectBook 冒出去，
      // 表现为「点侧栏课程毫无反应且不报错」。记不住"上次选的是哪本"无伤大雅，
      // 但绝不能因此中断切换课程。
      lsSet(LS.currentBook, S.currentBook.id, "当前课程标记");
      expandedCourses.add(S.currentBook.id); // 选中时自动展开
    }
    // 切换教材：载入该教材的聊天/群聊/记忆，刷新 UI
    loadBookScoped();
    renderBookList();
    loadBookMemory();
    renderMemoryPanel();
    // 恢复该教材上次自报的熟悉程度（按教材隔离）；无记录则保持当前选择
    const fam = S.memory.topics[currentTopicKey()] && S.memory.topics[currentTopicKey()].familiarity;
    if (fam) { state.familiarity = fam; markChip(fam); }
    loadBookCollection();
    renderCollectionPanel();
    if (!S.currentBook) {
      els.messages.innerHTML = '<div class="msg system">还没有课程。点左侧「＋ 新增课程」开始吧。</div>';
      els.groupMessages.innerHTML = "";
    } else {
      // 20260913 修：这里此前【不重绘消息区】—— loadBookScoped() 已经把 messages 换成新书的
      // 数组，而 DOM 里还留着上一门课的气泡。.chat-locked 只对输入框与熟悉度按钮设了
      // pointer-events:none，气泡上的操作按钮（☆ 收入卷宗 / 🔄 重新生成 / 💬 引用追问）仍可点，
      // 于是会按【旧下标】作用到【新书】的数据上 —— 例如把"id 属于 A、正文属于 B"的卡片写进收藏。
      // 一行修：让 DOM 与数据同源。
      renderMessages();
    }
    updateContextMeter();
    applyLessonUIMode(); // 切换教材后回到“未上课”态：禁用输入/发送/下课
  }

  // 学习上锁：同一时刻只能有一门课在「上课」。要切换到其他课程，必须先「📚 下课」。
  // 课时级上锁：当某一节课正在进行中（未下课）时，点任何其他课时都必须先「📚 下课」。
  // 返回拦截提示文案；无障碍返回 null（允许：含"点当前这节课"=无操作 或 "已无活跃课时"）。
  function activeLessonBlockMsg(lid) {
    if (S.activeSessionBookId && lid !== S.currentLessonId) {
      const b = S.library.find((x) => x.id === S.activeSessionBookId);
      const loc = S.currentLessonId ? findLessonById(S.currentLessonId) : null;
      const curName = loc ? loc.lesson.title : "当前课时";
      return "「" + (b ? b.title : "当前课程") + "」的「" + curName + "」还在上课中，请先点「📚 下课」结束本节课，才能开始新的内容。";
    }
    return null;
  }

  // ---- 课时制核心（Lesson-Based Session）----
  // 每节课独立会话、独立上下文、独立进度。解决"全文塞提示词+上下文不重置"问题。

  function lessonProgKey() { return bookLS(S.currentBook.bookKey, "lessonprog"); }
  function loadLessonProg() {
    if (!S.currentBook) return {};
    try { return JSON.parse(localStorage.getItem(lessonProgKey())) || {}; } catch (e) { return {}; }
  }
  function saveLessonProg(prog) {
    if (!S.currentBook) return;
    lsSet(lessonProgKey(), JSON.stringify(prog), "课时进度");
  }
  // 获取某课时的状态
  function getLessonStatus(lid) {
    const prog = loadLessonProg();
    const entry = prog[lid] || {};
    return entry.status || "not_started"; // not_started | in_progress | ended | completed
  }
  // 设置某课时的状态
  function setLessonStatus(lid, status, extra) {
    const prog = loadLessonProg();
    if (!prog[lid]) prog[lid] = {};
    prog[lid].status = status;
    if (extra) Object.assign(prog[lid], extra);
    saveLessonProg(prog);
  }
  // 记录某课时最近一次随堂测验答错的题（供续学后再下课时让老师换新题 + 用新角度重温错题）
  function saveQuizWrong(lid, wrongIdx) {
    if (!lid) return;
    const prog = loadLessonProg();
    if (!prog[lid]) prog[lid] = {};
    prog[lid].quizWrong = wrongIdx || [];
    saveLessonProg(prog);
  }
  // ---- 跨课错题本（书级）：近期错题滚动记录，供间隔复习与复习课跨课复用 ----
  const WRONGBOOK_MAX = 12;
  function loadWrongbook() {
    if (!S.currentBook) return [];
    try { const l = JSON.parse(localStorage.getItem(bookLS(S.currentBook.bookKey, "wrongbook"))); return Array.isArray(l) ? l : []; } catch (e) { return []; }
  }
  function saveWrongbook(list) {
    if (!S.currentBook) return;
    lsSet(bookLS(S.currentBook.bookKey, "wrongbook"), JSON.stringify(list.slice(0, WRONGBOOK_MAX)), "错题本");
  }
  function pushWrongbook(items) {
    if (!Array.isArray(items) || !items.length) return;
    const list = loadWrongbook();
    items.forEach((it) => {
      if (!it || !it.q) return;
      const i = list.findIndex((x) => x.q === it.q);
      if (i >= 0) list.splice(i, 1); // 同题去重：刷新到最前
      list.unshift({ q: it.q, explanation: it.explanation || "", kp: it.kp || "", lid: it.lid || "", date: todayISO() });
    });
    saveWrongbook(list);
  }
  // ---- 知识点级追踪：按知识点短语记掌握状态与测验表现（主题记忆的细粒度补充）----
  // 状态规则：答错 → weak；累计答对数 > 答错数 → mastered（测验是最硬信号）
  function touchKeypointStats(kp, isCorrect) {
    if (!kp) return false;
    const m = S.memory.topics[currentTopicKey()];
    if (!m) return false;
    if (!m.keypointStats) m.keypointStats = {};
    const rec = m.keypointStats[kp] || { status: "weak", lastTested: "", correct: 0, wrong: 0 };
    if (isCorrect) { rec.correct += 1; if (rec.correct > rec.wrong) rec.status = "mastered"; }
    else { rec.wrong += 1; rec.status = "weak"; }
    rec.lastTested = todayISO();
    m.keypointStats[kp] = rec;
    // 写侧消解：测验证明已掌握 → 从 m.weak 文本清单剔除（与 dissolveUncovered 同款保守匹配：精确/包含）。
    // 修复：m.weak 此前只增不减，同一概念在 keypointStats 早已 mastered 却仍被复习反复拉出。
    if (rec.status === "mastered" && Array.isArray(m.weak) && m.weak.length) {
      m.weak = m.weak.filter((w) => {
        const t = (w == null ? "" : String(w)).trim();
        return !(t === kp || t.indexOf(kp) >= 0 || kp.indexOf(t) >= 0);
      });
    }
    return true;
  }
  // P2（事件触发写记忆，≈0 token）：随堂测验答错时，立即把对应误区写入主题记忆，
  // 让后续 chat（P1 decideNextMove 读 misconceptions）与后续测验（P0 quizFocus 读 misconceptions）
  // 当场受益，不必等到下课总结才回写。去重 + 已掌握概念不记误区，避免噪音。
  function recordMisconceptions(texts) {
    if (!Array.isArray(texts) || !texts.length) return;
    const m = S.memory.topics[currentTopicKey()];
    if (!m) return;
    if (!Array.isArray(m.misconceptions)) m.misconceptions = [];
    const nrm = (s) => (s == null ? "" : String(s).trim().toLowerCase());
    const have = new Set(m.misconceptions.map(nrm));
    let changed = false;
    texts.forEach((t) => {
      const s = (t == null ? "" : String(t)).trim();
      if (!s || have.has(nrm(s))) return;
      // 已被测验证明掌握的概念（keypointStats 精确命中），不再记为误区，与写侧消解同逻辑
      const inMastered = Object.keys(m.keypointStats || {}).some((kk) => {
        const st = m.keypointStats[kk];
        return st && st.status === "mastered" && (kk === s || kk.indexOf(s) >= 0 || s.indexOf(kk) >= 0);
      });
      if (inMastered) return;
      m.misconceptions.push(s);
      have.add(nrm(s));
      changed = true;
    });
    if (changed) { saveBookMemory(); renderMemoryPanel(); }
  }
  // 薄弱知识点汇总：keypointStats 的 weak ∪ 主题记忆的 weak（去重）
  // 读侧治愈：m.weak 短语若已被测验证明 mastered（keypointStats 精确命中），不再计入——
  // 存量旧数据不改写一个字也能收敛；新数据由 touchKeypointStats 写侧消解兜底。
  function weakKeypoints() {
    const m = S.memory.topics[currentTopicKey()];
    const stats = (m && m.keypointStats) || {};
    const out = [];
    Object.keys(stats).forEach((k) => { if (stats[k].status === "weak" && out.indexOf(k) < 0) out.push(k); });
    if (m && Array.isArray(m.weak)) m.weak.forEach((k) => {
      const t = (k == null ? "" : String(k)).trim();
      if (!t || out.indexOf(t) >= 0) return;
      // 治愈存量：若该短语已被某【已掌握】的规范知识点涵盖（双向包含匹配，与 dissolveUncovered 同款），则不再计入薄弱清单，
      // 老师的自由文本观察（如“易错：混淆X与Y”）一旦对应概念被测验证明掌握，就会自动收敛。
      const coveredByMastered = Object.keys(stats).some((kk) => {
        const st = stats[kk];
        return st && st.status === "mastered" && (kk.indexOf(t) >= 0 || t.indexOf(kk) >= 0);
      });
      if (!coveredByMastered) out.push(t);
    });
    return out;
  }
  // 有效误区（读侧治愈）：已被随堂测验证明掌握（keypointStats 里 mastered）的误区短语，
  // 不再当作"仍然存在的误区"注入提示词、也不再在履历面板里挂成「误区」。
  // 背景（20260913）：m.misconceptions 是【只增不减】的——全库没有任何删除/治愈路径，
  // 而 m.weak 早就有同款治愈。叠加 decideNextMove 里"命中误区→设计反例"排在很前，
  // 结果是某个主题一旦记下误区，老师会被每一轮命令重挖同一个坑：学生早在测验里答对了、
  // keypointStats 已是 mastered，仍被反复纠正——"为了提问而提问"的机制性来源之一。
  // 尺子与 weakKeypoints 完全一致（双向包含匹配），保持全站同一套口径。
  function activeMisconceptions(m) {
    const list = (m && Array.isArray(m.misconceptions)) ? m.misconceptions : [];
    const stats = (m && m.keypointStats) || {};
    return list.filter((raw) => {
      const t = (raw == null ? "" : String(raw)).trim();
      if (!t) return false;
      const coveredByMastered = Object.keys(stats).some((kk) => {
        const st = stats[kk];
        return st && st.status === "mastered" && (kk.indexOf(t) >= 0 || t.indexOf(kk) >= 0);
      });
      return !coveredByMastered;
    });
  }
  // 手动将课时标记为已完成（用户确认已掌握），并刷新课程树与总结卡按钮
  function markLessonComplete(lid) {
    if (!lid) return;
    const st = getLessonStatus(lid);
    if (st === "completed") return;
    setLessonStatus(lid, "completed", { completedAt: todayISO() });
    renderBookList();
    renderMessages();
    const next = getNextIncompleteLesson();
    toast("已标记为完成，章节进度已更新～" + (next ? "下一节：「" + (next.title || "") + "」" : "🎉 全部课时已完成"));
  }
  // 在大纲中找到某个 lessonId 对应的课时对象（返回 {lesson, chapter, chapterIndex, lessonIndex}）
  // 课时定位的唯一实现已上收至 js/prompt.js（20260913 真正去重）。
  // 这里只是把"当前教材"绑上去，保持 7 个调用点的 findLessonById(lid) 签名不变。
  // 用函数声明而非 const 箭头：函数声明会提升，不引入任何 TDZ 风险。
  // （此前本文件另有一份逐行相同的实现，而 js/prompt.js 的注释却声称"app.js 从本模块导入"——
  //   那条注释是假的，app.js 从未导入过。两边现在都是真的。）
  function findLessonById(lid) { return findLessonInBook(S.currentBook, lid); }
  // 获取所有课时（扁平数组，保持顺序）
  function getAllLessons() {
    if (!S.currentBook || !S.currentBook.outline) return [];
    const out = [];
    (S.currentBook.outline.chapters || []).forEach((ch) => {
      (ch.lessons || []).forEach((ls) => out.push({ ...ls, _chTitle: ch.title }));
    });
    return out;
  }
  // 把一组 keyPoints 数组合并去重（全书候选集用）
  function uniqKp(arrays) {
    const out = [];
    (arrays || []).forEach((arr) => (arr || []).forEach((k) => {
      const s = (k == null ? "" : String(k)).trim();
      if (s && out.indexOf(s) < 0) out.push(s);
    }));
    return out;
  }
  // 聚合各课时"下课自评未覆盖"的关键知识点（去重）：复习课/间隔复习提醒共用
  function collectUncovered() {
    const out = [];
    if (S.currentBook && S.currentBook.outline) {
      const prog = loadLessonProg();
      getAllLessons().forEach((ls) => {
        const cov = (prog[ls.id] || {}).coverage;
        if (cov && Array.isArray(cov.uncovered)) cov.uncovered.forEach((u) => { if (u && out.indexOf(u) < 0) out.push(u); });
      });
    }
    return out;
  }
  // 概念被重新触达（测验无论对错都算"已覆盖"）→ 从各课"历史未覆盖"清单中剔除，
  // 用保守匹配（精确/包含）避免误删不同概念；让复习清单随学习进展收敛，不越攒越陈旧。
  function dissolveUncovered(kp) {
    const s = (kp == null ? "" : String(kp)).trim();
    if (!s || !S.currentBook || !S.currentBook.outline) return;
    const prog = loadLessonProg();
    let changed = false;
    getAllLessons().forEach((ls) => {
      const cov = (prog[ls.id] || {}).coverage;
      if (cov && Array.isArray(cov.uncovered) && cov.uncovered.length) {
        const remain = cov.uncovered.filter((u) => {
          const t = (u == null ? "" : String(u)).trim();
          return !(t === s || t.indexOf(s) >= 0 || s.indexOf(t) >= 0);
        });
        if (remain.length !== cov.uncovered.length) { cov.uncovered = remain; changed = true; }
      }
    });
    if (changed) saveLessonProg(prog);
  }
  // 获取下一节未完成的课时（用于”继续学习/下一节”引导）。
  // 按全书章节顺序返回第一个【未完成】的课（状态非 completed）。
  // 不再单独优先“已下课(ended)”，避免多课处于 ended 时标记后一课完成后“下一节”倒指回第一节。
  function getNextIncompleteLesson() {
    const all = getAllLessons();
    const prog = loadLessonProg();
    for (let i = 0; i < all.length; i++) {
      const s = (prog[all[i].id] || {}).status;
      if (s !== "completed") return all[i];
    }
    return null; // 全部已完成
  }
  // 按课时隔离的聊天记录键
  function lessonChatKey(lid) { return bookLS(S.currentBook.bookKey, "lesson_" + lid); }
  // 清洗消息数组：去掉思考占位（m.thinking）与历史遗留的 thinking-wrap HTML 残留，防止显示成源码/发给模型
  function cleanChatMessages(arr) {
    return (arr || []).filter((m) => {
      if (!m) return false;
      if (m.thinking) return false; // 思考占位：绝不持久化、绝不进上下文
      if (m.role && typeof m.content === "string" && m.content.indexOf("thinking-wrap") >= 0) return false; // 旧数据残留
      return true;
    }).map((m) => {
      // 20260913：给 AI 消息补上「当时是谁在说」（speaker = 角色名）。已有值不覆盖。
      // 背景：transcriptText 原来用【当前下拉框】的角色给整段历史贴说话人，而消息里
      // 根本没存过说话人 —— 于是以三月七上完一节课、切到星见雅再下课/复盘，提示词里的
      // 上课记录会变成「星见雅：诶？这里好像有点不对劲哦～」（三月七的台词挂上星见雅的名字），
      // 群聊复盘据此点评会说出"我刚才讲的那处你没跟上"这类冒名发言。
      // 放在这里是因为它是所有落盘/载入路径的必经点：消息产生后第一次保存就会打上
      // 当时正确的角色，一处覆盖全部，不必在十来处 push 点各写一遍。
      // （存量旧消息没有这个字段，读侧仍回退到当前角色——无法知道当初是谁说的。）
      if (m.role === "assistant" && !m.speaker) m.speaker = els.roleSelect.value;
      // 20260916：图片原图（base64）绝不落盘 —— 这里是所有落盘/载入路径的必经点，
      // 与上面补 speaker 同理，一处收口即可覆盖 saveChat / saveCurrentLessonChat /
      // 课时级键 / 旧版全局键。只留 ~320px 缩略图（几 KB），刷新后历史里还看得见图，
      // 但不会再被发给模型（见 js/image-input.js 的 toApiMessage）。
      return stripImagesForStorage(m);
    });
  }
  function loadLessonChat(lid) {
    if (!S.currentBook) return [];
    try { return cleanChatMessages(JSON.parse(localStorage.getItem(lessonChatKey(lid))) || []); } catch (e) { return []; }
  }
  function saveCurrentLessonChat() {
    if (!S.currentBook || !S.currentLessonId) return;
    lsSet(lessonChatKey(S.currentLessonId), JSON.stringify(cleanChatMessages(messages)), "本课对话记录");
    // 同步轮次到进度数据（用于百分比展示）
    const userTurns = messages.filter((m) => m.role === "user").length;
    const prog = loadLessonProg();
    if (!prog[S.currentLessonId]) prog[S.currentLessonId] = {};
    prog[S.currentLessonId].turns = userTurns;
    saveLessonProg(prog);
  }

  // ---- 切换课时（核心操作）----
  async function startLesson(lid) {
    if (!S.currentBook) return;
    if (lid === S.currentLessonId) return; // 已在这节课
    state.intro = false; // 正式上课：退出导读态
    clearPendingImages(); // 同理：上一节课贴的图不该跟到这一节
    // 课时级上锁：当前有课时在进行中，且点的不是当前这一节 → 必须先下课
    const blockMsg = activeLessonBlockMsg(lid);
    if (blockMsg) { alert(blockMsg); return; }
    // 约束：已有其他课程在上课 → 必须先下课才能开始别的课（课时级锁已覆盖，这里保留书本级兜底）
    if (S.activeSessionBookId && S.activeSessionBookId !== S.currentBook.id) {
      const b = S.library.find((x) => x.id === S.activeSessionBookId);
      alert("「" + (b ? b.title : "当前课程") + "」还在上课中，请先点「📚 下课」结束本节课，再开始其他课程的学习。");
      return;
    }

    // 保存当前课时的聊天（如果有）
    if (S.currentLessonId) saveCurrentLessonChat();
    // 重置旧课时状态：同一时间只能有一节「进行中」；已完成/已下课的不要回退
    if (S.currentLessonId && S.currentLessonId !== lid) {
      const oldSt = getLessonStatus(S.currentLessonId);
      // 切课时绝不静默丢弃进度：把旧课标记为「意外中断」→ 下次回来走「继续学习」，而非重置为未开始
      if (oldSt === "in_progress") setLessonStatus(S.currentLessonId, "ended", { interrupted: true, paused: true, interruptedAt: Date.now() });
    }

    S.currentLessonId = lid;
    S.selectedLessonId = null; // 进入上课模式后清除浏览选中状态
    // 重置番茄思维量追踪（以本节课为单位重新累计）
    lessonExchangeCount = 0;
    lastTomatoPrompted = 0;
    setLessonStatus(lid, "in_progress");
    S.activeSessionBookId = S.currentBook.id; // 标记本门课进入上课状态（同时只能上一门）
    updateStartLessonBtn();

    // 加载目标课时的聊天记录（或新建）
    messages = loadLessonChat(lid);
    // 续学：下课≠学完，休息后再次上课要衔接上次进度。在聊天里放一张「继续学习」衔接卡（仅展示，不进模型上下文）。
    const resumeInfo = resumeContinuationInfo(lid);
    if (resumeInfo && messages.length) {
      messages = messages.filter((m) => !(m.card && m.card.kind === "resume")); // 避免多次续学叠加旧卡
      messages.unshift({
        role: "system",
        card: {
          kind: "resume",
          text: "📚 继续学习：「" + resumeInfo.lessonTitle + "」——上次在这节课" +
            (resumeInfo.interrupted ? "进行中被意外中断，进度已保存" : "中途休息了，这节课还没学完") +
            "。先回想一下上次学到哪，然后从这里接着学，薄弱点老师会重点帮你补上。",
          summary: resumeInfo.summary || "",
        },
      });
      saveCurrentLessonChat();
    }
    if (!messages.length) {
      // 新课时：生成课时开场白
      const loc = findLessonById(lid);
      if (lid === "__review__") {
        // 复习课（虚拟课时）：跨课间隔复习专场，走专用开场生成
        messages.push({ role: "assistant", content: openingText() });
        renderMessages(); saveCurrentLessonChat();
        await generateReviewStart();
      } else if (loc) {
        messages.push({ role: "assistant", content: openingText() });
        renderMessages(); saveCurrentLessonChat();
        await generateLessonStart(loc.lesson);
      } else {
        messages.push({ role: "assistant", content: openingText() });
        renderMessages(); saveCurrentLessonChat();
      }
    } else {
      renderMessages();
    }

    // 更新 UI：刷新进度、重置精力值
    updateContextMeter();
    saveLessonProg(loadLessonProg()); // 触发教材列表进度更新
    renderBookList();
  }

  // ---- 课时开场白（聚焦到具体知识点）----
  async function generateLessonStart(lesson) {
    setBusy(true);
    const thinking = { role: "assistant", content: "（" + els.roleSelect.value + "正在准备本节课的内容…）" };
    messages.push(thinking); renderMessages();
    try {
      // 构建课时专用的系统提示词：包含框架性大纲 + 当前课时的切片材料
      const sys = buildSystemPrompt("lessonStart", buildPromptCtx("lessonStart"));
      const materialSlice = sliceMaterialForLesson(lesson, S.currentBook);
      // —— 章级承上 + 上一课衔接（解决「换章突兀 / 承上落空」）——
      // 只依赖大纲数据（章 bridge + 上一课 title/focus），不依赖可能为空的小结存储。
      let continuity = "";
      const loc = findLessonById(lesson.id);
      if (loc) {
        const ch = loc.chapter, ci = loc.chapterIndex, li = loc.lessonIndex;
        const out = S.currentBook.outline;
        const prev = (li > 0) ? ch.lessons[li - 1]
          : (ci > 0 ? out.chapters[ci - 1].lessons[out.chapters[ci - 1].lessons.length - 1] : null);
        const lines = [];
        if (li === 0 && ch.bridge) {
          lines.push("【章级承上 bridge（本节课是本章第一节课，请用它做章级衔接，不要杜撰上一章内容）】");
          lines.push(ch.bridge);
        }
        if (prev) {
          lines.push("【上一课衔接（用于一句话承上；仅给标题与核心目标，不要扩展细节）】");
          lines.push("标题：" + (prev.title || "（未命名）") + "；核心目标：" + (prev.focus || "（无）"));
          if (getLessonStatus(prev.id) === "ended") lines.push("（该课已完成）");
        }
        if (lines.length) continuity = lines.join("\n") + "\n";
      }
      const infoLines = [
        "【当前课时信息】",
        "标题：" + (lesson.title || ""),
        "核心目标：" + (lesson.focus || ""),
        "关键知识点：" + (lesson.keyPoints ? lesson.keyPoints.join("、") : ""),
        "本课论证脉络：" + (lesson.logicFlow || "（无）"),
      ];
      // 价值锚点：有大纲 whyImportant 才注入（点题时用它点出"学这课值得"）
      if (lesson.whyImportant) infoLines.push("价值锚点（whyImportant，点题时顺带用它点价值，别剧透结论）：" + lesson.whyImportant);
      const parts = [infoLines.join("\n")];
      if (continuity) parts.push(continuity);
      parts.push(materialSlice ? "【本课对应的教材材料】\n<<<<<<\n" + materialSlice + "\n>>>>>>" : "（未提供材料切片，请基于全书内容聚焦本课主题。）");
      parts.push("【重要】学习者未读过整本书，只学了当前课时（及之前课时）。本课之外的概念/术语若要用到，请先用大白话铺垫再使用；只基于本课材料引导。");
      parts.push("请按「课时开始规则」开启这节课。");
      const msgs = [
        { role: "system", content: sys },
        { role: "user", content: parts.join("\n\n") },
      ];
      const reply = await api.call(msgs);
      // 替换掉 thinking 占位符和 openingText
      messages = messages.filter((m) => m !== thinking && m.content !== openingText());
      messages.unshift({ role: "assistant", content: reply || "（模型没返回内容）" });
    } catch (e) {
      messages = messages.filter((m) => m !== thinking);
      messages.unshift({ role: "assistant", content: "⚠️ 本节课准备失败：" + friendlyApiError(e) });
    } finally {
      renderMessages(); saveCurrentLessonChat(); setBusy(false); updateContextMeter();
    }
  }

  // ---- 复习课开场（跨课间隔复习专场：素材为系统历史学习档案，无教材切片）----
  async function generateReviewStart() {
    setBusy(true);
    const thinking = { role: "assistant", content: "（" + els.roleSelect.value + "正在翻看你的学习档案，准备复习内容…）" };
    messages.push(thinking); renderMessages();
    try {
      const sys = buildSystemPrompt("review", buildPromptCtx("review")); // 素材（薄弱点/错题本/记忆）已全部注入系统提示词
      const msgs = [
        { role: "system", content: sys },
        { role: "user", content: "这是一节间隔复习课。请按「复习课规则」开启：先从最薄弱的知识点开始，让学习者主动回忆；回忆不出的直接讲清，再用新情境小应用题检验。" },
      ];
      const reply = await api.call(msgs);
      messages = messages.filter((m) => m !== thinking && m.content !== openingText());
      messages.unshift({ role: "assistant", content: reply || "（模型没返回内容）" });
    } catch (e) {
      messages = messages.filter((m) => m !== thinking);
      messages.unshift({ role: "assistant", content: "⚠️ 复习课准备失败：" + friendlyApiError(e) });
    } finally {
      renderMessages(); saveCurrentLessonChat(); setBusy(false); updateContextMeter();
    }
  }

  // ---- 浏览模式：选中课时后展示预览（不上课）----
  function showLessonPreview(lid) {
    if (!S.currentBook) return;
    if (S.currentLessonId) return; // 上课中禁止预览：绝不清空当前课的聊天（防御，主入口已在 .cc-lesson 点击里拦截）
    const loc = findLessonById(lid);
    if (!loc) return;
    const lesson = loc.lesson;
    // 清空聊天区，展示课时预览卡片
    messages = [];
    const previewCard = {
      role: "system",
      card: {
        kind: "lessonPreview",
        title: lesson.title || "未命名课时",
        chapter: loc.chapter ? loc.chapter.title : "",
        focus: lesson.focus || "",
        keyPoints: lesson.keyPoints || [],
        text: "📖 已选中本节课。点击下方「📚 上课」按钮开始学习，或继续浏览其他章节。",
      }
    };
    messages.push(previewCard);
    renderMessages();
    updateStartLessonBtn();
  }

  // 根据“是否正在上课”统一刷新聊天区与按钮的可用状态：
  //  - 上课中：可输入、可发送、可「下课」、不可「上课」
  //  - 非上课中（浏览 / 已下课）：禁用输入/发送/熟悉度芯片/「下课」，聊天窗口视为“已关闭”
  function applyLessonUIMode() {
    // active：正在上课 或 导读态（生成开场导读后，允许点熟悉度/输入承接导读对话）
    const active = !!S.currentLessonId || !!state.intro;
    const inLesson = !!S.currentLessonId;
    if (els.userInput) els.userInput.disabled = !active;
    if (els.sendBtn) els.sendBtn.disabled = !active;
    chips.forEach((c) => (c.disabled = !active));
    // 「下课」：仅上课中显示；空闲/导读态隐藏（不置灰，避免“两个按钮一起灰”）
    if (els.lessonEnd) {
      els.lessonEnd.style.display = inLesson ? "" : "none";
      els.lessonEnd.disabled = !active;
    }
    if (els.chatSection) els.chatSection.classList.toggle("chat-locked", !active);
    // 「上课」按钮三态：
    //  上课中 → 激活态「📚 上课中」（点击引导去下课）；有选中课时 → 「📚 上课/继续学习」可用；
    //  未选中 → 唯一允许的灰色禁用 + tooltip
    if (els.startLessonBtn) {
      if (inLesson) {
        els.startLessonBtn.classList.add("active");
        els.startLessonBtn.disabled = false;
        els.startLessonBtn.style.opacity = "1";
        els.startLessonBtn.textContent = "📚 上课中";
      } else if (S.selectedLessonId) {
        els.startLessonBtn.classList.remove("active");
        els.startLessonBtn.disabled = false;
        els.startLessonBtn.style.opacity = "1";
        els.startLessonBtn.title = "";
        // 下课≠学完：已下课/已学过的课时再次进入是「继续学习」而非从头开始
        const st = getLessonStatus(S.selectedLessonId);
        els.startLessonBtn.textContent = (st === "ended" || st === "completed") ? "📚 继续学习" : "📚 上课";
      } else {
        els.startLessonBtn.classList.remove("active");
        els.startLessonBtn.disabled = true;
        els.startLessonBtn.style.opacity = "0.5";
        els.startLessonBtn.textContent = "📚 上课";
        els.startLessonBtn.title = "先在左侧选择一节课";
      }
    }
  }
  // 更新「上课」按钮的可用状态（保留旧入口，统一走 applyLessonUIMode）
  function updateStartLessonBtn() { applyLessonUIMode(); }

  // 教材切片逻辑已统一到 js/prompt.js 的 sliceMaterialForLesson（由 app.js 顶部 import 复用），
  // 不再在此重复定义，避免两处 8000 硬编码上限漂移。调用处见 generateLessonStart / 课程树定位。

  // 仅解除“同时只能上一门课”的上课锁（不改变课时完成状态）
  function releaseLessonLock() {
    if (S.activeSessionBookId && S.currentBook && S.activeSessionBookId === S.currentBook.id) {
      S.activeSessionBookId = null;
    }
    S.currentLessonId = null;
  }
  // ---- 结束当前课时（下课，放弃/无实质内容）----
  function endCurrentLesson() {
    if (S.currentLessonId) {
      saveCurrentLessonChat();
      // 放弃 / 无实质内容：回退为未开始（有实质内容的完成态由 generateLessonEnd 处理，不会被冲掉）
      setLessonStatus(S.currentLessonId, "not_started");
    }
    releaseLessonLock();
  }
  function addBook(title, material) {
    const bk = { id: genId(), title: title || "未命名课程", material: material || "", bookKey: genId(), createdAt: todayISO(), outline: null };
    S.library.push(bk);
    saveLibrary();
    selectBook(bk.id);
  }
  function deleteBook(id) {
    const bk = S.library.find((b) => b.id === id);
    if (!bk) return;
    if (!confirm("删除课程「" + bk.title + "」？该课程的资料、聊天记录、记忆、收藏、笔记、错题本、课时进度都会一并清除，无法恢复。")) return;
    // 若删除的是正在上课的课程，解除上课锁
    if (S.activeSessionBookId === id) S.activeSessionBookId = null;
    // 清掉该教材的完整隔离数据（含逐课聊天、错题本、课时进度、笔记），避免 localStorage 残留孤儿键越积越多
    [ "chat", "group", "memory", "collection", "aha", "wrongbook", "lessonprog", "notes" ].forEach((k) => localStorage.removeItem(bookLS(bk.bookKey, k)));
    // 逐课聊天记录键（lesson_<lid>）：按本书大纲的课时 lid 精确清理
    if (bk.outline && bk.outline.chapters) {
      bk.outline.chapters.forEach((ch) => (ch.lessons || []).forEach((ls) => {
        if (ls && ls.id) localStorage.removeItem(bookLS(bk.bookKey, "lesson_" + ls.id));
      }));
    }
    S.library = S.library.filter((b) => b.id !== id);
    saveLibrary();
    if (S.currentBook && S.currentBook.id === id) { localStorage.removeItem(LS.currentBook); S.currentBook = null; }
    selectBook(S.library[0] ? S.library[0].id : null);
    renderStorageUsage();
  }
  // 旧版（全局 material/topic/chat/group/memory/collection）→ 迁移到指定教材
  function migrateLegacyToBook(bk) {
    if (!bk) return;
    [ ["chat", "socratopia_chat_v0"], ["group", "socratopia_group_v0"], ["memory", "socratopia_memory_v0"], ["collection", "socratopia_collection_v0"] ].forEach(([kind, oldKey]) => {
      try {
        const v = localStorage.getItem(oldKey);
        if (v != null) { lsSet(bookLS(bk.bookKey, kind), v, "旧版记录迁移"); localStorage.removeItem(oldKey); }
      } catch (e) {}
    });
    // 2026-09-13：旧版原文键（material/topic）此前【从不清理】，两个后果：
    //   ① 启动门槛是「教材库为空」（见 init 里的 if (!S.library.length)），于是用户把
    //      「从旧版迁移的课程」删掉后一刷新，那门课带着旧资料又回来了 —— 删不掉的课。
    //   ② 教材原文在 localStorage 里存了两份（旧键 + 新库 JSON），直接把 5MB 配额提前撑爆。
    // 清理前提：必须确认新课程【真的落盘了】。否则（比如配额满导致 saveLibrary 失败）
    // 清掉旧键就等于把用户唯一的一份资料删了 —— 宁可下次启动再迁一次，也不能丢数据。
    let persisted = false;
    try {
      const lib = JSON.parse(localStorage.getItem(LS.library));
      persisted = Array.isArray(lib) && lib.some((b) => b && b.id === bk.id);
    } catch (e) { persisted = false; }
    if (persisted) {
      try {
        localStorage.removeItem("socratopia_material_v0");
        localStorage.removeItem("socratopia_topic_v0");
      } catch (e) {}
    }
  }
  function openingText() {
    const r = roles.currentRole();
    return (r.openingLine || APP_CONFIG.openingLine || "").replace(/开拓者/g, roles.userAlias());
  }
  function transcriptText(msgs) {
    const src = msgs || messages; // 可传入指定消息数组（如某课时的聊天记录），缺省用当前 messages
    return src
      .filter((m) => !m.thinking && (m.role === "user" || m.role === "assistant")) // 排除思考占位，防止其 HTML 泄漏进提示词
      // AI 侧优先用消息自带的 speaker（= 当初回复的角色），旧数据没有该字段才回退到当前角色
      .map((m) => (m.role === "user" ? roles.userAlias() : (m.speaker || els.roleSelect.value)) + "：" + (m.content || ""))
      .join("\n");
  }
  // 群聊复盘时，上课记录可能很长。超过 groupTranscriptCapChars 就从最久远的行开始截断，
  // 用省略标记提示，避免群聊请求直接撑爆上下文。最近的内容始终保留。
  function transcriptTextCapped(msgs) {
    const lines = transcriptText(msgs).split("\n");
    const CAP = APP_CONFIG.limits.groupTranscriptCapChars;
    if (lines.join("\n").length <= CAP) return lines.join("\n");
    const kept = [];
    let len = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (len + lines[i].length + 1 > CAP && kept.length > 0) break;
      kept.unshift(lines[i]);
      len += lines[i].length + 1;
    }
    return "（前面部分对话已省略）\n" + kept.join("\n");
  }

  // ---- 富文本渲染 ----
  // 早期版本曾把 *动作* 渲染成括号，实测模型生成的括号内容杂乱，已改为：直接渲染纯文本。
  // 这里统一只做 HTML 转义，不再做任何特殊标记处理。
  function renderRichText(s) {
    const text = String(s == null ? "" : s);
    if (text.indexOf("```") < 0) return escapeHtml(text); // 无代码块，走原路径
    // 把 ``` 围栏代码块渲染成带「一键复制」按钮的代码块；其余文本照常转义
    const parts = text.split("```");
    let html = "";
    for (let i = 0; i < parts.length; i++) {
      html += (i % 2 === 1) ? renderCodeBlock(parts[i]) : escapeHtml(parts[i]);
    }
    return html;
  }
  // 渲染 ``` 围栏内的代码：去掉可选的语言标识行（整行是一个单词才算，避免误删 "def foo():" 这类代码首行）
  const CODE_LANGS = new Set(["js","javascript","ts","typescript","jsx","tsx","py","python","java","c","cpp","c++","cs","c#","go","rust","rb","ruby","php","html","htm","css","scss","sass","less","json","xml","yaml","yml","sh","bash","shell","zsh","sql","md","markdown","kt","kotlin","swift","dart","r","rs","pl","perl","lua","scala","hs","haskell","vb","vim","dockerfile","makefile","toml","ini","cfg","conf","tex","latex","asm","nasm","groovy","clj","clojure","erl","elixir","ex","ps","powershell","bat","gradle","proto"]);
  function renderCodeBlock(block) {
    let body = block;
    const nl = body.indexOf("\n");
    if (nl > 0) {
      const first = body.slice(0, nl).trim().toLowerCase();
      // 仅当首行是已知编程语言标识时才当作语言名删除，避免误删 "def foo():" 这类代码首行或被当作语言的普通单词（如 "result"）
      if (CODE_LANGS.has(first)) body = body.slice(nl + 1);
    }
    body = body.replace(/^\n/, "").replace(/\s+$/, ""); // 去掉围栏自带的首尾空行
    return '<pre class="code-block"><button type="button" class="code-copy" title="复制整段代码">⧉ 复制</button><code>' +
      escapeHtml(body) + "</code></pre>";
  }

  // ---- 角色头像（按角色名存本机 localStorage，dataURL）----
  // 头像白名单：只接受应用自己写入的形态（canvas.toDataURL 产出的 data:image/...;base64,）。
  // 20260913：该值会被拼进 <img src="...">（js/group.js）以及 CSS 的 url("...")
  // （本文件的 --avatar-url），而「导入配置」能把 socratopia_avatar_* 写成任意字符串——
  // 一个带引号的 payload 就能闭合属性并注入事件处理器。这里从源头掐断：
  // 不匹配就当作没上传头像（回退到印章）。放宽格式请同步收紧这两处使用点。
  function getAvatar(roleName) {
    try {
      const v = localStorage.getItem(LS.avatarPrefix + roleName) || "";
      return /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(v) ? v : "";
    } catch (e) { return ""; }
  }
  const AVATAR_PLACEHOLDER = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='80' height='80' fill='%23efe2c8'/><text x='40' y='47' font-size='14' fill='%23996b4f' text-anchor='middle' font-family='sans-serif'>上传</text></svg>"
  );
  function updateAvatarPreview() {
    els.avatarPreview.src = getAvatar(els.roleSelect.value) || AVATAR_PLACEHOLDER;
  }
  // 缩放图片到 maxDim 以内，转成 PNG dataURL，避免 localStorage 爆掉
  function resizeImage(file, maxDim) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/png"));
        };
        img.onerror = () => reject(new Error("图片解码失败"));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error("文件读取失败"));
      reader.readAsDataURL(file);
    });
  }

  /* ===================================================================
   *  图片输入（20260916）—— 让对话框能粘贴截图
   *  ---------------------------------------------------------------
   *  背景：输入框是纯 <textarea>，浏览器本来就不接受往里粘图片，所以此前的
   *  表现是"静默失败"——粘贴毫无反应，也没有任何提示。这一块只补「输入端」；
   *  至于模型收不收图，由 js/image-input.js 的 toApiMessage 与 api 的报错分支处理。
   *
   *  三条设计约束（都来自本项目已经踩过的坑，不是从别处抄的）：
   *   1) content 始终保持【字符串】。历史里只要出现"content 是数组"的消息，
   *      chatMessagesAutoTrim 的 `m.content || ""` join、toHalfWidth、聊天搜索
   *      全会一起坏掉（那种 `[object Object]` 的失灵最难查）。所以图不走 content，
   *      单独挂在 msg.images 上，只在**发请求那一刻**由 toApiMessage 拼成块数组。
   *   2) 原图（full）绝不落盘，只留在内存里。base64 进 localStorage 会吃掉配额
   *      （头像压到 256px 就是为这个，教材库已经够紧张了）。落盘只留 ~320px 缩略图，
   *      所以刷新后历史里还看得见"当时发过什么图"，但那张图不会再被发给模型。
   *   3) 图 URL 进 <img src> 前必须过白名单（isSafeImageDataUrl）——「导入配置」
   *      能把任意字符串写进 localStorage，与 getAvatar 是同一条防线。
   * =================================================================== */

  /** 待发送的图片（仅内存，随发送清空）。[{id, full, thumb, w, h, bytes}] */
  let pendingImages = [];

  /**
   * 用 canvas 把图片缩到 maxDim 以内并编码成 JPEG dataURL。
   * 为什么统一转 JPEG：① 体积可预期（PNG 截图动辄几 MB）② 输出格式恒定，
   * 正好落在 isSafeImageDataUrl 的白名单里（原图可能是 avif/heic 等）。
   * JPEG 没有 alpha 通道，所以先铺一层白底 —— 否则带透明区域的截图会变成黑块。
   */
  function encodeImageDataUrl(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const size = fitSize(img.width, img.height, maxDim);
          const canvas = document.createElement("canvas");
          canvas.width = size.width;
          canvas.height = size.height;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, size.width, size.height);
          ctx.drawImage(img, 0, 0, size.width, size.height);
          const dataUrl = canvas.toDataURL("image/jpeg", quality);
          if (!isSafeImageDataUrl(dataUrl)) { reject(new Error("编码后的图片格式不受支持")); return; }
          resolve({ dataUrl, width: size.width, height: size.height, scaled: size.scaled });
        };
        img.onerror = () => reject(new Error("图片解码失败"));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error("文件读取失败"));
      reader.readAsDataURL(file);
    });
  }

  /** 把一批文件加进待发送列表（自动限流、自动提示超限）。 */
  async function addPendingImages(files) {
    const imgs = pickImageFiles(files);
    if (!imgs.length) return 0;
    const { accepted, dropped } = splitByCapacity(pendingImages.length, imgs, MAX_IMAGES);
    if (dropped.length && !accepted.length) {
      toast("一条消息最多带 " + MAX_IMAGES + " 张图，先撤掉一张再加吧～", 3000);
      return 0;
    }
    if (dropped.length) toast("一条消息最多带 " + MAX_IMAGES + " 张图，多出来的 " + dropped.length + " 张已忽略。", 3500);
    for (const f of accepted) {
      try {
        const big = await encodeImageDataUrl(f, IMAGE_MAX_DIM, IMAGE_QUALITY);
        const small = await encodeImageDataUrl(f, IMAGE_THUMB_DIM, THUMB_QUALITY);
        pendingImages.push({
          id: "img_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
          full: big.dataUrl,
          thumb: small.dataUrl,
          w: big.width,
          h: big.height,
          bytes: big.dataUrl.length,
        });
      } catch (e) {
        toast("这张图读不了（" + ((e && e.message) || e) + "），换一张试试～", 3500);
      }
    }
    renderAttachBar();
    return accepted.length;
  }

  function clearPendingImages() {
    pendingImages = [];
    renderAttachBar();
  }

  /** 重绘输入框上方的待发送缩略图条。用 DOM API 而不是 innerHTML：图片 URL 不经过字符串拼接。 */
  function renderAttachBar() {
    const bar = els.attachBar;
    if (!bar) return;
    bar.innerHTML = "";
    bar.classList.toggle("hidden", pendingImages.length === 0);
    if (!pendingImages.length) return;
    pendingImages.forEach((im) => {
      const chip = document.createElement("div");
      chip.className = "attach-chip";
      const thumb = document.createElement("img");
      thumb.src = im.thumb;
      thumb.alt = "待发送的图片";
      thumb.title = "点击看大图（" + im.w + "×" + im.h + "，约 " + humanBytes(im.bytes) + "）";
      thumb.addEventListener("click", () => openImageZoom(im.full || im.thumb));
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "attach-remove";
      rm.title = "移除这张图";
      rm.textContent = "✕";
      rm.addEventListener("click", () => {
        pendingImages = pendingImages.filter((x) => x.id !== im.id);
        renderAttachBar();
      });
      chip.appendChild(thumb);
      chip.appendChild(rm);
      bar.appendChild(chip);
    });
    const tip = document.createElement("span");
    tip.className = "attach-tip";
    tip.textContent = "已附 " + pendingImages.length + " 张 · 发送时会一起给老师";
    bar.appendChild(tip);
  }

  // ---- 大图查看（聊天里点图 / 点待发送缩略图共用一个浮层）----
  function openImageZoom(url) {
    if (!els.imgZoom || !els.imgZoomPic) return;
    if (!isSafeImageDataUrl(url)) return;
    els.imgZoomPic.src = url;
    els.imgZoom.classList.remove("hidden");
  }
  function closeImageZoom() {
    if (!els.imgZoom) return;
    els.imgZoom.classList.add("hidden");
    if (els.imgZoomPic) els.imgZoomPic.removeAttribute("src");
  }

  /**
   * 把一条消息里的图渲染成缩略图墙（用户气泡与复盘浮层共用）。
   * 这里走字符串拼接（要嵌进 bubble 的 innerHTML），所以两个属性值都过 escapeHtml：
   * url 虽然已被 displayableUrls 的 base64 白名单筛过（不含 &<>"' ），但契约测试
   * [9] 的立场是"属性值插值一律转义，别靠'我这里恰好安全'来豁免"——照办，
   * 反正对合法的 dataURL 是空操作。
   */
  function renderMsgImages(images) {
    const urls = displayableUrls(images);
    if (!urls.length) return "";
    const hasFull = (images || []).some((i) => i && i.full && isSafeImageDataUrl(i.full));
    const tip = hasFull ? "点击看大图" : "原图已随页面刷新释放，这里只剩缩略图";
    return '<div class="msg-images' + (urls.length === 1 ? " single" : "") + '">' +
      urls.map((u) =>
        '<img class="msg-image" src="' + escapeHtml(u) + '" alt="粘贴的图片" title="' + escapeHtml(tip) + '" />'
      ).join("") + "</div>";
  }

  // ---- 学员长期记忆（按教材隔离的跨会话画像）----
  // 每本教材用独立 localStorage 键：socratopia_memory_<bookKey>，值为 {topics:{}}（主题维度保留，便于一本书分多个学习主题）
  function loadBookMemory() {
    if (!S.currentBook) { S.memory = { topics: safeTopicMap() }; return; }
    try { S.memory = JSON.parse(localStorage.getItem(bookLS(S.currentBook.bookKey, "memory"))) || { topics: safeTopicMap() }; } catch (e) { S.memory = { topics: safeTopicMap() }; }
    if (!S.memory.topics) S.memory.topics = safeTopicMap();
    normalizeMemory();
  }
  // 记忆数据来自 localStorage，用户还能用「导入配置」把任意历史备份写回来——
  // 单个 topic 的字段未必齐全（旧 schema / 手工编辑 / 中途写入失败都会造成）。
  // 这里在"数据入口"统一补齐，读侧（renderMemoryPanel 等）就不必各自做空值防御。
  // 20260904：踏石留印面板曾因 topic 缺 mastered 而在 m.mastered.length 处抛
  // TypeError，导致整块面板渲染中断——与此前 buildPromptCtx 的崩溃同源。
  // 把"AI 返回的 / 存储里的字段"统一成字符串数组。
  // 模型经常把数组写成字符串（"mastered": "分数运算"），旧写法直接 .forEach 会抛
  // TypeError → 下课整条流程中断，用户看到"总结失败"却还照样弹出群聊复盘。
  // 只接受字符串/数字元素，对象一律丢弃（否则 "[object Object]" 会混进记忆和提示词）。
  function asList(v) {
    const src = Array.isArray(v) ? v : (v == null ? [] : [v]);
    return src
      .filter((x) => typeof x === "string" || typeof x === "number")
      .map((x) => String(x).trim())
      .filter(Boolean);
  }
  // 并集：两处（mergeMemory / migrateMemoryTopicKey）此前各写了一份同样的 lambda，
  // 且都假定入参是数组。收成一处，顺便把"非数组入参"这条真实故障路径挡在外面。
  function unionList(a, b) {
    const s = new Set(asList(a));
    asList(b).forEach((x) => s.add(x));
    return Array.from(s);
  }
  function normalizeMemory() {
    if (!S.memory || typeof S.memory !== "object") { S.memory = { topics: safeTopicMap() }; return; }
    // topics 必须是无原型映射：键是课程标题，普通对象会让 `topics["toString"]` 之类
    // 命中 Object.prototype 上的方法（详见 js/store.js 的 safeTopicMap 注释）。
    // JSON.parse 出来的永远是普通对象，所以每次载入都要在这里重建一次。
    S.memory.topics = safeTopicMap(S.memory.topics);
    Object.keys(S.memory.topics).forEach((k) => {
      const t = S.memory.topics[k];
      if (!t || typeof t !== "object" || Array.isArray(t)) { S.memory.topics[k] = { mastered: [], weak: [], misconceptions: [], sessions: 0 }; return; }
      if (!Array.isArray(t.mastered)) t.mastered = [];
      if (!Array.isArray(t.weak)) t.weak = [];
      if (!Array.isArray(t.misconceptions)) t.misconceptions = [];
      // 20260913：下面两块此前【完全没有校验】（只守了 habits 一项，典型的"同族只守一半"）。
      // 实测 {"userProfile":"偏视觉"} 会抛 "Cannot create property 'habits' on string"，
      // 而异常是从 loadBookMemory 冒出去的 → selectBook 中途断掉，后面的 renderMemoryPanel /
      // loadBookCollection / applyLessonUIMode 全部跳过：记忆面板空白、收藏不刷新、
      // 「上课」按钮状态卡在旧值。数据来自可导入的备份，必须当不可信输入。
      if (!t.userProfile || typeof t.userProfile !== "object" || Array.isArray(t.userProfile)) {
        t.userProfile = null; // 非对象一律视为"尚无画像"，由 mergeMemory 按需重建
      } else if (!Array.isArray(t.userProfile.habits)) {
        t.userProfile.habits = [];
      }
      if (!t.keypointStats || typeof t.keypointStats !== "object" || Array.isArray(t.keypointStats)) {
        t.keypointStats = {};
      } else {
        // weakKeypoints / activeMisconceptions 都会读 stats[k].status，读到 null 就崩（实测）
        Object.keys(t.keypointStats).forEach((kk) => {
          const st = t.keypointStats[kk];
          if (!st || typeof st !== "object" || Array.isArray(st) || (st.status !== "weak" && st.status !== "mastered")) {
            delete t.keypointStats[kk];
          }
        });
      }
    });
  }
  function saveBookMemory() {
    if (!S.currentBook) return;
    lsSet(bookLS(S.currentBook.bookKey, "memory"), JSON.stringify(S.memory), "学习记忆");
  }
  // 重命名课程时，把该教材记忆画像的 topic 键从旧标题迁移到新标题，避免旧记忆孤儿化。
  // 直接读写该教材的 localStorage（不依赖全局 memory 变量——被重命名的可能不是当前教材）。
  function migrateMemoryTopicKey(bk, oldTitle, newTitle) {
    if (!bk || !oldTitle || !newTitle || oldTitle === newTitle) return;
    try {
      const m = JSON.parse(localStorage.getItem(bookLS(bk.bookKey, "memory"))) || { topics: {} };
      if (m.topics && m.topics[oldTitle]) {
        if (!m.topics[newTitle]) {
          m.topics[newTitle] = m.topics[oldTitle]; // 新标题空闲：直接迁移
        } else {
          // 新标题已存在（理论上 UI 层已阻止重名，这里做兜底合并，绝不丢弃旧记忆）
          const src = m.topics[oldTitle], dst = m.topics[newTitle];
          dst.mastered = unionList(dst.mastered, src.mastered);
          dst.weak = unionList(dst.weak, src.weak);
          dst.misconceptions = unionList(dst.misconceptions, src.misconceptions);
          if (src.nextReview && (!dst.nextReview || src.nextReview < dst.nextReview)) dst.nextReview = src.nextReview;
        }
        delete m.topics[oldTitle];
        localStorage.setItem(bookLS(bk.bookKey, "memory"), JSON.stringify(m));
      }
    } catch (e) {}
    if (S.currentBook && bk && bk.bookKey === S.currentBook.bookKey) {
      loadBookMemory(); // 重命名的是当前教材：刷新内存中的记忆并重绘履历面板
      renderMemoryPanel();
    }
  }
  // 日期工具已上收至 js/dom.js（20260913）：pad2 / localISO / todayISO / addDays。
  // 上收的理由不只是"少几行"——js/profile.js 里另有两处一直在用 UTC 的 toISOString，
  // 而这里已经修过那个"UTC+8 清晨算成昨天"的 bug。合成一处之后两边口径必然一致。
  // 间隔重复的间隔天数（20260913 重写）。
  // 旧实现只有 1/2/3 三档且【永不增长】，m.sessions 完全不参与计算——连续 10 次满分、
  // 反复重学同一门课，nextReview 恒为 lastStudied + 3 天：那是固定打卡，不是间隔重复。
  // 现在：掌握不稳（<0.8）时维持短间隔快速回炉；一旦稳住，就随"已经学过几轮"逐级拉长，
  // 上限 8 次（约 40 天），避免间隔无限膨胀到再也复习不到。
  const REVIEW_LADDER = [3, 5, 8, 12, 17, 23, 30, 40];
  function reviewInterval(score, sessions) {
    if (!(score >= 0.8)) return score >= 0.5 ? 2 : 1;
    const n = Math.max(1, Math.min(Number(sessions) || 1, REVIEW_LADDER.length));
    return REVIEW_LADDER[n - 1];
  }
  // 重算复习间隔的【唯一】计算点：下课（mergeMemory）与交卷校准共用，杜绝两处口径不一互相覆盖。
  // 融合规则（core.js 纯函数）：有测验实测 quizScore 时 0.7 实测 + 0.3 老师主观分；无实测时纯主观分。
  function recalcNextReview(m) {
    m.nextReview = addDays(m.lastStudied, reviewInterval(fusedMasteryScore(m.selfScore, m.quizScore), m.sessions));
  }
  function currentTopicKey() { return (S.currentBook && S.currentBook.title) || "未命名教材"; }
  function mergeMemory(key, patch) {
    // 写侧兜底：取值前先确保 topics 是无原型映射。normalizeMemory 是唯一入口，
    // 理论上已覆盖；但这里是唯一【写入】topics 的地方，多一道守卫成本近乎为零，
    // 却能挡住"某条新路径绕过 normalizeMemory 直接换掉 topics"这类回归。
    if (!S.memory.topics || typeof S.memory.topics !== "object" || Object.getPrototypeOf(S.memory.topics) !== null) {
      S.memory.topics = safeTopicMap(S.memory.topics);
    }
    const m = S.memory.topics[key] || { mastered: [], weak: [], misconceptions: [], sessions: 0 };
    m.mastered = unionList(m.mastered, patch.mastered);
    m.weak = unionList(m.weak, patch.weak);
    m.misconceptions = unionList(m.misconceptions, patch.misconceptions);
    // 用户画像（因材施教）：思考习惯累计去重；性格推断与适配方式取【最新一次】——随会话不断修正、越来越了解这位学员
    if (patch.userProfile) {
      // 兼容新旧两种 schema：
      //   新 schema（config.js 要求 AI 输出）: { entries: [{dimension, content, why?}] }
      //   旧 schema（历史遗留）: { habits:[], personality:"", adaptive:"" }
      const up = patch.userProfile;
      const legacy = Array.isArray(up.entries)
        ? (() => {
            const habits = [], personality = [], adaptive = [];
            up.entries.forEach((e) => {
              const c = (e && e.content || "").trim();
              if (!c) return;
              const d = e.dimension;
              if (d === "personality") personality.push(c);
              else if (d === "guide" || d === "adaptive") adaptive.push(c);
              else habits.push(c); // 学习风格/思维习惯/知识基础/其它 都归为「习惯观察」
            });
            return { habits, personality: personality.join("；"), adaptive: adaptive.join("；") };
          })()
        : { habits: up.habits || [], personality: up.personality || "", adaptive: up.adaptive || "" };
      if (!m.userProfile) m.userProfile = { habits: [], personality: "", adaptive: "", observations: 0 };
      m.userProfile.habits = unionList(m.userProfile.habits, legacy.habits);
      // 习惯观察最多保留最近 6 条：既累计新观察，又不让自相矛盾的陈旧观察长期占据画像
      if (m.userProfile.habits.length > 6) m.userProfile.habits = m.userProfile.habits.slice(-6);
      if (legacy.personality) m.userProfile.personality = legacy.personality;
      if (legacy.adaptive) m.userProfile.adaptive = legacy.adaptive;
      m.userProfile.observations = (m.userProfile.observations || 0) + 1;
    }
    if (patch.selfScore != null) m.selfScore = patch.selfScore;
    if (state.familiarity) m.familiarity = state.familiarity;
    // 知识点级追踪：把下课总结的 mastered/weak/misconceptions 同步进 keypointStats
    // （只新建缺失项，不覆盖由测验得出的硬记录——测验比老师印象可靠）
    if (!m.keypointStats) m.keypointStats = {};
    (patch.mastered || []).forEach((kp) => { if (kp && !m.keypointStats[kp]) m.keypointStats[kp] = { status: "mastered", lastTested: todayISO(), correct: 0, wrong: 0 }; });
    [].concat(patch.weak || [], patch.misconceptions || []).forEach((kp) => { if (kp && !m.keypointStats[kp]) m.keypointStats[kp] = { status: "weak", lastTested: todayISO(), correct: 0, wrong: 0 }; });
    m.sessions = (m.sessions || 0) + 1;
    m.lastStudied = todayISO();
    // 间隔统一走 recalcNextReview：老师主观分只占 0.3，测验实测 quizScore 占 0.7（有实测时）。
    // 修复：此前 selfScore 单独说了算，下一课下课会把上一课的测验校准整个覆盖（校准活不过一个周期）。
    recalcNextReview(m);
    S.memory.topics[key] = m;
    saveBookMemory();
    renderMemoryPanel();
  }
  // ---- 跨课本全局学习画像（因材施教底图，解决「每 topic 独立观察、换书归零」）----
  // 条目式画像：AI 自动提取（source='ai'）+ 用户可看可改（source='user'）。
  // 具体读写与合并逻辑在 js/profile.js，这里只负责注入 system 与 UI 渲染/事件。

  // 用户画像块（因材施教）：跨课本全局画像（底图） + 本课观察画像，合并注入 system 提示词。
  // 同时附加"已有摘要"+"不准清单"，让 AI 课后能去重、避坑。
  function userProfileBlock(mem) {
    const gp = loadGlobalProfile();
    const up = mem && mem.userProfile;
    const base = composeProfileBlock(gp, up);
    const extra = [];
    const demoted = getDemotedContents();
    if (demoted.length) {
      extra.push("【用户标记为「不准」的观察（请勿在 userProfile.entries 中重新写入类似内容）】\n" +
        demoted.map((d) => "- " + d).join("\n"));
    }
    if (!base && !extra.length) return "";
    return [base, ...extra].filter(Boolean).join("\n\n");
  }

  // ---- 知识总结卡收藏（收入卷宗，按教材隔离）----
  function loadBookCollection() {
    if (!S.currentBook) { S.collection = []; return; }
    try { S.collection = JSON.parse(localStorage.getItem(bookLS(S.currentBook.bookKey, "collection"))) || []; } catch (e) { S.collection = []; }
    // 导入的历史备份可能是旧 schema / 手工改坏的非数组，兜底成数组避免下游 .filter 崩
    if (!Array.isArray(S.collection)) S.collection = [];
  }
  function saveCollection() {
    if (!S.currentBook) return;
    lsSet(bookLS(S.currentBook.bookKey, "collection"), JSON.stringify(S.collection), "我的收藏");
  }
  function isCollected(id) { return S.collection.some((c) => c.id === id); }
  function toggleCollect(id, topic, text) {
    if (!id || !S.currentBook) return false;
    if (isCollected(id)) {
      S.collection = S.collection.filter((c) => c.id !== id);
    } else {
      S.collection.push({ id, topic: topic || currentTopicKey(), text, collectedAt: todayISO() });
    }
    saveCollection();
    renderCollectionPanel();
    renderStorageUsage();
    return isCollected(id);
  }

  // ---- 啊哈时刻已于 20260915 下线（左栏审计结论见 STRUCTURE_REVIEW.md）----
  // 「顿悟瞬间」这套记录整体移除：数据层、打标签浮层、侧栏面板、「跳回当时那条消息」
  // 以及「下课保留实录」的判据。历史本地数据键 socratopia_aha_<bookKey> 仍在删除教材时
  // 的清理列表里（教材删除处保留该项），不会被漏下。
  // 注意：hashStr 不能删 —— 「☆ 收入卷宗」用它给普通 AI 消息生成稳定 id。

  // ---- 课后笔记（按课时存，模型产出 + 用户补充）----
  function loadLessonNotes(lid) {
    if (!S.currentBook || !lid) return null;
    try {
      const all = JSON.parse(localStorage.getItem(bookLS(S.currentBook.bookKey, "notes"))) || {};
      return all[lid] || null;
    } catch (e) { return null; }
  }
  function saveLessonNotes(lid, notes) {
    if (!S.currentBook || !lid) return;
    let all = {};
    try { all = JSON.parse(localStorage.getItem(bookLS(S.currentBook.bookKey, "notes"))) || {}; } catch (e) {}
    all[lid] = notes;
    lsSet(bookLS(S.currentBook.bookKey, "notes"), JSON.stringify(all), "课后笔记");
  }
  function openNotes(lid) {
    const notes = loadLessonNotes(lid);
    if (!notes) { alert("这节课还没有生成笔记。"); return; }
    els.notesSub.textContent = (S.currentBook ? S.currentBook.title : "") + " · 课后笔记";
    const cq = (notes.coreQuestions || []).map((x) => "<li>" + escapeHtml(x) + "</li>").join("");
    const pf = (notes.pitfalls || []).map((x) => "<li>" + escapeHtml(x) + "</li>").join("");
    els.notesBody.innerHTML =
      '<div class="notes-sec"><h4>🎯 核心问题</h4><ul>' + (cq || '<li class="notes-empty">（无）</li>') + "</ul></div>" +
      '<div class="notes-sec"><h4>💡 我的回答 / 收获</h4><p>' + escapeHtml(notes.myAnswers || "（无）") + "</p></div>" +
      '<div class="notes-sec"><h4>⚠️ 易错点</h4><ul>' + (pf || '<li class="notes-empty">（无）</li>') + "</ul></div>" +
      '<div class="notes-sec"><h4>🔭 待思考</h4><p>' + escapeHtml(notes.nextTime || "（无）") + "</p></div>" +
      '<div class="notes-sec"><h4>📝 我的补充反思</h4>' +
      '<textarea id="notesUserNote" placeholder="写下你自己的理解、例子或疑问…">' + escapeHtml(notes.userNote || "") + "</textarea>" +
      '<button id="notesSave" type="button" class="primary-btn small">保存我的反思</button></div>';
    els.notesOverlay.classList.remove("hidden");
    const saveBtn = els.notesBody.querySelector("#notesSave");
    if (saveBtn) saveBtn.addEventListener("click", function () {
      notes.userNote = els.notesBody.querySelector("#notesUserNote").value;
      saveLessonNotes(lid, notes);
      toast("已保存笔记");
    });
  }

  // ---- 本地存储 ----
  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(LS.settings)) || {}; } catch (e) {}
    const d = APP_CONFIG.defaultApi;
    els.apiBase.value = s.baseUrl || d.baseUrl;
    els.apiKey.value = s.apiKey || "";
    els.apiModel.value = s.model || d.model;
    els.apiTemp.value = (s.temperature != null) ? s.temperature : d.temperature;
    const registry = roles.getRegistry();
    const savedRole = s.role && registry[s.role] ? s.role : Object.keys(registry)[0];
    els.roleSelect.value = savedRole;
    // 若当前 baseUrl 命中某服务商预设，自动回选下拉（便于识别现在用的哪家）
    if (els.providerPreset) {
      const cur = els.apiBase.value.trim().replace(/\/+$/, "");
      const hit = Array.from(els.providerPreset.options).find((o) => o.dataset.base === cur);
      els.providerPreset.value = hit ? hit.value : "";
    }
  }

  function saveSettings() {
    const s = {
      baseUrl: els.apiBase.value.trim(),
      apiKey: els.apiKey.value.trim(),
      model: els.apiModel.value.trim(),
      temperature: api.temperature(),
      role: els.roleSelect.value,
    };
    lsSet(LS.settings, JSON.stringify(s), "设置");
  }

  // 把当前选中的教材资料同步到界面资料框
  // ---- 填充/同步课程编辑模态框的数据 ----
  function syncBookToUI() {
    if (!S.currentBook) {
      els.material.value = "";
      els.bookTitle.value = "";
      els.bookTitle.disabled = true;
    } else {
      els.material.value = S.currentBook.material || "";
      els.bookTitle.value = S.currentBook.title || "";
      els.bookTitle.disabled = false;
    }
    updateCount();
  }
  // 把模态框数据写回当前课程
  function syncUIToBook() {
    if (!S.currentBook) return;
    // 「新增课程」模态框与「编辑课程」共用 #bookTitle / #material 两个输入框。
    // 新建模式下它们填的是"待创建的新课程"，若仍走实时写回，会把内容写进当前已选中的
    // 那本教材——表现为：在新建框里打标题，左边已有课程被改名，保存后又多出一本同名课。
    // 20260904 修复：新建模式的实时写回直接跳过（正式写入由 cemSave 的 addBook 负责）。
    if (cemMode === "new") return;
    S.currentBook.material = els.material.value;
    const newTitle = els.bookTitle.value.trim() || "未命名教材";
    // 阻止改名到已存在的同名课程：标题同时是记忆画像的键，重名会导致记忆错配/孤儿化
    if (newTitle !== S.currentBook.title) {
      const dup = S.library.find((b) => b.id !== S.currentBook.id && (b.title || "") === newTitle);
      if (dup) {
        toast("已存在同名课程「" + newTitle + "」，为避免记忆串档，改名已取消");
        els.bookTitle.value = S.currentBook.title; // 还原输入框
        return;
      }
      migrateMemoryTopicKey(S.currentBook, S.currentBook.title, newTitle);
      S.currentBook.title = newTitle;
    }
    saveLibrary();
    renderBookList();
  }

  // ---- 课程编辑模态框 ----
  let cemMode = "edit"; // "edit" | "new"
  function openCourseEditModal(mode) {
    if (!mode && !S.currentBook) mode = "new";
    cemMode = mode || (S.currentBook ? "edit" : "new");
    syncBookToUI(); // 填充表单数据
    if (cemMode === "new") {
      els.cemTitle.textContent = "新增课程";
      els.cemSub.textContent = "上传学习材料，自动命名并生成大纲";
      els.bookTitle.value = "";
      els.bookTitle.disabled = false;
      els.material.value = "";
      updateCount();
    } else {
      els.cemTitle.textContent = "编辑课程资料";
      els.cemSub.textContent = "修改「" + (S.currentBook?.title || "") + "」的学习材料";
    }
    els.courseEditModal.classList.remove("hidden");
  }
  function closeCourseEditModal() {
    els.courseEditModal.classList.add("hidden");
  }

  function saveChat() {
    if (S.currentBook) {
      if (S.currentLessonId) {
        saveCurrentLessonChat(); // 课时模式：存到课时专属键
      } else {
        lsSet(bookLS(S.currentBook.bookKey, "chat"), JSON.stringify(cleanChatMessages(messages)), "对话记录");
      }
    }
  }
  // 【20260913 的一处"想修但撤回"，留作记录】
  // 下课收尾时 releaseLessonLock() 已清空 S.currentLessonId，于是 finally 里的 saveChat()
  // 会落到【教材级】chat 键，而不是 lesson_<lid> —— 看起来是"报告卡写错了地方"，我一度在这里
  // 加了一个 saveChatForLesson(endedLessonId) 去精确落盘。结果 E2E 立刻抓到回归：
  // 下课流程会先【清掉对话、只留报告卡】，所以那一刻的 messages 已经没有对话内容了，
  // 精确落盘等于把这节课的完整对话记录覆盖成只剩报告卡 —— 而群聊复盘的"上课记录"正是读它。
  // 结论（按必要性判断，不是放弃）：这条不该改。下课小结/测验本来就持久化在 lessonProg 里
  // （复习与复盘都在用），所以原行为的实际危害只是"刷新后课时里看不到那张报告卡"，属外观级；
  // 而改动它的代价会毁掉对话记录。**别只看到"键写错了"就去改，先看清那一刻 messages 里是什么。**
  // 群聊持久化（saveGroupChat）已于 20260902.1 迁入 js/group.js，经 group.saveGroupChat() 调用。
  // 切换教材时载入该教材的聊天/群聊
  function loadBookScoped() {
    group.loadFromStorage(); // 内含 groupLessonId 归零 + 读盘 + 清理 thinking 残留
    if (!S.currentBook) { messages = []; S.currentLessonId = null; return; }
    // 聊天记录：如果有当前课时，加载课时专属聊天；否则加载旧版全局聊天（兼容）
    if (S.currentLessonId) {
      messages = loadLessonChat(S.currentLessonId);
    } else {
      try { messages = cleanChatMessages(JSON.parse(localStorage.getItem(bookLS(S.currentBook.bookKey, "chat"))) || []); } catch (e) { messages = []; }
    }
    messages = messages.filter((m) => !(m.card && m.card.kind === "pending"));
  }

  function updateCount() {
    els.materialCount.textContent = (els.material.value || "").length + " 字";
  }

  // ---- 上下文占用估算（以「老师精力」呈现）----
  // 估算当前准备发给模型的全部内容（系统提示词 + 资料 + 历史对话）所占 token 数。
  // 中文约 1.6 字/token，这里用粗略但可用的比例：总字符数 / 1.6。
  // 上下文窗口：默认取 config 的 ctxWindow（1M，deepseek-v4-flash 档）。
  // 软上限=窗口×0.85（达到后建议下课）、硬上限=窗口×0.95（超过则发送前自动精简最久远对话）。
  // 抬高窗口在连续对话时的开销可控：前缀缓存默认开启，稳定前缀会被复用（命中量可在控制台看到）。
  // 注：这里刻意不写具体价格倍率 —— 价格会变，写进注释就会腐烂；要判断成本请以账单为准。
  // 若换更小窗口的模型，只改 config.js 的 APP_CONFIG.ctxWindow，不必动这里。
  const CTX_WINDOW = (APP_CONFIG.ctxWindow && APP_CONFIG.ctxWindow > 0) ? APP_CONFIG.ctxWindow : 1000000;
  const CTX_SOFT_LIMIT = Math.round(CTX_WINDOW * 0.85); // 软上限：达到后建议下课休息
  const CTX_HARD_LIMIT = Math.round(CTX_WINDOW * 0.95); // 硬上限：超过则发送前自动精简最久远的对话，保证不中断
  // estimateTokens 已抽至 js/core.js（SocratopiaCore.estimateTokens）

  // 计算当前（聊天模式）完整上下文 token 量 = 系统提示词 + 资料 + 历史对话
  function currentContextTokens() {
    const sysPrompt = buildSystemPrompt("chat", buildPromptCtx("chat"));
    const apiMsgs = apiHist();
    const hist = apiMsgs.map((m) => m.content || "").join("\n");
    // 20260916：图片不体现在 content 里（它是 msg.images），必须单独计入，
    // 否则"精力条"会在贴了图之后给出偏乐观的数字 —— 而每张图实际按几百 token 计。
    const img = countImageTokens(apiMsgs, IMAGE_TOKEN_EST);
    const sysTok = estimateTokens(sysPrompt);
    const histTok = estimateTokens(hist) + img;
    return { sys: sysTok, hist: histTok, total: sysTok + histTok };
  }
  // 「老师精力」文案：随占用率变化
  function teacherEnergyText(pct) {
    if (pct >= 100) return "透支";
    if (pct >= 85) return "疲惫";
    if (pct >= 60) return "渐累";
    if (pct >= 30) return "充沛";
    return "精神";
  }
  function updateContextMeter() {
    if (!els.ctxNum) return;
    const { sys, hist, total } = currentContextTokens();
    const pct = Math.round(total / CTX_SOFT_LIMIT * 100);
    const shown = Math.min(100, pct);
    // 标签随状态变化：老师精力（精神/充沛/渐累/疲惫/透支）
    els.ctxLabel.textContent = "老师精力 · " + teacherEnergyText(pct);
    els.ctxNum.textContent = "约 " + total.toLocaleString() + "（系统 " + sys.toLocaleString() + " · 对话 " + hist.toLocaleString() + "）";
    if (els.ctxBarFill) {
      els.ctxBarFill.style.width = shown + "%";
      els.ctxBarFill.className = pct >= 85 ? "danger" : (pct >= 60 ? "warn" : "");
    }
    // 提示语：吃紧时建议下课休息
    if (els.ctxHint) {
      if (pct >= 85) {
        els.ctxHint.textContent = "⚠️ 老师精力已" + teacherEnergyText(pct) + "，建议先点「📚 下课」整理总结、休息一下，再开始新的章节～";
        els.ctxHint.className = "ctx-hint warn";
      } else if (pct >= 60) {
        els.ctxHint.textContent = "老师精力渐累，长聊记得适时「📚 下课」收尾。";
        els.ctxHint.className = "ctx-hint mild";
      } else {
        els.ctxHint.textContent = "";
        els.ctxHint.className = "ctx-hint";
      }
    }
  }

  // ---- 番茄思维量：动态休息提示 ----
  // 当本节课累计轮次跨过一个「番茄」阈值时，向老师注入一次温和的休息建议。
  // 仅在跨越新番茄时触发（lastTomatoPrompted 控制），不会每条消息都提示。
  //
  // 20260913 修复：本函数此前【带副作用】——命中阈值时顺手把 lastTomatoPrompted 推到当前值。
  // 而它被 buildPromptCtx 调用，且 buildPromptCtx 在一次发送里会被调用多次
  // （currentContextTokens 为"老师精力"计量也会调它）。于是第一次调用就把提示文案
  // 取走并丢弃，真正构建 payload 的那次拿到空串 —— 这个功能等于 100% 失效，
  // 老师永远不会建议休息。现在它只读不写；记账挪到 advancePomodoroMarker()，
  // 由发送流程在回复到达后调用一次（用【发送前】的轮数，见调用点注释）。
  function pomodoroRhythmHint() {
    if (!S.currentLessonId) return "";
    const tomatoes = Math.floor(lessonExchangeCount / POMODORO_TOMATO_EXCHANGES);
    if (tomatoes > lastTomatoPrompted) {
      return "【学习节奏提示】本节课已累计约 " + (tomatoes * POMODORO_TOMATO_EXCHANGES) +
        " 轮深度交互，思维量已接近 / 达到一个「番茄」（约 25 分钟专注思考的量）。请在合适的对话节点，自然地询问学习者是否感到疲劳，并温和建议他可点「📚 下课」休息一下再回来强化。不要每条消息都问，挑一个自然的停顿点即可。";
    }
    return "";
  }
  // 标记「到当前为止的番茄提示已经用掉」。必须在 lessonExchangeCount 自增【之前】调用：
  // 自增后的值会多算一个番茄，把刚跨越的那次提示记成"已消费"却从未发出去，
  // 于是每 6 轮本该出现的休息提示会在第 6、12、18… 轮被精确地跳过。
  function advancePomodoroMarker() {
    if (!S.currentLessonId) return;
    lastTomatoPrompted = Math.max(lastTomatoPrompted, Math.floor(lessonExchangeCount / POMODORO_TOMATO_EXCHANGES));
  }

  // ---- 续学信息：判断当前课时是否处于「下课≠学完 → 休息后续学」状态 ----
  // 信号：打过 paused 标记（= 有实质学习内容、中途休息；含上次被意外中断的课时），
  // 且恢复后至少有一轮真实问答（防止把"无实质下课"误判成续学）。
  // 提取上次测验答错的题（含题目与解析），供续学时让老师【直接提醒知识点、强化记忆】而非设问推导。
  // 复习素材块（复习课专用）：薄弱知识点 / 误区 / 近期错题全文 / 已掌握跳过清单
  function reviewMaterialBlock() {
    const m = S.memory.topics[currentTopicKey()];
    const weak = weakKeypoints();
    const miscon = activeMisconceptions(m); // 已被测验证明掌握的误区不再进复习素材
    const mastered = (m && m.mastered) || [];
    const wb = loadWrongbook();
    // 聚合各课时「下课自评未覆盖」的关键知识点（去重）：让复习课也能补讲这些历史漏点
    const uncoveredAll = collectUncovered();
    let blk = "【本次复习素材（系统记录的历史学习档案，源自此前基于教材的教学总结；本次无教材切片属正常）】\n";
    if (weak.length) blk += "- 薄弱知识点（复习优先照顾）：" + weak.slice(0, 12).join("、") + "\n";
    if (miscon.length) blk += "- 历史误区（重点澄清）：" + miscon.join("、") + "\n";
    if (uncoveredAll.length) blk += "- 历史未覆盖知识点（上次下课自评漏掉、本次复习优先补讲）：" + uncoveredAll.slice(0, 12).join("、") + "\n";
    if (mastered.length) blk += "- 已掌握（不用再教，主动回忆确认即可）：" + mastered.slice(0, 12).join("、") + "\n";
    if (wb.length) {
      blk += "- 近期错题（错题本共 " + wb.length + " 条，下面列出最近的）：\n";
      wb.slice(0, 5).forEach((x, i) => {
        blk += "  错题" + (i + 1) + "（" + (x.date || "") + (x.kp ? " · " + x.kp : "") + "）：" + (x.q || "") + "\n" +
               "  解析：" + (x.explanation || "（无）") + "\n";
      });
    }
    if (!weak.length && !miscon.length && !uncoveredAll.length && !wb.length) blk += "-（暂无薄弱记录，请围绕已掌握内容做一次轻量主动回忆巩固。）\n";
    return blk;
  }
  // 间隔复习附加素材（新课/聊天的到期提醒轻量附加）：薄弱点清单 + 最多 2 道代表错题（控制 token）
  function reviewExtras() {
    let out = "";
    const weak = weakKeypoints();
    if (weak.length) out += "\n- 【薄弱知识点（复习优先照顾）】" + weak.slice(0, 10).join("、");
    // 历史未覆盖点也轻量带入间隔复习提醒
    const uncov = collectUncovered();
    if (uncov.length) out += "\n- 【历史未覆盖知识点（复习时可顺带补讲）】" + uncov.slice(0, 8).join("、");
    const wb = loadWrongbook();
    if (wb.length) {
      out += "\n- 【近期错题知识点】" + wb.slice(0, 6).map((x) => x.kp || "（未标注）").join("、");
      out += "\n- 【代表错题（复习时请直接讲清对应知识点，不要设问推导）】";
      wb.slice(0, 2).forEach((x, i) => { out += "\n  错题" + (i + 1) + "：" + (x.q || "") + "\n  解析：" + (x.explanation || "（无）"); });
    }
    return out;
  }
  function wrongQuizReminderBlock(lid) {
    if (!lid) return "";
    const entry = loadLessonProg()[lid];
    if (!entry || !Array.isArray(entry.quiz) || !Array.isArray(entry.quizWrong) || !entry.quizWrong.length) return "";
    const items = entry.quizWrong
      .map((i) => entry.quiz[i])
      .filter(Boolean)
      .map((q, k) => "错题" + (k + 1) + "：" + (q.q || "") + "\n  知识点解析：" + (q.explanation || "（无解析）"));
    if (!items.length) return "";
    return "【上次测验答错的题（续学时请直接、明确地把对应知识点讲清楚来强化记忆，不要设问/追问让学习者重新推导）】\n" + items.join("\n\n");
  }
  // 出题聚焦块：把学习档案里的薄弱点 / 历史误区 / 近期错题聚合成「针对我的测验」指令。
  // 此前 buildDynamicSystem 在 lessonEnd（出 quiz 的模式）动态段为空，这些信息被丢掉，
  // 导致随堂测验与学习者真实薄弱点脱钩。本块让测验题优先覆盖弱项、点名纠正误区。
  function quizFocusBlock() {
    const m = S.memory.topics[currentTopicKey()] || {};
    const weak = weakKeypoints();
    const miscon = activeMisconceptions(m); // 同上：别再要求"点名纠正"一个学生早已掌握的点
    const wb = loadWrongbook();
    if (!weak.length && !miscon.length && !wb.length) return "";
    let blk = "【本次测验重点（系统依据学习档案生成，请据此出题而非泛泛而问）】\n";
    if (weak.length) blk += "- 薄弱知识点（务必出 1~2 题重点考察）：" + weak.slice(0, 8).join("、") + "\n";
    if (miscon.length) blk += "- 历史误区（请在题目中点名纠正，给他一个能暴露该误区的情境）：" + miscon.join("、") + "\n";
    if (wb.length) blk += "- 近期错题知识点（优先重考，换情境但考点相同）：" + wb.slice(0, 6).map((x) => x.kp || "（未标注）").join("、") + "\n";
    blk += "要求：至少 1 题必须是针对上面薄弱/误区点的【新情境应用题】，考他能否真正用上，而不是背答案。";
    return blk;
  }
  function resumeContinuationInfo(lid) {
    if (!S.currentBook || !lid) return null;
    const entry = loadLessonProg()[lid];
    if (!entry || !entry.paused) return null;
    const chat = loadLessonChat(lid);
    if (!chat.some((m) => m.role === "user")) return null;
    const loc = findLessonById(lid);
    return {
      lessonTitle: loc ? loc.lesson.title : "本节课",
      summary: entry.summary || "",
      selfScore: entry.selfScore,
      interrupted: !!entry.interrupted,
    };
  }

  // ---- 渲染（一对一课程） ----
  // escapeHtml 已于 20260907 下沉至 js/core.js（SocratopiaCore.escapeHtml，纯函数 + 单测覆盖），
  // 在上面第 124 行随其他 core 函数一并解构引入。全站共用同一实现，避免多份实现各自漂移。
  // 行内 markdown：转义后把 **粗体** → <b>（小结卡等 AI 产出的卡片文本用）
  function inlineMd(s) {
    return escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  }
  // 轻量卡片文本渲染器：把 `- `/`* `/`• ` 连续行 → <ul><li>，`> ` 行 → <blockquote>，其余行保持（换行由 CSS pre-wrap 负责）。
  // 修复"小结卡 markdown 显示成带符号纯文本"。
  function renderCardText(text) {
    const lines = String(text == null ? "" : text).split(/\r?\n/);
    const out = [];
    let i = 0;
    while (i < lines.length) {
      let lm = lines[i].match(/^\s*(?:[-*•])\s+(.*)$/);
      if (lm) {
        const items = [inlineMd(lm[1])]; i++;
        while (i < lines.length && (lm = lines[i].match(/^\s*(?:[-*•])\s+(.*)$/))) { items.push(inlineMd(lm[1])); i++; }
        out.push("<ul><li>" + items.join("</li><li>") + "</li></ul>");
        continue;
      }
      let qm = lines[i].match(/^\s*>\s?(.*)$/);
      if (qm) {
        const qs = [inlineMd(qm[1])]; i++;
        while (i < lines.length && (qm = lines[i].match(/^\s*>\s?(.*)$/))) { qs.push(inlineMd(qm[1])); i++; }
        out.push("<blockquote>" + qs.join("<br>") + "</blockquote>");
        continue;
      }
      out.push(inlineMd(lines[i])); i++;
    }
    return out.join("\n");
  }
  // 全角英数/空格 → 半角：用户输入法误开「全角」时，字母会渲染成宽字符（如 ｓａｌｅｓ，看起来像字母之间都有空格），
  // 自动转回半角，避免消息里英文间距异常。只转字母/数字/空格，不动中文标点（？，。等本就该用全角）。
  function toHalfWidth(s) {
    return String(s == null ? "" : s).replace(/[０-９Ａ-Ｚａ-ｚ　]/g, (c) => {
      if (c === "　") return " ";
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
  }
  function cardHead(seal, title) {
    return '<div class="card-head"><span class="seal-mini">' + seal + '</span><span class="card-title">' + title + "</span></div>";
  }
  function renderMessages() {
    // 仅在用户原本就在底部时自动滚动，避免回看历史时被新请求顶下去
    const nearBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 80;
    els.messages.innerHTML = "";
    // 课时内聊天搜索：按关键词过滤当前课时消息（不改数据，仅改显示）
    const q = (state.chatQuery || "").trim().toLowerCase();
    let list = messages;
    if (q) list = messages.filter((m) => ((m.content || (m.card && m.card.text) || "").toLowerCase().indexOf(q) >= 0));
    list.forEach((m) => {
      const realIdx = messages.indexOf(m);
      els.messages.appendChild(bubble(m, realIdx));
    });
    if (nearBottom) els.messages.scrollTop = els.messages.scrollHeight;
    // 更新搜索命中数提示
    if (els.chatSearchCount) els.chatSearchCount.textContent = q ? ("命中 " + list.length + " 条") : "";
  }
  function bubble(m, idx) {
    if (m.card) {
      const d = document.createElement("div");
      if (m.card.kind === "pending") {
        d.className = "msg card summary";
        d.innerHTML = cardHead("整", "整理中") + '<div class="card-body"><span class="thinking-spinner" style="margin-right:8px;vertical-align:middle;"></span>' + escapeHtml(m.card.text) + "</div>";
      } else if (m.card.kind === "summary") {
        // 知识总结卡：独立卡片，可收入记忆回顾；下课≠完成，可手动标记为已完成
        const collected = isCollected(m.card.id);
        const sumLid = m.card.lid || "";
        const sumDone = sumLid && getLessonStatus(sumLid) === "completed";
        d.className = "msg card summary";
        d.innerHTML = cardHead("结", "知识总结卡") +
          // B7（2026-09-10）：被截断的小结会"看起来正常"，必须显式说明它缺了什么，
          // 否则用户只会以为老师这次忘了出题。
          (m.card.truncated
            ? '<div class="card-warn">⚠️ 老师的输出撞上了【模型的输出上限】被截断，这份小结只抢救到前半截——'
              + "本次可能缺了随堂测验 / 课后笔记 / 画像观察。到 ⚙️ 设置换一个输出上限更大的模型，"
              + "再点「🔄 重新生成总结」即可补全。</div>"
            : "") +
          '<div class="card-body">' + renderCardText(m.card.text) + "</div>" +
          '<div class="card-foot">' +
          '<button type="button" class="collect-btn ghost-btn small ' + (collected ? "collected" : "") + '" data-cid="' + escapeHtml(m.card.id || "") + '">' +
          (collected ? "★ 已收入卷宗" : "☆ 收入卷宗") + '</button>' +
          '<button type="button" class="group-review-btn ghost-btn small">💬 群聊复盘</button>' +
          (sumLid ? '<button type="button" class="mark-complete-btn ghost-btn small ' + (sumDone ? "done" : "") + '" data-lid="' + escapeHtml(sumLid) + '">' + (sumDone ? "✓ 已完成" : "✓ 标记为已完成") + '</button>' : "") +
          '</div>';
      } else if (m.card.kind === "summaryError") {
        // 小结生成失败：提供重试；不再暴露「查看原始响应」调试信息（用户看不懂），原始响应只留 console.warn
        d.className = "msg card summary error";
        d.innerHTML = cardHead("警", "整理小结遇到问题") +
          '<div class="card-body">' + escapeHtml(m.card.text) + "</div>" +
          '<div class="card-foot">' +
          '<button type="button" class="retry-summary-btn primary-btn small" data-lid="' + escapeHtml(m.card.lid || "") + '">🔄 重新生成总结</button>' +
          '</div>';
      } else if (m.card.kind === "gotoQuiz") {
        // 下课后的「去答题」提示卡：点击打开答题浮层
        d.className = "msg card goto-quiz";
        d.innerHTML = cardHead("测", "随堂测验") +
          '<div class="card-body">' + escapeHtml(m.card.text || "点击开始答题～") + '</div>' +
          '<div class="card-foot"><button type="button" class="start-quiz-btn primary-btn small" type="button">📝 开始答题</button></div>';
      } else if (m.card.kind === "resumeLesson") {
        // 下课后的「继续学习本课」提示卡（未学完，不推下一节）
        d.className = "msg card resume-lesson";
        d.innerHTML = cardHead("续", "继续学习") +
          '<div class="card-body">' + escapeHtml(m.card.text || "") + '</div>';
      } else if (m.card.kind === "nextLesson") {
        // 下课后的「下一节」提示卡
        d.className = "msg card next-lesson";
        d.innerHTML = cardHead("续", "下一节") +
          '<div class="card-body">' + escapeHtml(m.card.text || "") + '</div>' +
          '<div class="card-foot"><button type="button" class="next-les-btn primary-btn small" data-lid="' + escapeHtml(m.card.nextLessonId || "") + '">▶ 开始下一节</button></div>';
      } else if (m.card.kind === "allDone") {
        // 全部课时完成
        d.className = "msg card all-done";
        d.innerHTML = cardHead("完", "全部完成") +
          '<div class="card-body">' + escapeHtml(m.card.text || "") + '</div>';
      } else if (m.card.kind === "lessonNotes") {
        // 下课后的「课后笔记」卡：点击打开笔记浮层
        d.className = "msg card lesson-notes";
        d.innerHTML = cardHead("笔", "课后笔记") +
          '<div class="card-body">' + escapeHtml(m.card.text || "") + '</div>' +
          '<div class="card-foot"><button type="button" class="open-notes-btn primary-btn small" data-lid="' + escapeHtml(m.card.lid || "") + '">📓 查看笔记</button></div>';
      } else if (m.card.kind === "lessonPreview") {
        // 课时预览卡（浏览模式，未上课）
        d.className = "msg card lesson-preview";
        const kpsHtml = (m.card.keyPoints || []).length
          ? '<div class="lp-kps">' + (m.card.keyPoints || []).map((k) => '<span class="lp-kp-tag">' + escapeHtml(k) + '</span>').join("") + '</div>'
          : '';
        d.innerHTML = cardHead("课", "课时预览") +
          '<div class="card-body">' +
          '<div class="lp-title"><b>' + escapeHtml(m.card.title || "") + '</b>' +
          (m.card.chapter ? ' <span class="lp-chapter">' + escapeHtml(m.card.chapter) + '</span>' : '') + '</div>' +
          (m.card.focus ? '<div class="lp-focus">' + escapeHtml(m.card.focus) + '</div>' : '') +
          kpsHtml +
          '<div class="lp-text">' + escapeHtml(m.card.text || "") + '</div>' +
          '</div>';
      } else if (m.card.kind === "resume") {
        // 续学衔接卡：下课≠学完，休息后回来继续学习（断点参考上次小结）
        d.className = "msg card lesson-preview";
        d.innerHTML = cardHead("续", "继续学习") +
          '<div class="card-body">' + escapeHtml(m.card.text || "") + "</div>" +
          (m.card.summary
            ? '<div class="card-body resume-summary"><div class="resume-summary-title">📋 上次小结（续学断点）</div>' + renderCardText(m.card.summary) + "</div>"
            : "");
      }
      return d;
    }
    const div = document.createElement("div");
    const isUser = m.role === "user";
    div.className = "msg " + (isUser ? "user" : "ai");
    div.dataset.idx = (typeof idx === "number" ? idx : "");
    // AI 气泡：若有上传头像则显示头像，否则沿用印章「问」
    if (!isUser) {
      const avatar = getAvatar(els.roleSelect.value);
      if (avatar) { div.classList.add("has-avatar"); div.style.setProperty("--avatar-url", 'url("' + avatar + '")'); }
      // 思考中：spinner + 轮换文案 + 超时提示。
      // 20260907 修复：不再渲染 m.content（那是 formatThinkingHtml 的 HTML 字符串，
      // 之前被 escapeHtml 整段转义 → 指示器显示成源码）。改为渲染时从 m.thinking
      // 实时状态重建；短语转义仍由 formatThinkingHtml 内部处理，无 XSS 入口。
      if (m.thinking) {
        const t = m.thinking;
        // 流式进行中：直接显示已到达的原文。正文用独立 span，后续每帧只 textContent 追加新到的
        // delta（天然防 XSS，且总代价 O(n) 不卡死），避免旧版「每 chunk 重写整段 innerHTML → O(n²)」。
        if (t.partial) {
          div.dataset.mid = t.id;
          const shown = stripQualityForDisplay(t.partial);
          div.innerHTML = '<div class="msg-content streaming-text"><span class="stream-text">' + escapeHtml(shown) + '</span><span class="stream-caret"></span></div>';
          t._flushed = shown.length;
          return div;
        }
        const phrases = t.phrases || [];
        const phrase = phrases[t.phraseIdx] || phrases[0] || "";
        div.dataset.mid = t.id;
        div.innerHTML = '<div class="msg-content thinking-msg">' + formatThinkingHtml(phrase, !!t.warn) + "</div>";
        return div;
      }
      // 操作工具条（仅 AI 文本消息）：复制 / 重新生成 / 引用追问 / 收入卷宗
      const isLastAssistant = (typeof idx === "number") && idx === messages.length - 1;
      const tools = document.createElement("div");
      tools.className = "msg-tools";
      tools.innerHTML =
        '<button type="button" class="msg-tool" data-act="copy" title="复制全文">📋</button>' +
        (isLastAssistant ? '<button type="button" class="msg-tool" data-act="regen" title="重新生成这条回复">🔄</button>' : "") +
        '<button type="button" class="msg-tool" data-act="quote" title="引用这条去追问">💬</button>' +
        '<button type="button" class="msg-tool" data-act="collect" data-cid="ai_' + hashStr(m.content || "") + '" title="收入卷宗">☆</button>';
      div.innerHTML = '<div class="msg-content">' + renderRichText(m.content) + "</div>";
      div.appendChild(tools);
      return div;
    }
    // 用户气泡：无可操作按钮（原「记啊哈时刻」💡 已随啊哈时刻一并下线）
    // 图片墙在文字之前 —— 粘贴的截图通常就是"这条消息的主体"，文字只是附带说明。
    // 纯图片消息（没打字）时不再包一个空的 .msg-content，否则会多出一段空白。
    const imgsHtml = renderMsgImages(m.images);
    const textHtml = String(m.content == null ? "" : m.content) ? '<div class="msg-content">' + renderRichText(m.content) + "</div>" : "";
    div.innerHTML = imgsHtml + textHtml;
    return div;
  }
  // ---- 复盘气泡（只读，去掉所有交互按钮，仅展示历史内容）----
  function reviewBubble(m) {
    const div = document.createElement("div");
    if (m.card) {
      div.className = "msg card review-card";
      const label = { pending: "整理中", summary: "知识总结", gotoQuiz: "随堂测验", resumeLesson: "继续学习", nextLesson: "下一节", allDone: "全部完成" }[m.card.kind] || "卡片";
      div.innerHTML = cardHead(label[0] || "复", label) + '<div class="card-body">' + renderCardText(m.card.text || "") + "</div>";
      return div;
    }
    const isUser = m.role === "user";
    div.className = "msg " + (isUser ? "user" : "ai");
    if (!isUser) {
      const avatar = getAvatar(els.roleSelect.value);
      if (avatar) { div.classList.add("has-avatar"); div.style.setProperty("--avatar-url", 'url("' + avatar + '")'); }
    }
    div.innerHTML = renderMsgImages(m.images) + renderRichText(m.content);
    return div;
  }
  function reviewSectionHead(t) {
    const h = document.createElement("div");
    h.className = "review-section-head";
    h.textContent = t;
    return h;
  }
  // ---- 学习复盘：仅查看某课程的聊天记录（不解锁上课、不影响当前课）----
  function openReview(bid) {
    const bk = S.library.find((b) => b.id === bid);
    if (!bk) return;
    els.reviewTitle.textContent = (bk.title || "未命名课程") + " · 学习复盘";
    els.reviewMessages.innerHTML = "";
    let any = false;
    // 1) 自由交流（非课时模式）聊天记录
    try {
      const general = cleanChatMessages(JSON.parse(localStorage.getItem(bookLS(bk.bookKey, "chat"))) || []);
      if (general.length) {
        any = true;
        els.reviewMessages.appendChild(reviewSectionHead("自由交流"));
        general.forEach((m) => els.reviewMessages.appendChild(reviewBubble(m)));
      }
    } catch (e) {}
    // 2) 各课时聊天记录（按大纲顺序聚合）
    const outline = bk.outline;
    if (outline && outline.chapters) {
      (outline.chapters || []).forEach((ch, ci) => {
        (ch.lessons || []).forEach((ls) => {
          let chat = [];
          try { chat = cleanChatMessages(JSON.parse(localStorage.getItem(bookLS(bk.bookKey, "lesson_" + ls.id))) || []); } catch (e) {}
          if (chat.length) {
            any = true;
            els.reviewMessages.appendChild(reviewSectionHead("第 " + (ci + 1) + " 章 · " + (ls.title || "课时")));
            chat.forEach((m) => els.reviewMessages.appendChild(reviewBubble(m)));
          }
        });
      });
    }
    if (!any) {
      els.reviewMessages.innerHTML = '<div class="msg system">这门课还没有任何聊天记录。上过课之后再来回看学习过程吧。</div>';
    }
    els.reviewMessages.scrollTop = 0;
    filterReviewNodes(els.reviewSearch ? els.reviewSearch.value : "");
    els.reviewOverlay.classList.remove("hidden");
  }
  function closeReview() { els.reviewOverlay.classList.add("hidden"); }
  // 复盘浮层：按关键词就地过滤聊天节点（不重建，仅隐藏不匹配；分组头保留）
  function filterReviewNodes(q) {
    if (!els.reviewMessages) return;
    q = (q || "").trim().toLowerCase();
    Array.from(els.reviewMessages.children).forEach((c) => {
      if (c.classList.contains("review-section-head")) return;
      if (c.classList.contains("msg") && c.classList.contains("system")) {
        if (q) c.style.display = "none"; else c.style.display = "";
        return;
      }
      const text = (c.textContent || "").toLowerCase();
      c.style.display = (!q || text.indexOf(q) >= 0) ? "" : "none";
    });
  }
  // ---- 查看原文浮层 ----
  // 20260910.1：整块迁出至 js/source-viewer.js —— 浮层自己的状态（查找词 / 命中集 /
  // 当前高亮课时 / 当前章序号）收敛在该模块闭包内，交互事件也由它自己绑定；
  // 宿主只保留一处装配（见下方 createSourceViewer 调用）与两处入口 sourceViewer.open()。
  function pushMessage(role, content, images) {
    // content 永远是字符串（见文件顶部「图片输入」三条约束的第 1 条）；
    // 图片作为独立字段挂在消息上，只在发请求时由 toApiMessage 拼成 content 块数组。
    const msg = { role, content: role === "user" ? toHalfWidth(content) : content };
    if (role === "user" && images && images.length) msg.images = images;
    messages.push(msg);
    renderMessages();
    saveChat();
  }

  // ---- 踏石留印面板（侧边栏）----
  function renderMemoryPanel() {
    const keys = Object.keys(S.memory.topics);
    // 20260915 修：原来写的是 style.display —— 内联样式的优先级高于任何类选择器，
    // 于是「区块折叠」的 .memory-panel.collapsed .mem-empty{display:none} 会被它压掉，
    // 折起来之后空状态提示仍然杵在那里（看着像折叠没生效）。改走 .hidden 类。
    els.memoryEmpty.classList.toggle("hidden", keys.length > 0);
    els.memoryList.innerHTML = "";
    keys.forEach((key) => {
      const m = S.memory.topics[key];
      const sc = m.selfScore != null ? m.selfScore
        : ((m.mastered.length || m.weak.length) ? m.mastered.length / (m.mastered.length + m.weak.length || 1) : 0.5);
      const pct = Math.round(sc * 100);
      const overdue = m.nextReview && todayISO() >= m.nextReview;
      const div = document.createElement("div");
      div.className = "mem-item";
      const tag = (arr, cls) => (arr || []).map((x) => '<span class="tag ' + cls + '">' + escapeHtml(x) + "</span>").join("");
      div.innerHTML =
        '<div class="mem-row1"><span class="mem-name">' + escapeHtml(key) + "</span>" +
        (overdue ? '<span class="mem-badge review">待复习</span>' : "") + "</div>" +
        '<div class="mem-bar"><span style="width:' + pct + '%"></span></div>' +
        '<div class="mem-meta">掌握度 ' + pct + "% · 上次 " + escapeHtml(m.lastStudied || "-") + " · 第 " + escapeHtml(m.sessions || 1) + " 次</div>" +
        '<div class="mem-detail hidden">' +
        (m.userProfile && (m.userProfile.personality || m.userProfile.habits.length)
          ? '<div class="mem-dl"><b>画像</b>' +
            (m.userProfile.personality ? '<span class="tag warn">' + escapeHtml(m.userProfile.personality) + "</span>" : "") +
            (m.userProfile.habits.length ? '<span class="mem-profile-habits">' + escapeHtml(m.userProfile.habits.join("；")) + "</span>" : "") +
            // B11：observations 必须是数字。旧写法直接把它拼进 innerHTML ——
            // 同行的 personality/habits 都过了 escapeHtml，只有这处漏了（"同族只守一半"）。
            // 它理论上只由应用自增，但持久化数据（导入的备份 / 手工改过的 localStorage）
            // 可以是任意字符串，于是变成一处注入点。这里既转义又把非数字兜成 0。
            (Number(m.userProfile.observations) > 0 ? '<span class="mem-meta">（' + Number(m.userProfile.observations) + ' 次观察，逐步修正）</span>' : "") +
            "</div>" : "") +
        (m.mastered.length ? '<div class="mem-dl"><b>已掌握</b>' + tag(m.mastered, "ok") + "</div>" : "") +
        (m.weak.length ? '<div class="mem-dl"><b>易错</b>' + tag(m.weak, "bad") + "</div>" : "") +
        // 这里刻意展示【原始记录】（不套 activeMisconceptions 读侧治愈），与上一行的「易错」一致：
        // 面板是"踏石留印"，如实反映曾记下什么；而注入提示词的才是治愈后的有效清单。
        // 若哪天要把面板也改成"有效状态"，请连同「易错」一起改（weakKeypoints），别只改一半。
        (m.misconceptions.length ? '<div class="mem-dl"><b>误区</b>' + tag(m.misconceptions, "warn") + "</div>" : "") +
        "</div>";
      div.addEventListener("click", (e) => {
        const d = div.querySelector(".mem-detail");
        if (d) d.classList.toggle("hidden");
      });
      els.memoryList.appendChild(div);
    });
  }

  // ---- 我的收藏面板（侧边栏，20260915 由「知识卡片」更名）----
  function renderCollectionPanel() {
    els.collectionEmpty.classList.toggle("hidden", S.collection.length > 0);
    els.collectionList.innerHTML = "";
    // 按收藏时间倒序（最新的在前）
    const sorted = [...S.collection].sort((a, b) => (b.collectedAt || "").localeCompare(a.collectedAt || ""));
    sorted.forEach((c) => {
      const div = document.createElement("div");
      div.className = "mem-item";
      div.innerHTML =
        '<div class="mem-row1"><span class="mem-name">' + escapeHtml(c.topic || "未命名") + "</span>" +
        '<span class="mem-badge review">' + escapeHtml(c.collectedAt || "") + '</span></div>' +
        '<div class="col-card-body">' + renderCardText(c.text || "") + "</div>" +
        '<button type="button" class="ghost-btn small mem-use col-del" data-cid="' + escapeHtml(c.id) + '">移除</button>';
      div.addEventListener("click", (e) => {
        if (e.target.closest(".col-del")) {
          const cid = e.target.closest(".col-del").dataset.cid;
          S.collection = S.collection.filter((x) => x.id !== cid);
          saveCollection();
          renderCollectionPanel();
          return;
        }
      });
      els.collectionList.appendChild(div);
    });
  }

  // ---- 啊哈时刻的侧栏面板与「跳回当时那条消息」已于 20260915 一并移除 ----

  // ---- 啊哈时刻的跳回消息实现已随该功能一并移除 ----
  const expandedCourses = new Set();
  // 复习入口信息：当前书有薄弱知识点或错题时返回按钮文案（含到期标识），否则 null（不渲染入口）
  function reviewEntryInfo() {
    if (!S.currentBook) return null;
    const wb = loadWrongbook();
    const weak = weakKeypoints();
    if (!wb.length && !weak.length) return null;
    const m = S.memory.topics[currentTopicKey()];
    const due = m && m.nextReview && todayISO() >= m.nextReview;
    return "🔄 间隔复习（" + (weak.length + wb.length) + " 项待巩固" + (due ? " · 已到期" : "") + "）";
  }
  // ===== 课程树渲染 =====
  // 20260913 从 renderBookList 拆出（原函数 329 行、同时干三件事：读进度 / 拼 HTML / 绑事件）。
  // 拆法刻意保持"纯字符串拼装 + 不碰状态"（只有最后的 bind 绑事件），
  // 这样每一块都能单独看懂，改样式不必先读懂事件绑定。

  /** 某本书的课时进度表（按 bookKey 隔离的 localStorage）。读盘失败按空表处理。 */
  function courseProgress(bk) {
    if (!bk || !bk.outline || !bk.outline.chapters) return {};
    try { return JSON.parse(localStorage.getItem(bookLS(bk.bookKey, "lessonprog"))) || {}; } catch (e) { return {}; }
  }
  /** 课程级进度 = 已完成章节数 / 全部章节数（一章内所有课时都「已完成」才算该章完成） */
  function courseChapterProgress(bk, prog) {
    const chapters = (bk.outline && bk.outline.chapters) || [];
    let done = 0;
    chapters.forEach((ch) => {
      const lessons = ch.lessons || [];
      if (lessons.length && lessons.every((ls) => (prog[ls.id] || {}).status === "completed")) done++;
    });
    return { done, total: chapters.length };
  }

  /** 课程卡头部：课程名 + 进度 + 大纲不完整告警 + 三个操作按钮 */
  function courseHeaderHtml(bk, prog, isActive, isExpanded) {
    const outline = bk.outline;
    const inSession = bk.id === S.activeSessionBookId;
    const { done: doneChapters, total: totalChapters } = courseChapterProgress(bk, prog);
    const pct = totalChapters ? Math.round(doneChapters / totalChapters * 100) : 0;
    let h = '<div class="course-head' + (inSession ? " in-session" : "") + '" data-bid="' + escapeHtml(bk.id) + '">' +
      '<span class="course-arrow">' + (isExpanded ? "▼" : "▶") + '</span>' +
      '<div class="course-info">' +
      '<div class="course-name">' + escapeHtml(bk.title || "未命名课程") + (inSession ? '<span class="session-badge">上课中</span>' : '') + '</div>';
    if (totalChapters > 0) {
      h += '<div class="course-progress-row"><div class="course-bar"><span style="width:' + pct + '%"></span></div><span class="course-pct">' + pct + '%</span><span class="course-pct-label">已完成 ' + doneChapters + '/' + totalChapters + '章</span></div>';
    } else {
      h += '<div class="course-meta">' + (bk.material ? (bk.material.length + " 字") : "无资料") + '</div>';
    }
    // B9（2026-09-12）：分块通读有片段提取失败时，给一条**持久**提示。
    // 此前失败的痕迹只存在于一闪而过的进度行/toast 里，用户事后无从得知，
    // 那几章就永远不会被教到（进度条还照样显示 100%）。提示放在卡片上随时可见，
    // 并指向已有的「↻ 重生成大纲」修复入口。
    if (outline && outline._partial && outline._partial.failed) {
      h += '<div class="course-warn" title="分块通读时有片段提取失败，本大纲缺少对应章节">⚠️ 大纲不完整：' +
        outline._partial.failed + '/' + outline._partial.total + ' 段未提取成功，点「↻ 重生成大纲」可补全</div>';
    }
    h += '</div><div class="course-actions">';
    h += '<button type="button" class="ghost-btn small course-rename" data-bid="' + escapeHtml(bk.id) + '" title="重命名课程">✎</button>';
    h += '<button type="button" class="ghost-btn small course-group" data-bid="' + escapeHtml(bk.id) + '" title="群聊复盘">💬</button>';
    h += '<button type="button" class="book-del course-del" data-bid="' + escapeHtml(bk.id) + '" title="删除课程">✕</button></div></div>';
    return h;
  }

  /** 展开体里的章节列表（每章：标题行 + 课时列表） */
  function chapterListHtml(bk, prog, isActive) {
    let h = "";
    ((bk.outline && bk.outline.chapters) || []).forEach((ch, ci) => {
      // 章节进度 = 该章「已完成课时的核心知识点数」÷ 该章「全部核心知识点数」
      let chDoneKp = 0, chTotalKp = 0, chHasActive = false;
      (ch.lessons || []).forEach((ls) => {
        const st = (prog[ls.id] && prog[ls.id].status) || "not_started";
        const kp = (Array.isArray(ls.keyPoints) && ls.keyPoints.length) ? ls.keyPoints.length : 1; // 无 keyPoints 按 1 兜底
        chTotalKp += kp;
        if (st === "completed") chDoneKp += kp;
        if (isActive && ls.id === S.currentLessonId) chHasActive = true;
      });
      const chPct = chTotalKp ? Math.round(chDoneKp / chTotalKp * 100) : 0;
      // 含当前课时的章默认展开，否则收起
      const chOpenCls = chHasActive ? " open" : "";
      const chArrow = chHasActive ? "▼" : "▶";
      const chName = ch.title || ("第 " + (ci + 1) + " 章");
      h += '<div class="cc-chapter' + chOpenCls + '">';
      h += '<div class="cc-ch-title" data-chidx="' + ci + '" title="点击展开/收起">' +
        '<span class="cc-ch-arrow">' + chArrow + '</span>' +
        '<span class="cc-ch-name">' + escapeHtml(chName) + '</span>' +
        '<span class="cc-ch-bar"><i style="width:' + chPct + '%"></i></span>' +
        '<span class="cc-ch-pct">' + chPct + '%</span>' +
        '<span class="cc-ch-count">' + chDoneKp + '/' + chTotalKp + '</span>' +
        '</div>';
      // 课时列表（收起时隐藏）
      h += '<div class="cc-ch-lessons">';
      (ch.lessons || []).forEach((ls) => {
        const lid = ls.id;
        const st = (prog[lid] && prog[lid].status) || "not_started";
        const isCurLesson = isActive && lid === S.currentLessonId;
        const isSelected = isActive && lid === S.selectedLessonId && !isCurLesson;
        // 课时状态由图标表达（○未开始 / ●进行中 / ☕已下课 / ✓已学完）；进度只在课程/章节级按"已学完占比"展示
        let stIcon = "○", stCls = "pending", stText = "未开始";
        if (st === "completed") { stIcon = "✓"; stCls = "done"; stText = "已学过"; }
        else if (st === "ended") { stIcon = "☕"; stCls = "ended"; stText = "已下课"; }
        else if (isCurLesson) { stIcon = "●"; stCls = "active"; stText = "进行中"; }
        else if (isSelected) { stIcon = "◉"; stCls = "selected"; stText = "已选中"; }
        const canMarkComplete = st === "ended";
        h += '<div class="cc-lesson ' + stCls + (isCurLesson ? " current" : "") + (isSelected ? " selected" : "") + '" data-lid="' + escapeHtml(lid || "") + '" data-bid="' + escapeHtml(bk.id) + '" data-completed="' + (st === "completed" ? "1" : "0") + '">' +
          '<span class="cc-dot">' + stIcon + '</span>' +
          '<span class="cc-ltitle">' + escapeHtml(ls.title || "") + '</span>' +
          '<span class="cc-status">' + stText + '</span>' +
          (canMarkComplete ? '<button type="button" class="cc-mark-complete" data-lid="' + escapeHtml(lid || "") + '" title="确认已掌握，标记为已完成">✓</button>' : "") +
          '<button type="button" class="cc-lesson-source" data-lid="' + escapeHtml(lid || "") + '" data-bid="' + escapeHtml(bk.id) + '" title="查看本节课原文（不消耗 token）">📄</button>' +
          '</div>';
      });
      h += '</div>'; // .cc-ch-lessons
      h += '</div>'; // .cc-chapter
    });
    return h;
  }

  /** 课程卡展开体：操作栏 + 章节列表（或"暂无大纲"提示） */
  function courseBodyHtml(bk, prog, isActive) {
    const outline = bk.outline;
    // 展开体顶部操作栏：复盘 + 原文；「清空对话」仅对当前课程显示（低频操作放侧栏，不占输入区）
    const rvInfo = isActive ? reviewEntryInfo() : null;
    let h = '<div class="course-body"><div class="course-body-actions">' +
      '<button type="button" class="ghost-btn small course-regen-outline" data-bid="' + escapeHtml(bk.id) + '" title="根据当前资料重新生成 / 修复大纲（课程结构按新大纲重排）">↻ 重生成大纲</button>' +
      (isActive ? '<button type="button" class="ghost-btn small course-clear-chat" data-bid="' + escapeHtml(bk.id) + '" title="清空当前课时/教材对话">🗑 清空对话</button>' : '') +
      (rvInfo ? '<button type="button" class="ghost-btn small course-spaced-review" data-bid="' + escapeHtml(bk.id) + '" title="跨课间隔复习：薄弱知识点 + 近期错题">' + escapeHtml(rvInfo) + '</button>' : '') +
      '<button type="button" class="ghost-btn small course-review" data-bid="' + escapeHtml(bk.id) + '" title="复盘学习过程（仅查看聊天记录）">🔍 复盘学习记录</button>' +
      '<button type="button" class="ghost-btn small course-source" data-bid="' + escapeHtml(bk.id) + '" title="查看原文（只读，不消耗 token）">📄 查看原文</button>' +
      '</div>';
    // 大纲生成提示：确定性按章节合并是主路径（稳定、按原章节、不依赖 AI）。
    // 仅当 AI 全局建议增强成功时给出轻量中性提示；不再显示「综合失败」红条。
    if (outline && outline._aiAdvice) {
      h += '<div class="cc-advice-ok">✓ 大纲已按教材原章节生成，并附带 AI 学习路线建议。</div>';
    }
    h += (outline && outline.chapters)
      ? chapterListHtml(bk, prog, isActive)
      : '<div class="cc-no-outline">暂无大纲 · 展开后点「↻ 重生成大纲」重试，或 📤 重新上传资料</div>';
    h += '</div>'; // .course-body
    return h;
  }

  function renderBookList() {
    const q = (state.bookQuery || "").trim().toLowerCase();
    const shown = q
      ? S.library.filter((bk) => ((bk.title || "") + " " + (bk.material || "")).toLowerCase().indexOf(q) >= 0)
      : S.library;
    els.bookEmpty.classList.toggle("hidden", shown.length > 0);
    els.bookList.innerHTML = "";
    shown.forEach((bk) => {
      const isActive = S.currentBook && S.currentBook.id === bk.id;
      const isExpanded = expandedCourses.has(bk.id);
      const prog = courseProgress(bk);
      const div = document.createElement("div");
      div.className = "course-card" + (isActive ? " active" : "") + (isExpanded ? " expanded" : "");
      div.dataset.bid = bk.id;
      div.innerHTML = courseHeaderHtml(bk, prog, isActive, isExpanded) +
        (isExpanded ? courseBodyHtml(bk, prog, isActive) : "");
      els.bookList.appendChild(div);
    });
    bindBookListEvents();
  }

  // 绑定课程树上的交互事件（20260913 从 renderBookList 拆出）。
  // 每次重渲染后都要重绑：旧节点随 innerHTML="" 一起丢弃，所以监听器不会累积。
  function bindBookListEvents() {
    // 绑定事件：展开/收起、选课、群聊、删除、点课时
    els.bookList.querySelectorAll(".course-head").forEach((el) => {
      el.addEventListener("click", (e) => {
        // 点操作按钮不触发展开/收起（头部只有 ✎💬✕）
        if (e.target.closest(".course-rename") || e.target.closest(".course-group") || e.target.closest(".course-del")) return;
        const bid = el.dataset.bid;
        if (expandedCourses.has(bid)) expandedCourses.delete(bid); else expandedCourses.add(bid);
        renderBookList();
      });
    });
    els.bookList.querySelectorAll(".course-group").forEach((btn) => {
      btn.addEventListener("click", () => {
        const bid = btn.dataset.bid;
        // 其他课程在上课时，不允许查看别的课程群聊（先下课）
        if (S.activeSessionBookId && S.activeSessionBookId !== bid) {
          const b = S.library.find((x) => x.id === S.activeSessionBookId);
          alert("「" + (b ? b.title : "当前课程") + "」还在上课中，请先点「📚 下课」结束本节课，再查看其他课程的群聊。");
          return;
        }
        // 先切换到该课程，再打开群聊
        if (!S.currentBook || S.currentBook.id !== bid) selectBook(bid);
        group.openGroup(false);
      });
    });
    els.bookList.querySelectorAll(".course-spaced-review").forEach((btn) => {
      btn.addEventListener("click", () => {
        // 入口只对激活课程渲染；其他课在上则先下课（startLesson 内的课时锁会兜底拦截）
        if (S.activeSessionBookId && S.activeSessionBookId !== btn.dataset.bid) {
          alert("请先点「📚 下课」结束当前课时，再开始复习课。");
          return;
        }
        startLesson("__review__");
      });
    });
    els.bookList.querySelectorAll(".course-del").forEach((btn) => {
      btn.addEventListener("click", (e) => { e.stopPropagation(); deleteBook(btn.dataset.bid); return; });
    });
    // 重生成大纲：根据当前资料重建章节/知识点目录（课程结构按新大纲重排）
    els.bookList.querySelectorAll(".course-regen-outline").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const bk = S.library.find((b) => b.id === btn.dataset.bid);
        if (!bk) return;
        if (!S.currentBook || S.currentBook.id !== bk.id) selectBook(bk.id); // 切到该书（会重渲染，按钮被重建）
        // 重渲染后重新抓取可见按钮引用，避免操作到已脱离 DOM 的旧按钮
        // B11：不要把 id 拼进选择器 —— id 含引号/方括号时 querySelector 会抛 SyntaxError，
        // 整个点击处理直接死掉。改用 dataset 过滤（纯字符串比较，对任何 id 都安全）。
        const liveBtn = Array.from(els.bookList.querySelectorAll(".course-regen-outline"))
          .find((b) => b.dataset.bid === bk.id) || btn;
        // 旧课时聊天键的清理已上收至 generateOutline() 成功分支（仅删孤儿键），
        // 这里不再提前删除，避免生成失败导致旧对话丢失而大纲未更新。
        // 立即可见的「生成中」状态：长书分块综合耗时较长，让用户一眼知道在干活（不再靠一闪而过的 toast 判断）
        liveBtn.disabled = true;
        liveBtn.textContent = "⏳ 生成中…";
        setBusy(true);
        try {
          // B9/B10：只有真的成功才报成功（失败/取消时本函数已给出对应提示）
          if (await generateOutline()) toastOutlineResult("大纲已重新生成");
        } catch (e) {
          toast("大纲重生成失败：" + friendlyApiError(e), 4000);
        } finally {
          setBusy(false);
          renderBookList(); // 重渲染恢复按钮原样
        }
      });
    });
    // 重命名：双击课程名 或 点 ✎ 按钮 → 内联重命名
    function startRename(bid) {
      // B11：同上，改用 dataset 过滤
      const card = Array.from(els.bookList.querySelectorAll(".course-card"))
        .find((c) => c.dataset.bid === bid);
      if (!card) return;
      const nameEl = card.querySelector(".course-name");
      if (!nameEl) return;
      const bk = S.library.find((b) => b.id === bid);
      if (!bk) return;
      const currentName = bk.title || "未命名课程";
      const input = document.createElement("input");
      input.type = "text";
      input.value = currentName;
      input.className = "course-rename-input";
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      const finishRename = () => {
        const newName = input.value.trim() || currentName;
        if (newName !== currentName && bk) {
          // 阻止改名到已存在的同名课程：标题同时是记忆画像的键，重名会导致记忆错配/孤儿化
          const dup = S.library.find((b) => b.id !== bk.id && (b.title || "") === newName);
          if (dup) {
            toast("已存在同名课程「" + newName + "」，为避免记忆串档，改名已取消");
          } else {
            migrateMemoryTopicKey(bk, currentName, newName);
            bk.title = newName;
            saveLibrary();
          }
        }
        renderBookList(); // 重新渲染恢复 DOM
      };
      input.addEventListener("blur", finishRename);
      input.addEventListener("keydown", (ke) => { if (ke.key === "Enter") { ke.preventDefault(); input.blur(); } if (ke.key === "Escape") { input.value = currentName; input.blur(); } });
    }
    els.bookList.querySelectorAll(".course-name").forEach((el) => {
      el.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const card = el.closest(".course-card");
        if (card) startRename(card.dataset.bid);
      });
    });
    els.bookList.querySelectorAll(".course-rename").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        startRename(btn.dataset.bid);
      });
    });
    // 🔍 复盘：仅查看聊天记录，只读，不解锁上课状态、不影响当前课
    els.bookList.querySelectorAll(".course-review").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openReview(btn.dataset.bid);
      });
    });
    // 📄 查看原文：只读浏览，纯本地切片，不消耗 token（不受上课锁限制）
    els.bookList.querySelectorAll(".course-source").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        sourceViewer.open(btn.dataset.bid);
      });
    });
    // 🗑 清空对话：仅当前课程侧栏出现，走原 newChat 逻辑（在课→清课时对话；空闲→清教材对话）
    els.bookList.querySelectorAll(".course-clear-chat").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const bid = btn.dataset.bid;
        if (!S.currentBook || S.currentBook.id !== bid) { toast("请先切换到该课程再清空对话"); return; }
        clearCurrentChat();
      });
    });
    // 章标题点击 → 折叠/展开该章的课时列表
    els.bookList.querySelectorAll(".cc-ch-title").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const chapter = el.closest(".cc-chapter");
        if (chapter) chapter.classList.toggle("open");
        const arrow = el.querySelector(".cc-ch-arrow");
        if (arrow) arrow.textContent = chapter.classList.contains("open") ? "▼" : "▶";
      });
    });
    // 点击展开中的课时 → 选中该课时并展示内容（不自动上课，用户需点「📚 上课」才进入课堂）
    els.bookList.querySelectorAll(".cc-lesson[data-lid]").forEach((el) => {
      el.addEventListener("click", (e) => {
        // 点 📄 → 查看本节课原文（零 token），不进入上课
        const srcBtn = e.target.closest(".cc-lesson-source");
        if (srcBtn) {
          e.stopPropagation();
          sourceViewer.open(srcBtn.dataset.bid, srcBtn.dataset.lid);
          return;
        }
        // 点 ✓ → 标记为已完成
        const markBtn = e.target.closest(".cc-mark-complete");
        if (markBtn) {
          e.stopPropagation();
          markLessonComplete(markBtn.dataset.lid);
          return;
        }
        const bid = el.dataset.bid;
        const lid = el.dataset.lid;
        if (!bid || !lid) return;
        // 如果已有课程在上课中，且点的不是当前书 → 拦截（必须先下课才能切课浏览）
        if (S.activeSessionBookId && S.activeSessionBookId !== bid) {
          const b = S.library.find((x) => x.id === S.activeSessionBookId);
          alert("「" + (b ? b.title : "当前课程") + "」还在上课中，请先点「📚 下课」结束本节课，再切换到其他课程。");
          return;
        }
        // 切到该书（如果还没选中的话）
        if (!S.currentBook || S.currentBook.id !== bid) selectBook(bid);
        // 上课中：点别的课只高亮预览（不切入、不清聊天），点当前课无操作
        if (S.currentLessonId) {
          if (lid === S.currentLessonId) return;
          S.selectedLessonId = lid;
          renderBookList(); // 侧栏高亮「已选中」，聊天区保持当前课不动
          return;
        }
        // 检查是否已学过 → 友好提示
        const lessonProg = loadLessonProg();
        const lessonSt = (lessonProg[lid] && lessonProg[lid].status) || "not_started";
        if (lessonSt === "completed") {
          if (!confirm("📝 这节课已经学过啦！\n\n再次「上课」会衔接上次进度继续复习，不会覆盖学习记录；想彻底重学可在课堂里点「清空对话」。要继续吗？")) return;
        }
        // 选中该课时（浏览模式，不触发 startLesson）
        S.selectedLessonId = lid;
        renderBookList();       // 高亮选中的课时
        showLessonPreview(lid); // 主区域展示该课时的资料预览
      });
    });
  }

  // 课程大纲不再单独渲染：课时列表与进度已内联在左侧课程卡（renderBookList）中，
  // 原 renderOutline（依赖 index.html 中不存在的 #outlineList 元素）为死代码，已删除。
  // parseOutlineJson 仍被 generateOutline 使用。

  // ---- 章节位置索引（纯前端，不消耗 token）----
  // 在大纲生成后调用：按章名在原文中定位每章/每课的字符起止位置（实现已抽到
  // js/outline.js 的 indexChapterPositions 纯函数，目录免疫：书首带 ](#锚点) 的
  // 目录行不会被误当正文标题）。后续「查看原文」直接用偏移量切出真迹。

  // 长书通读：逐段读真实文本提取 → 全局综合为统一大纲（含教学路线 + 推导脉络）
  // 解析「全局建议增强」结果：接受 { teachingRoute?, globalDerivation?, advice? }
  function parseOutlineAdvice(text) {
    if (!text) return null;
    let s = String(text).trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b < 0 || b <= a) return null;
    s = s.slice(a, b + 1);
    try {
      const o = JSON.parse(s);
      if (o && (o.teachingRoute || o.globalDerivation || o.advice)) return o;
      return null;
    } catch (e) { return null; }
  }

  async function generateOutlineFullBook(material) {
    const chunks = splitBookIntoChunks(material);
    const role0 = roles.currentRole();
    const roleSys = (role0 && role0.persona ? "【你的角色人设】\n" + role0.persona + "\n\n" : "") +
                    (role0 && role0.voice ? "【你的说话语气与表达方式】\n" + role0.voice + "\n\n" : "");
    // 预期耗时提示：每段一次提取 + 末尾一次全局建议；每段约 8 万字符 prefill + 最长 65536
    // token 输出，在 DeepSeek 上通常 1~2 分钟。给保守区间，避免用户以为卡死中途强关。
    const chunkCount = chunks.length;
    const estMinLow = Math.max(2, Math.round(chunkCount * 0.8));
    const estMinHigh = Math.round(chunkCount * 2);
    showOutlineProgress("老师正在研读教材备课中…", 0, chunkCount,
      `全书共 ${chunkCount} 个片段，需按原文章节逐段提取教学要素。` +
      `大纲生成通常需要约 ${estMinLow}–${estMinHigh} 分钟（视模型速度），请耐心等待；` +
      `可点下方「⏹ 停止生成」提前中止。`);
    const partials = [];
    const failedRanges = []; // B9：记录失败片段，最后如实告知用户，别让缺章悄悄过去
    let cancelled = false;   // B10：用户点了「停止生成」→ 整轮放弃，不产出半成品大纲
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const chunkMsgs = [
        { role: "system", content: roleSys + APP_CONFIG.outlineChunkRules },
        { role: "user", content: "【资料片段（全书第 " + (i + 1) + "/" + chunks.length + " 段，字符区间 [" + c.start + ", " + c.end + "]）】\n" + c.text + "\n\n请基于这段真实文本提取教学要素，返回 JSON。" },
      ];
      let outcome = { ok: false, reason: "error" };
      try {
        outcome = classifyChunkReply(await api.callWithRetry(chunkMsgs, 2, { maxTokens: APP_CONFIG.limits.outlineOutputMaxTok, slot: "outline" }), c);
      } catch (e) {
        // B10：中止要**跳出整个循环**，否则「停止」每点一次只掐掉一个片段请求，
        // 循环立刻又发下一段 —— 用户得点 N 次才能停下（此前就是这样）。
        if (e && e.name === "AbortError") { cancelled = true; break; }
        outcome = { ok: false, reason: "error" };
      }
      // B9（2026-09-12）：解析类失败值得再试一次 —— callAPIRetry 只在**抛异常**时重试，
      // 「返回了但解析不出课时」它不管，而这正是静默丢章节的主因。异常类已经重试过两轮，
      // 不再叠加（否则最坏 4 次 × 超时，白等）。
      if (!outcome.ok && outcome.reason !== "error") {
        try {
          outcome = classifyChunkReply(await api.callWithRetry(chunkMsgs, 1, { maxTokens: APP_CONFIG.limits.outlineOutputMaxTok, slot: "outline" }), c);
        } catch (e) {
          if (e && e.name === "AbortError") { cancelled = true; break; }
        }
      }
      if (outcome.ok) partials.push(outcome.partial);
      else failedRanges.push({ start: c.start, end: c.end, title: c.title || null, reason: outcome.reason });
      showOutlineProgress("正在通读全书", i + 1, chunks.length,
        "第 " + (i + 1) + "/" + chunks.length + " 段提取完成，累计 " + partials.length + " 个有效片段" +
        (failedRanges.length ? "，" + failedRanges.length + " 段失败" : "") + "…");
      toast("正在通读全书生成大纲：" + (i + 1) + "/" + chunks.length + " 段已处理…", 1500);
    }
    // B10：用户主动停止 → 整轮作废（不合并、不落盘）。必须放在「各段均失败」之前判断，
    // 否则会把"用户取消"误报成"全部失败"。
    if (cancelled) {
      const stopErr = new Error("已停止生成");
      stopErr.cancelled = true;
      throw stopErr;
    }
    if (!partials.length) throw new Error("全书各段提取均失败（" + failedRanges.length + " 段）");

    // 主路径：确定性按原章节合并（零额外 token、稳定、严格遵循教材原章节框架）。
    // 不依赖 AI：直接把同章标题的片段课时归并，超长章自动拆 (1)(2)(3)。
    showOutlineProgress("正在按原章节合并目录", chunks.length, chunks.length,
      "已提取 " + partials.length + " 段，正在按教材原文章节归并课时（超长章节拆分为 (1)(2)(3)）…");
    const merged = mergePartialsByChapter(partials);
    if (!merged || !merged.chapters || !merged.chapters.length) {
      throw new Error("按原章节合并无法生成有效大纲（可能教材无清晰章节结构，建议改用更规整的排版）");
    }
    // B9：如实标记「这份大纲是不完整的」。不能只靠一闪而过的进度行/toast ——
    // 用户事后必须还能看到缺在哪，否则那几章永远不会被教到（进度看着还是 100%）。
    // 只记**区间**而不记正文，避免把大纲写成第二份教材把 localStorage 撑爆。
    if (failedRanges.length) {
      merged._partial = {
        failed: failedRanges.length,
        total: chunks.length,
        ranges: failedRanges.map((r) => ({ start: r.start, end: r.end, title: r.title, reason: r.reason })),
      };
    }

    // 可选增强（best-effort，不阻塞主结果）：基于「章节骨架摘要」（仅含章/课标题、不含正文、
    // 体积小）让模型补全 teachingRoute / globalDerivation / advice 等全局元信息。
    // 失败或返回空都不影响已生成的章节目录——大纲本身已完整可用，无需再喂全长文做「综合」。
    try {
      const skeleton = merged.chapters.map((ch) => ({ chapter: ch.title, lessons: (ch.lessons || []).map((l) => l.title) }));
      const reply3 = await api.call([
        { role: "system", content: roleSys + APP_CONFIG.outlineAdviceRules },
        { role: "user", content: "【已按教材原文章节整理好的大纲骨架（仅含章/课标题，不含正文）】\n" + JSON.stringify(skeleton) + "\n\n请基于这些标题归纳全书教学路线与学习建议，返回 JSON。" },
      ], { maxTokens: APP_CONFIG.limits.outlineAdviceMaxTok, slot: "outline" });
      const advice = parseOutlineAdvice(reply3);
      if (advice) {
        if (advice.teachingRoute) merged.teachingRoute = advice.teachingRoute;
        if (advice.globalDerivation) merged.globalDerivation = advice.globalDerivation;
        if (advice.advice) merged.advice = advice.advice;
        merged._aiAdvice = true;
      }
    } catch (e) {
      console.warn("大纲全局建议增强未成功（不影响已按章节生成的目录）：", e);
    }
    return merged;
  }

  // 返回 true = 大纲真的更新成功；false = 失败 / 被取消（调用点据此决定提示文案，B10）
  async function generateOutline() {
    if (!S.currentBook) return false;
    const material = (S.currentBook.material || "").trim();
    if (!material) { toast("先上传或粘贴学习资料，再生成大纲～"); return false; }
    setBusy(true);
    // 重生成前先记录旧大纲的课时 id（仅用于成功后的孤儿键清理，绝不提前删除，
    // 避免「生成失败 → 旧对话丢失而大纲未更新」的数据丢失）。
    const oldLessonIds = (S.currentBook.outline && S.currentBook.outline.chapters)
      ? S.currentBook.outline.chapters.flatMap((ch) => (ch.lessons || []).map((ls) => (ls && ls.id) || null).filter(Boolean))
      : [];
    try {
      let data;
      if (material.length <= APP_CONFIG.limits.outlineWholeBookMaxChars) {
        // 整书优先（仅「短资料」快捷路径）：全书一次性发给模型，LLM 看到完整内容，
        // 产出全局连贯的大纲；仅当书真正超出有效上下文才退回分块通读（见 else）。
        // 必须显式给足输出预算：整书一次要吐出全书章节+课时 JSON，若沿用 provider
        // 默认 max_tokens（DeepSeek 默认 4096）会吐到一半被截断 → JSON 不完整 →
        // 解析失败，表现为「大纲生成不了」（2026-09-08 修复）。
        // B8b（2026-09-12）：整书直读原先只有一句 2.5 秒 toast，之后界面毫无反馈
        // （setBusy 仅禁用按钮），而它恰恰是最大的一次请求（输入可达 19.2 万字、
        // 输出预算 6.5 万 token）—— 用户容易以为卡死而中途强关，表现成"大纲生成不了"。
        // 这里复用分块路径的进度浮层：不确定态动画 + 已等待计时；等待上限如实取自
        // 同一个超时预算（不另编数字），与「所有时长/长度预算都派生」的约定一致。
        const wholeBookTimeoutMs = apiTimeoutMs(APP_CONFIG.limits.outlineOutputMaxTok, APP_CONFIG.apiTimeout);
        const timeoutMin = Math.round(wholeBookTimeoutMs / 60000);
        showOutlineProgress("老师正在研读教材备课中…", 0, 0,
          "全书一次直读（约 " + (material.length / 10000).toFixed(1) + " 万字）。" +
          "预计 1~" + timeoutMin + " 分钟（视模型速度），超过 " + timeoutMin +
          " 分钟会自动中止；也可点下方「⏹ 停止生成」提前中止。");
        const reply = await api.callWithRetry([
          { role: "system", content: buildSystemPrompt("intro", buildPromptCtx("intro")) + "\n\n" + APP_CONFIG.outlineRules },
          { role: "user", content: "【学习资料】\n" + material + "\n\n请按大纲规则，把这份资料拆成合理的章节与课时，返回 JSON。" },
        ], 2, { maxTokens: APP_CONFIG.limits.outlineOutputMaxTok, slot: "outline" });
        data = parseOutlineJson(reply);
        // 截断诊断：区分「模型没吐完」与「模型吐了但不合格式」，否则两者都只显示
        // 「结果无法解析」，无法定位。
        if (!data && api.finishReason() === "length") {
          throw new Error("模型输出被 max_tokens 截断（大纲 JSON 没吐完）。请到 config.js 调大 maxOutputTokens，或把资料拆小后再生成。");
        }
      } else {
        // 长书：分块通读全书真实文本，逐段提取后全局综合（不再只看开头 8000 字）
        toast("正在通读全书生成大纲（长书会分多段提取，请稍候）…");
        data = await generateOutlineFullBook(material);
      }
      if (data) {
        ensureLessonIds(data); // 补全课时 id，避免缺口导致点课时无效
        S.currentBook.outline = data;
        // 纯前端：按章名在原文中定位每章/每课的字符位置（零 token）
        indexChapterPositions(S.currentBook.material, S.currentBook.outline);
        // 块级锚定传递：用课时自身的 title/focus/keyPoints 在章区间内回搜原文，
        // 把切片重新吸附到知识点真正所在的区段，避免"装错位置"导致漏读（零 token）。
        reanchorLessonsByContent(S.currentBook.material, S.currentBook.outline);
        saveLibrary();
        renderBookList();
        // 重生成成功后才清理旧课时聊天键：只删「新大纲不再包含」的孤儿键，
        // 既避免「生成失败 → 旧对话丢失」的数据丢失，也保留仍然有效的课时进度。
        const newLessonIdSet = new Set();
        (S.currentBook.outline.chapters || []).forEach((ch) => (ch.lessons || []).forEach((ls) => { if (ls && ls.id) newLessonIdSet.add(ls.id); }));
        oldLessonIds.forEach((id) => { if (!newLessonIdSet.has(id)) localStorage.removeItem(bookLS(S.currentBook.bookKey, "lesson_" + id)); });
        return true; // B10：调用点据此决定说"已生成"还是别的（别再一律报成功）
      } else {
        toast("大纲生成结果无法解析，请重试。");
        return false;
      }
    } catch (e) {
      // B10（2026-09-12）：本函数**自己吞掉了异常**（不 rethrow），于是调用点的 catch 从不会触发，
      // 而调用点紧接着还会 toast 一句"大纲已重新生成" —— 失败被后置的成功提示覆盖成成功。
      // 现在改为返回布尔值，由调用点按真实结果决定说什么。
      if ((e && e.cancelled) || (e && e.name === "AbortError")) {
        toast("已停止生成，大纲未改动", 2600);
      } else {
        toast("大纲生成失败：" + friendlyApiError(e));
      }
      return false;
    } finally {
      hideOutlineProgress();
      setBusy(false);
    }
  }

  // ---- 卡片事件委托（开始答题 + 收藏按钮 + 下一节）----
  // ---- 消息操作工具条辅助 ----
  function hashStr(s) {
    let h = 0; s = s || "";
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return "h" + (h >>> 0).toString(36);
  }
  function toast(msg, ms) {
    let t = document.getElementById("socratopiaToast");
    if (!t) { t = document.createElement("div"); t.id = "socratopiaToast"; t.className = "socratopia-toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove("show"), ms || 1800);
  }
  // 大纲生成后的成功提示（B9，2026-09-12）：统一一处，别在 4 个调用点各写一遍。
  // 分块通读若有片段提取失败，"大纲已生成"会让人以为拿到的是**完整**大纲 ——
  // 缺的章节就此永远教不到（课程卡上虽有持久提示，但当场也必须说实话）。
  function toastOutlineResult(okMsg) {
    const pt = S.currentBook && S.currentBook.outline && S.currentBook.outline._partial;
    if (pt && pt.failed) {
      toast("⚠️ " + okMsg + "，但有 " + pt.failed + "/" + pt.total +
        " 段未提取成功、缺少对应章节；点「↻ 重生成大纲」可补全", 7000);
    } else {
      toast(okMsg, 2600);
    }
  }
  // 大纲生成持久进度浮层：长书分多段提取时持续显示，避免用户只能看到一闪而过的 toast
  // 大纲生成持久进度浮层：长书分多段提取时持续显示，避免用户只能看到一闪而过的 toast。
  // 2026-09-12 修 B8b：
  //   ① total<=0 = 「无法预知进度」（整书一次直读只有一步）→ 进度条走不确定态动画，
  //      并显示「已等待 mm:ss」。照 config.thinkingPhrases 的思路：数字在动就说明没冻结。
  //      此前整书直读**全程零反馈**（只有 2.5 秒 toast），而它恰恰是发最大单次请求的那条路；
  //      分块兜底路径反而有浮层 —— 属反馈倒挂。
  //   ② 浮层是 fixed/inset:0/z-index:50，会完全遮住页面里的「⏹ 停止」，所以停止按钮
  //      必须做在浮层内（index.html #outlineProgressStop），否则"可随时点停止"是句假话。
  let outlineTickTimer = null;
  function showOutlineProgress(phase, current, total, detail) {
    const ov = document.getElementById("outlineProgressOverlay");
    if (!ov) return;
    ov.classList.remove("hidden");
    const track = ov.querySelector(".outline-progress-track");
    const bar = document.getElementById("outlineProgressBar");
    const det = document.getElementById("outlineProgressDetail");
    const sub = document.getElementById("outlineProgressSub");
    const indeterminate = !(total > 0);
    if (track) track.classList.toggle("indeterminate", indeterminate);
    const pct = indeterminate ? 0 : Math.round((current / total) * 100);
    if (bar) bar.style.width = pct + "%";
    if (sub) sub.textContent = phase || "正在生成大纲";
    const baseText = detail || "准备中…";
    const startedAt = Date.now();
    if (det) det.textContent = baseText;
    clearInterval(outlineTickTimer);
    outlineTickTimer = setInterval(() => {
      if (!det) return;
      const s = Math.floor((Date.now() - startedAt) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      det.textContent = baseText + "（已等待 " + mm + ":" + ss + "）";
    }, 1000);
  }
  function hideOutlineProgress() {
    clearInterval(outlineTickTimer);
    outlineTickTimer = null;
    const ov = document.getElementById("outlineProgressOverlay");
    if (ov) ov.classList.add("hidden");
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast("已复制全文")).catch(() => fallbackCopy(text));
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; ta.style.top = "0"; ta.style.left = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      const done = document.execCommand("copy");
      document.body.removeChild(ta);
      toast(done ? "已复制全文" : "复制失败，请手动选择");
    } catch (e) { toast("复制失败，请手动选择"); }
  }
  // 代码块「一键复制」：复制 <code> 纯文本，并给按钮一个短暂的成功反馈
  function copyCode(btn) {
    const pre = btn.parentElement;
    const code = pre && pre.querySelector("code");
    if (!code) return;
    const text = code.textContent || "";
    const flash = () => {
      const old = btn.textContent;
      btn.textContent = "✓ 已复制";
      setTimeout(() => { btn.textContent = old; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(() => { fallbackCopy(text); flash(); });
    } else { fallbackCopy(text); flash(); }
  }
  // 引用某条 AI 回复去追问：把该条内容摘要预填到输入框
  function quoteMessage(m) {
    if (!S.currentLessonId) { toast("先「📚 上课」才能追问哦"); return; }
    const raw = (m.content || "").replace(/\s+/g, " ").trim();
    const snippet = raw.slice(0, 40);
    const prefix = "关于你刚才说的「" + snippet + (raw.length > 40 ? "…" : "") + "」，我想追问：";
    els.userInput.value = els.userInput.value ? (els.userInput.value + "\n" + prefix) : prefix;
    els.userInput.focus();
  }
  // 重新生成最后一条 AI 回复（不新增一轮交互计数）
  async function regenerateLast() {
    if (!S.currentLessonId) { toast("先「📚 上课」才能重新生成"); return; }
    if (isBusy) return;
    while (messages.length && messages[messages.length - 1].role === "assistant") messages.pop();
    const thinking = startThinking();
    setBusy(true);
    try {
      const trimmed = chatMessagesAutoTrim();
      const reply = await api.call(trimmed.msgs);
      const aq = extractQualityTag(reply);
      stopThinking(thinking, aq.text || "（模型没返回内容，换个问题试试）");
      if (aq.quality && aq.quality !== "none") thinking.quality = aq.quality; // 路线1：把质量挂到该轮 assistant 消息，供下一轮 P1 决策
    } catch (e) {
      const isAbort = e && e.name === "AbortError";
      stopThinking(thinking, isAbort ? "⏹ 已停止生成。" : "⚠️ 重新生成失败：" + friendlyApiError(e));
    } finally {
      saveChat(); setBusy(false); updateContextMeter();
    }
  }

  els.messages.addEventListener("click", (e) => {
    // 代码块「一键复制」按钮
    const copyBtn = e.target.closest(".code-copy");
    if (copyBtn) { copyCode(copyBtn); return; }
    // 消息操作工具条分发（复制 / 重新生成 / 引用追问 / 收入卷宗）
    const tool = e.target.closest(".msg-tool");
    if (tool) {
      const act = tool.dataset.act;
      const msgEl = tool.closest(".msg");
      const idx = parseInt((msgEl && msgEl.dataset.idx) || "", 10);
      const m = (typeof idx === "number" && !isNaN(idx)) ? messages[idx] : null;
      if (act === "copy") { if (m) copyText(m.content || ""); return; }
      if (act === "regen") { regenerateLast(); return; }
      if (act === "quote") { if (m) quoteMessage(m); return; }
      if (act === "collect") {
        if (!m) return;
        const cid = tool.dataset.cid || ("ai_" + hashStr(m.content || ""));
        const collected = toggleCollect(cid, currentTopicKey(), m.content || "");
        tool.textContent = collected ? "★" : "☆";
        tool.title = collected ? "已收入卷宗" : "收入卷宗";
        return;
      }
      return;
    }
    // 开始答题（聊天里的「去答题」卡片）
    const sq = e.target.closest(".start-quiz-btn");
    if (sq) { quiz.openQuiz(); return; }
    // 开始下一节
    const nl = e.target.closest(".next-les-btn");
    if (nl) { startLesson(nl.dataset.lid); return; }
    // 群聊复盘（从知识总结卡重新打开群聊）：带上该总结对应的课时，确保展示/生成的是本节课的新鲜复盘
    const gr = e.target.closest(".group-review-btn");
    if (gr) {
      const sumCard = messages.find((m) => m.card && (m.card.kind === "summary" || m.card.kind === "summaryError"));
      group.openGroup(true, sumCard ? sumCard.card.lid : null);
      return;
    }
    // 收藏/取消收藏
    const cl = e.target.closest(".collect-btn");
    if (cl) {
      const cid = cl.dataset.cid;
      // 找到对应的 summary card 数据
      const cardMsg = messages.find((m) => m.card && m.card.kind === "summary" && m.card.id === cid);
      if (!cardMsg) return;
      const collected = toggleCollect(cid, currentTopicKey(), cardMsg.card.text);
      cl.classList.toggle("collected", collected);
      cl.textContent = collected ? "★ 已收入卷宗" : "☆ 收入卷宗";
      return;
    }
    // 标记为已完成（下课≠完成，用户确认掌握后手动更新章节进度）
    const mcb = e.target.closest(".mark-complete-btn");
    if (mcb) { markLessonComplete(mcb.dataset.lid); return; }
    // 课后笔记（从笔记卡打开笔记浮层）
    const onb = e.target.closest(".open-notes-btn");
    if (onb) { openNotes(onb.dataset.lid); return; }
    // 小结生成失败：重新生成
    const rsb = e.target.closest(".retry-summary-btn");
    if (rsb) { retryLessonEnd(rsb.dataset.lid); return; }
  });

  // ---- 调用 API 传输层 ----
  // 20260912.1：整块迁出至 js/api.js —— 超时派生（B8）、400 降级重试（B6）、
  // 「停止」不算失败（B10）、finish_reason/usage 记录都归它。宿主只做一次装配（见上方），
  // 之后经 api.call / api.callWithRetry / api.abort / api.finishReason 使用。
  // 续学课堂的「API 可见历史」：下课≠学完，续学重在查漏补缺而非重读全部旧对话。
  // 只把最近几轮对话发给老师（更早的由系统提示里的「上次小结 + 长期记忆」替代），
  // 本地聊天记录完整保留。这样续学从轻上下文开始，老师精力(上下文占用)不会被旧对话占满。
  const RESUME_KEEP_HIST_LEN = 12; // 保留最近 12 条 = 6 轮（用户+老师各一条）
  function apiHist() {
    // 排除思考占位（m.thinking）：占位 content 是 HTML，发出去会被模型回显、进而显示成源码
    let hist = messages.filter((m) => !m.thinking && (m.role === "user" || m.role === "assistant"));
    if (resumeContinuationInfo(S.currentLessonId) && hist.length > RESUME_KEEP_HIST_LEN) {
      hist = hist.slice(hist.length - RESUME_KEEP_HIST_LEN);
    }
    return hist;
  }
  // 发送前的自动压缩：
  // 1) 若完整上下文超过软上限，从最久远的对话轮次开始精简历史（保留本地记录）
  // 2) 若系统提示词本身已超限（如超长教材非课时模式），对系统提示中的材料做截断
  // 3) 保证最终 payload 始终可发送，永不阻断用户。只有「下课」才结束对话。
  // 返回 { msgs, compressed: bool, droppedTurns: number }
  // 缓存优化核心：高频 chat 路径把「静态段」放 messages[0]、「动态段」放第二条 system。
  // 同一节课内静态段（角色/规则/教材切片/大纲）逐字节稳定 → provider 前缀缓存命中，
  // 仅动态段（熟悉度/番茄提示/续学/记忆/画像）每轮可能变化，且不破坏静态前缀的缓存资格。
  function chatMessagesAutoTrim() {
    let hist = apiHist();
    const ctx = buildPromptCtx("chat");
    const built = buildChatMessages(ctx); // { head, tail, staticSystem, dynamicSystem }
    const MAX_TOTAL = CTX_HARD_LIMIT; // 硬上限 token
    const TARGET = CTX_SOFT_LIMIT;     // 目标 token

    // 截断只针对静态段里的教材材料（角色/规则无法安全截断）；触发极少（仅超长材料）
    let workingStatic = built.staticSystem;
    const dynSys = built.dynamicSystem || "";
    let sysTok = estimateTokens(workingStatic) + (dynSys ? estimateTokens(dynSys) : 0);
    if (sysTok > TARGET) {
      const newStatic = truncateMaterialInPrompt(workingStatic, TARGET * 0.7); // 给历史留空间
      if (newStatic !== workingStatic) {
        workingStatic = newStatic;
        sysTok = estimateTokens(workingStatic) + (dynSys ? estimateTokens(dynSys) : 0);
      }
      // 截断后仍超限（角色人设/规则本身太长）→ 只能压历史
    }

    // 消息排布交给纯函数 assembleChatMessages（js/core.js，有单测覆盖）。
    // 【缓存实况，20261126 改为 tail 布局】前缀缓存只认"从第 0 个 token 起完全相同的前缀"。
    // 旧布局 [静态][易变][历史…] 下，易变段每轮都变（policyHint 每轮都变），从它往后
    // 的历史对话全部 miss。现在易变段挪到历史【之后、本轮用户消息之前】：
    //   已命中：静态段（规则 + 教材切片 + 大纲 + 人设）+ 到上一轮为止的全部历史 ——
    //          而后半截正是随课时增长的那部分，所以越长的对话受益越大；
    //   未命中：本轮易变段 + 本轮用户消息 + 本轮回复（本来也不可能命中）。
    // 想回退成旧行为（某家服务商拒收"非首位的 system 消息"时）：把 config.js 的
    // cacheLayout 改成 "head" 即可，功能不受影响、只是命中率回落。
    // 效果看控制台的 [Socratopia][usage] 或设置面板「本次会话用量」，不要凭感觉判断。

    // ---- 裁剪历史直到低于目标 ----
    const full = () => sysTok + estimateTokens(hist.map((m) => m.content || "").join("\n"));
    let dropped = 0;
    let systemNote = "";
    while (full() > TARGET && hist.length > 2) { // 至少保留最近 1 轮
      hist = hist.slice(2); // 一次丢一整轮（用户+老师）
      dropped += 1;
    }
    if (dropped > 0) {
      systemNote = "（注：本节课前面 " + dropped + " 轮对话内容较多，老师这一轮先不回看最早的部分，不影响你本地的完整聊天记录。）";
    }

    // ---- 终极兜底 —— 还超硬上限继续激进裁剪 ----
    while (full() > MAX_TOTAL && hist.length > 1) {
      hist = hist.slice(2);
      dropped += 1;
      systemNote = "⚠️ 当前对话内容非常长，老师只能看到最近的部分。建议点「📚 下课」收尾，开启新一节课。";
    }

    // 内部消息 → API 消息的唯一转换点：带图且原图仍在内存里的 user 消息，content 在这里
    // 才变成 [{type:"text"},{type:"image_url"}] 块数组；其余消息仍是纯字符串。
    // 放在最外层的 reason：js/api.js 至今不需要知道图片的存在。
    const assembled = assembleChatMessages({
      staticSystem: workingStatic,
      dynamicSystem: dynSys,
      systemNote: systemNote,
      hist: toApiMessages(hist),
      layout: APP_CONFIG.cacheLayout,
    });
    return { msgs: assembled.msgs, compressed: dropped > 0, droppedTurns: dropped };
  }

  // truncateMaterialInPrompt 已抽至 js/core.js（SocratopiaCore.truncateMaterialInPrompt）


  function setBusy(b) {
    isBusy = b;
    // 非上课中（已下课/浏览态）时，即便 b=false 也不解锁输入/发送/下课
    els.sendBtn.disabled = b || !(S.currentLessonId || state.intro);
    els.genIntro.disabled = b;
    els.lessonEnd.disabled = b || !(S.currentLessonId || state.intro);
    // 课程编辑模态框的「保存并开始学习」也要一起禁用（20260913 修）：
    // 上传大文件（PDF/EPUB）时解析要跑十几秒到几十秒，期间 setBusy(true) —— 但此前只管上面
    // 那几个按钮。用户等不及点保存 → 读到的还是【空】材料（解析结果还没写回 textarea）
    // → addBook(title, "") 建出一门空课程并关掉模态框；解析完成后文本只落在已关闭的输入框里，
    // 教材白传且没有任何提示。这是唯一一条会让用户白干一场的路径。
    els.cemSave.disabled = b;
    chips.forEach((c) => (c.disabled = b || !(S.currentLessonId || state.intro)));
  }

  // ---- 智能思考指示器（人设轮换文案 / 超时提示 / 取消按钮）----
  // 不显示等待秒数（越看越焦虑），改为在几组符合人设的短句间轮流跳动：
  // ① 安抚等待 ② 文案若停住不动，说明主线程已卡死——本身就是「程序没冻」的真信号。
  // 等待文案轮换的三个常量与决策数学已上收 js/dom.js（20260913）：
  // 此前 app.js 与 js/group.js 各写一遍完全相同的时序，调阈值时漏改一处就会出现
  // "群聊 12 秒报警、一对一 20 秒"这类看不出来的不一致。见 js/dom.js 的 nextThinkingPhase。
  // 当前角色的思考文案：优先用角色卡里的 thinkingPhrases，没有则用 config 默认。
  function thinkingPhrasesForRole() {
    const role = (els.roleSelect && els.roleSelect.value) || null;
    const custom = role && roles.getRegistry()[role] && roles.getRegistry()[role].thinkingPhrases;
    return (custom && custom.length) ? custom : APP_CONFIG.thinkingPhrases;
  }
  function formatThinkingHtml(phrase, warn) {
    const role = (els.roleSelect && els.roleSelect.value) || "老师";
    const warnHtml = warn
      // 文案刻意保持中性：原来写的是文言腔（"仍在凝神思索……你轻点「⏹ 停止」唤我停笔"），
      // 对三月七这类活泼人设是硬伤——同一个活泼角色等满 12 秒突然说起文言文，
      // 用户会以为换人了。这里没法知道每个角色该怎么说话，就统一说大白话。
      ? '<span class="thinking-warn">（' + escapeHtml(role) + '还在想…如果等太久，多半是网络或接口没响应。可以点「⏹ 停止」中断，稍后再试一次。）</span>'
      : "";
    return '<div class="thinking-wrap">' +
      '<span class="thinking-spinner"></span>' +
      '<span class="thinking-label">' + escapeHtml(phrase) + "</span>" +
      warnHtml +
      "</div>";
  }
  function startThinking() {
    const phrases = thinkingPhrasesForRole();
    const thinking = {
      role: "assistant",
      content: "",
      thinking: { start: Date.now(), phrases, phraseIdx: 0, warn: false, id: "think_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8) },
    };
    thinking.content = formatThinkingHtml(phrases[0], false);
    messages.push(thinking);
    renderMessages();
    thinking.thinking.timer = setInterval(() => {
      const t = thinking.thinking;
      if (!t) return;
      const { idx, warn, changed } = nextThinkingPhase(Date.now() - t.start, phrases.length, t.phraseIdx, t.warn);
      if (!changed) return; // 无变化，不重绘
      t.phraseIdx = idx;
      t.warn = warn;
      thinking.content = formatThinkingHtml(phrases[idx], warn);
      renderMessages();
    }, THINKING_TICK_MS);
    return thinking;
  }
  function stopThinking(thinking, finalContent) {
    if (!thinking || !thinking.thinking) return;
    clearInterval(thinking.thinking.timer);
    if (thinking.thinking._raf) cancelAnimationFrame(thinking.thinking._raf);
    delete thinking.thinking;
    const idx = messages.indexOf(thinking);
    if (idx >= 0) {
      thinking.content = finalContent || "";
      renderMessages();
    }
  }
  // 流式 token 回调——针对旧版两个坑做了防御：
  // ① 首 token 到达即清掉「思考中」文案轮换的 setInterval（它每 2s 会整表 renderMessages，
  //    会抢 DOM、把逐字渲染的节点冲掉，正是「（思考中…）不更新 / 正文写进游离节点」的成因）；
  // ② 用 requestAnimationFrame 把 DOM 写收敛到每帧一次，且只 textContent 追加本帧新到的 delta，
  //    总代价 O(n)，不会像旧版那样每 chunk 重写整段 innerHTML 造成 O(n²) 卡死；
  // ③ 用 data-mid + isConnected 每次重新定位节点，万一期间被重绘也能接上，不会写丢。
  function onStreamToken(thinking, delta) {
    if (!thinking || !thinking.thinking) return;
    const t = thinking.thinking;
    if (!t.streaming) {
      t.streaming = true;
      if (t.timer) { clearInterval(t.timer); t.timer = null; }
      t.partial = delta;
      t._flushed = delta.length;
      renderMessages(); // 仅此一次整重绘：spinner → 流式正文
      return;
    }
    t.partial += delta;
    if (t._raf) return;
    t._raf = requestAnimationFrame(() => {
      t._raf = null;
      const el = els.messages.querySelector('.msg[data-mid="' + t.id + '"] .stream-text');
      if (el && el.isConnected) {
        // 用"剥离内部标记后"的可见文本算增量：stripQualityForDisplay 只会砍掉末尾的
        // QUALITY 标记（含半截），所以可见文本始终是 t.partial 的前缀，
        // 增量单调推进、不会重复追加，仍保持每帧 O(新增) 的代价。
        const shown = stripQualityForDisplay(t.partial);
        const fresh = shown.slice(t._flushed);
        if (fresh) { el.textContent += fresh; t._flushed = shown.length; }
      }
    });
  }

  // ---- 「整理中」卡片：阶段文案递进（方案 C）----
  // 用带老师人设的活泼文案循环切换，给用户等待中的安抚；
  // 副作用：若应用主线程卡死，setInterval 不会触发，文案即停止跳动 → 本身就是「程序没冻」的真信号。
  const PENDING_STAGES = [
    "（正在为你梳理这节课的脉络…）",
    "（把零散的对话，慢慢收拢成线…）",
    "（提炼这一节真正要带走的几句话…）",
    "（顺手拟几道小测验，待会儿考考你…）",
    "（在斟酌措辞，想讲得更透一些…）",
    "（差一点点，把要点串成串…）",
    "（老师还在凝神琢磨，请稍候片刻…）",
    "（快好了，最后润色一下…）",
  ];
  const PENDING_STAGE_MS = 2500; // 每 2.5s 切换一句
  function startPendingCard() {
    stopPendingCard(); // 清掉可能存在的旧计时器，避免叠加
    const card = { role: "system", card: { kind: "pending", text: PENDING_STAGES[0], _pendIdx: 0 } };
    messages.push(card);
    renderMessages();
    card.card._pendTimer = setInterval(() => {
      if (!card.card) return;
      card.card._pendIdx = (card.card._pendIdx + 1) % PENDING_STAGES.length;
      card.card.text = PENDING_STAGES[card.card._pendIdx];
      renderMessages();
    }, PENDING_STAGE_MS);
  }
  function stopPendingCard() {
    const card = messages.find((m) => m.card && m.card.kind === "pending" && m.card._pendTimer);
    if (card) {
      clearInterval(card.card._pendTimer);
      delete card.card._pendTimer;
      delete card.card._pendIdx;
    }
  }

  // ---- 发送（一对一） ----

  /* 上游拒收图片时报错长这样（OpenAI 兼容系的常见几种措辞）：
       "This model does not support image"
       "Invalid content type. image_url is only supported by certain models."
       "messages[1].content[1].type: unsupported value"
     这条分支的意义是：让"贴了一张图"不至于把整节课卡死 —— 认出来之后把历史里的图
     标记为不再发送（imagesBlocked），并在这一轮内自动重发一次纯文字版。 */
  function isNoVisionError(e) {
    const s = String((e && e.message) || e || "");
    return /does not support image|not support.*image|image.*not supported|invalid.*image_url|unsupported.*image|image_url.*unsupported|multimodal|不支持.*图片|图片.*不支持/i.test(s);
  }
  /** 给所有带图的消息打上"模型不收图"的记号，返回被拦下的图片张数。 */
  function blockAllImages() {
    let n = 0;
    messages.forEach((m) => {
      if (m && m.images && m.images.length) { m.imagesBlocked = true; n += m.images.length; }
    });
    return n;
  }

  /* 输出被截断 / 流被掐断时，把真相摆进聊天里。
   * 为什么需要它：chat 曾是**唯一不读 finish_reason 的调用点** —— 大纲（generateOutline）
   * 与下课小结（generateLessonEnd）都读了、也都会明确说明，唯独聊天不读。于是被截断的
   * 老师回复与正常回复长得**一模一样**：气泡停在半句话，没有任何标记。用户只能看到结果、
   * 看不到原因（实际反馈就是一句「前一段对话发生了截断，什么原因？」——这个问题本不该由用户来问）。
   * 与 B1/B6/B7 是同一条教训：**截断必须显式说明**，否则用户只会反复重试或怀疑自己点错了。
   *
   * 走独立的 system 消息，而不是把提示拼进这条回复的正文：apiHist() 只取 user/assistant，
   * system 不入历史，所以它既不会被当成对话内容回灌给模型，也不会污染这条回复本身。
   * 同时把 API 层的两个原因分开说：length = 输出预算用尽；incomplete = 传输被掐断（见 js/api.js）。 */
  function noteIfOutputCut() {
    const fr = api.finishReason();
    if (fr !== "length" && fr !== "incomplete") return;
    const text = fr === "length"
      ? "⚠️ 上面这条回复写到一半就停住了——它撞上了【模型的输出上限】（末尾那句没写完）。不是网络断，也不是你操作有误，直接接着聊不受影响。如果长回复经常这样，可以到 ⚙️ 设置 换一个输出上限更大的模型。"
      : "⚠️ 上面这条回复的【结束标记没收到】——流很可能被网络或代理从中间掐断了，末尾可能缺内容。偶尔一次不必在意；若经常出现，检查一下是否走了代理 / 网关。";
    messages.push({ role: "system", content: text });
    renderMessages();
  }
  async function sendText(text, force, images) {
    const imgs = (images && images.length) ? images : null;
    // 允许「只贴图不打字」：那张截图本身就是问题
    if (!text && !imgs) return;
    // 非上课态默认禁止发送；force 仅用于“开场导读态选熟悉度”这类需要承接导读对话的场景（由 chooseFamiliarity 显式调用）
    if (!S.currentLessonId && !force) return;
    if (isBusy) return; // 防止并发请求堆叠出多个“思考中”气泡
    pushMessage("user", text || "", imgs);
    const thinking = startThinking();
    setBusy(true);
    let imageFallbackTried = false; // 图片降级只做一次，避免来回重发
    try {
      // 一对一上课：默认走流式，首 token 即现、长回复不干等（端点不支持 SSE 时自动退回整段）
      const trimmed = chatMessagesAutoTrim();
      const reply = await api.call(trimmed.msgs, {
        stream: true,
        onToken: (delta) => onStreamToken(thinking, delta),
        slot: "chat", // 显式声明：聊天区的「⏹ 停止」停的就是这一次（见 js/api.js 的 ctrlBySlot）
      });
      const aq = extractQualityTag(reply);
      stopThinking(thinking, aq.text || "（模型没返回内容，换个问题试试）");
      if (aq.quality && aq.quality !== "none") thinking.quality = aq.quality; // 路线1：把质量挂到该轮 assistant 消息，供下一轮 P1 决策
      noteIfOutputCut(); // 半句话不能"看起来像完整的"——见该函数上方说明
      // 累计本节课思维量（每一问一答 = 一轮深度交互）。
      // 先记账再自增：本次请求里的番茄提示是按【自增前】的轮数算出来的。
      advancePomodoroMarker();
      if (S.currentLessonId) lessonExchangeCount++;
      if (trimmed.compressed) {
        // 发送成功后，在聊天里温和地提示已自动精简，避免用户困惑
        messages.push({ role: "system", content: "🧠 老师精力已接近上限，自动略过了最早 " + trimmed.droppedTurns + " 轮对话（你的本地记录完整保留）。如果当前话题需要前面的内容，建议点「📚 下课」收尾，开启新一节课。" });
        renderMessages();
      }
    } catch (e) {
      // ---- 图片降级：模型不收图时，别让这一轮直接失败 ----
      // 判定必须排除"用户点了⏹停止"与"已经流式吐了一半"两种情况，否则会凭空再发一次请求
      // （B10 的同类教训：中止绝不能当成失败重试）。
      const partial0 = (thinking.thinking && thinking.thinking.partial) ? thinking.thinking.partial : "";
      if (e && e.name !== "AbortError" && !partial0 && !imageFallbackTried && isNoVisionError(e)) {
        imageFallbackTried = true;
        const blocked = blockAllImages();
        if (blocked) {
          toast("当前模型收不了图片，已改成纯文字继续这一轮。想真正「看图」，到 ⚙️ 设置 换个支持视觉的模型～", 5000);
          // 插到「思考中」占位【之前】—— 这条提示解释的是"用户刚发的那条消息出了什么"，
          // 必须紧跟在它下面。直接 push 会落到老师回复的后面，读起来像是事后补充
          // （E2E 实测：那样断言"最后一条 AI 消息"取到的是提示而不是回答）。
          const at = messages.indexOf(thinking);
          messages.splice(at >= 0 ? at : messages.length, 0, { role: "system", content: "⚠️ 当前模型不支持图片输入，刚才那 " + blocked + " 张图没有发出去（图仍留在你的聊天记录里，只是老师看不到）。如果这道题必须看图，请到 ⚙️ 设置 把模型换成支持视觉的（如 deepseek-v4-flash-vision-exp）后再发一次。" });
          renderMessages();
          saveChat();
          try {
            const retry = chatMessagesAutoTrim();
            const reply2 = await api.call(retry.msgs, {
              stream: true,
              onToken: (delta) => onStreamToken(thinking, delta),
              slot: "chat",
            });
            const aq2 = extractQualityTag(reply2);
            stopThinking(thinking, aq2.text || "（模型没返回内容，换个问题试试）");
            if (aq2.quality && aq2.quality !== "none") thinking.quality = aq2.quality;
            noteIfOutputCut();
            advancePomodoroMarker();
            if (S.currentLessonId) lessonExchangeCount++;
            return; // finally 照常收尾
          } catch (e2) {
            e = e2; // 降级后仍失败 → 走下面的通用错误文案
          }
        }
      }
      // 流式中断时保留已生成的部分正文，不把用户已经看到的内容吞掉
      const partial = (thinking.thinking && thinking.thinking.partial) ? thinking.thinking.partial : "";
      const isAbort = e && e.name === "AbortError";
      const errMsg = e.message || "";
      const isContextErr = !isAbort && (errMsg.includes("context") || errMsg.includes("token") || errMsg.includes("length") || errMsg.includes("too long") || errMsg.includes("maximum"));
      stopThinking(thinking, partial
        ? (partial + "\n\n⏹ 生成中断（以上是已生成的部分）。")
        : isAbort
          ? "⏹ 已停止生成。"
          : isContextErr
            ? "⚠️ 内容超出模型处理上限（教材太长或对话太多）。建议：① 点「📚 下课」结束本节课 ② 再点课时列表中的下一节开始新课（上下文会重置）。聊天记录已完整保留在本机。"
            : "⚠️ 出错了：" + friendlyApiError(e) +
              "\n\n常见原因：① Key 不对/额度用完；② 该接口不允许浏览器直连（CORS），按设置面板里的提示用本地服务打开；③ 网络问题。");
    } finally {
      saveChat(); setBusy(false); updateContextMeter();
    }
  }
  function send() {
    const text = els.userInput.value.trim();
    const images = pendingImages;
    if (!text && !images.length) return;
    if (isBusy) { toast("老师还在思考中，请稍后再发～"); return; }
    // 「记住我 XX / 记住：XX」即时写入画像（用户显式声明；AI 仍会正常收到并回应）
    const remember = text ? extractRememberText(text) : "";
    if (remember) {
      addGlobalEntry(remember, "user");
      try { profileUI.render(); } catch (e) { console.error("profileUI.render failed:", e); }
      toast("已记入画像：" + remember);
    }
    els.userInput.value = "";
    clearPendingImages(); // 图已交给这条消息（对象引用被 msg.images 持有，内存里不会丢）
    // 导读态（未上课）也允许发送：承接开场导读对话（sendText 内部对 force 放行）
    sendText(text, state.intro && !S.currentLessonId, images);
  }

  // ---- 开场导读 ----
  function isOnlyOpening() {
    return messages.length === 1 && messages[0].role === "assistant" &&
      messages[0].content === openingText();
  }
  async function generateIntro() {
    const material = els.material.value.trim();
    if (!material) { alert("先上传或粘贴学习资料，再来生成开场导读～"); return; }
    if (isBusy) { toast("当前有请求在进行中，请稍后再试"); return; }
    const sys = buildSystemPrompt("intro", buildPromptCtx("intro"));
    const introMsgs = [
      { role: "system", content: sys },
      { role: "user", content: "（资料已粘贴在系统提示里。请按「开场导读规则」，用你的角色口吻给" + roles.userAlias() + "做一段导读，并询问他的熟悉程度。）" },
    ];
    const replaceOpening = isOnlyOpening();
    const originalOpening = replaceOpening ? messages[0].content : null;
    const thinking = startThinking();
    setBusy(true);
    try {
      const reply = await api.call(introMsgs, { stream: true, onToken: (d) => onStreamToken(thinking, d) });
      stopThinking(thinking, reply || "");
      messages = messages.filter((m) => m !== thinking);
      if (replaceOpening) {
        if (messages.length) messages[0].content = reply || originalOpening;
      } else {
        messages.push({ role: "assistant", content: reply || "（模型没返回内容）" });
      }
      state.intro = true; // 进入导读态：允许点熟悉度快捷按钮，承接开场导读对话
      renderMessages();
    } catch (e) {
      stopThinking(thinking, "⚠️ 生成导读失败：" + friendlyApiError(e));
    } finally {
      saveChat(); setBusy(false); applyLessonUIMode();
    }
  }

  // ---- 下课：生成知识总结卡 + 随堂测验卡 ----
  // parseLessonJson 已抽至 js/core.js（SocratopiaCore.parseLessonJson）

  let lessonEnding = false; // 防止“下课”并发（连点）
  async function generateLessonEnd() {
    if (!S.currentLessonId || lessonEnding) return; // 不在上课中或正在下课：直接忽略
    lessonEnding = true;
    let lessonEndOk = false; // 小结是否成功产出（JSON 解析成功才为 true）；失败/被停止/异常时不自动拉起测验或群聊复盘
    const endedLessonId = S.currentLessonId; // 先捕获课时 id（后续 releaseLessonLock 会清空 currentLessonId）
    const userMsgs = messages.filter((m) => m.role === "user");
    const userTurns = userMsgs.length;
    const userChars = userMsgs.reduce((s, m) => s + (m.content || "").trim().length, 0);
    // 下课按学习深度分级：T0 无实质 / T1 初步学习（本地轻卡）/ T2 充分学习（完整复盘）
    const depth = APP_CONFIG.lessonDepth || { minSubstanceChars: 30, fullMinTurns: 3, fullMinChars: 150 };
    const hasSubstance = userTurns > 0 && userChars >= depth.minSubstanceChars;
    const isFull = hasSubstance && userTurns >= depth.fullMinTurns && userChars >= depth.fullMinChars;
    if (!hasSubstance) {
      // T0：无实质学习 → 回退为未开始，清掉可能残留的续学标记/小结，干净关闭（不生成任何复盘）
      if (S.currentLessonId) {
        const prog = loadLessonProg();
        if (!prog[S.currentLessonId]) prog[S.currentLessonId] = {};
        delete prog[S.currentLessonId].paused;
        delete prog[S.currentLessonId].summary;
        delete prog[S.currentLessonId].interrupted;
        delete prog[S.currentLessonId].interruptedAt;
        prog[S.currentLessonId].status = "not_started";
        saveLessonProg(prog);
        endCurrentLesson();
        saveLessonProg(loadLessonProg());
      }
      S.selectedLessonId = endedLessonId; // 下课完仍选中本节，「上课」立即可用
      messages = [];
      renderClosedChatPlaceholder(); // 展示“已下课”占位，聊天窗口关闭
      renderBookList();
      applyLessonUIMode();
      lessonEnding = false;
      return;
    }
    if (!isFull) {
      // T1：有实质学习但深度不足 → 不调 API，只落一张本地「继续学习」轻卡；无总结/测验/群聊
      if (S.currentLessonId) {
        setLessonStatus(S.currentLessonId, "ended", { summary: "", paused: true, endedAt: todayISO() });
        const progAfterEnd = loadLessonProg();
        if (progAfterEnd[S.currentLessonId]) {
          delete progAfterEnd[S.currentLessonId].interrupted;
          delete progAfterEnd[S.currentLessonId].interruptedAt;
        }
        saveLessonProg(progAfterEnd);
        releaseLessonLock(); // 解除上课锁，保留 ended 状态
        renderBookList();
      }
      messages = [{
        role: "system",
        card: { kind: "resumeLesson", text: "📄 本节课只进行了初步学习，未生成完整总结。随时回来点左侧本节「继续学习」深入，或在课时上点 ✓ 标记完成。" },
      }];
      quiz.clearPending();
      renderMessages();
      S.selectedLessonId = endedLessonId;
      applyLessonUIMode();
      saveChat();
      setBusy(false);
      lessonEnding = false;
      return;
    }
    // T2：充分学习 → 完整复盘（总结卡 + 随堂测验 + 课后笔记 + 群聊复盘）

    setBusy(true);
    startPendingCard();
    renderMessages();
    try {
      let endPrompt = "【上课记录】\n" + transcriptText() + "\n\n请按规则产出 JSON（summary + quiz）。";
      // 续学后再下课：把上次已出过的题告诉老师，要求换新题、重点考这次新巩固的部分；
      // 上次答错的题用新角度/新例子重新考察，避免「题目和上次一模一样」。
      const prevEntry = loadLessonProg()[endedLessonId];
      if (prevEntry && Array.isArray(prevEntry.quiz) && prevEntry.quiz.length) {
        endPrompt += "\n\n【上次已出过的题（请不要重复出同款题，换成新角度 / 新情境考察同一知识点）】\n" +
          prevEntry.quiz.map((q, i) => (i + 1) + ". " + (q.q || "")).join("\n");
        const wrong = prevEntry.quizWrong || [];
        if (wrong.length) {
          endPrompt += "\n\n上次测验中学习者这些题答错了，请用新的角度或新例子重新考察对应知识点，帮他把这块补扎实：" +
            wrong.map((i) => "第" + (i + 1) + "题" + (prevEntry.quiz[i] ? "（" + prevEntry.quiz[i].q + "）" : "")).join("、");
        }
      }
      const reply = await api.call([
        { role: "system", content: buildSystemPrompt("lessonEnd", buildPromptCtx("lessonEnd")) },
        { role: "user", content: endPrompt },
      ], { maxTokens: APP_CONFIG.limits.structuredOutputMaxTok });
      //    ↑ 2026-09-10 修 B7：不传 max_tokens 就落 provider 默认 4096，而下课产出
      //    （summary + 3~5 题 × 4 条逐项解析 + memory + userProfile + notes + 覆盖度）
      //    最坏形状约 4400 字符、模型写详细时翻倍 → 越界即截断 → JSON 不完整 →
      //    表现为「小结解析失败」，整节课的总结/测验/笔记/画像全废（与 B1 大纲截断同族）。
      const data = parseLessonJson(reply);
      // 2026-09-10（B7）：输出撞上 max_tokens 上限时，parseLessonJson 会「抢救」出前半截
      // （常见只剩 summary），于是 data 为真、根本不弹错误卡 —— 用户看到的是
      // "这次没出题 / 没笔记 / 没画像"，却完全不知道是被截断了。
      // 所以截断提示必须同时覆盖「解析成功」与「解析失败」两条分支。
      const truncated = api.finishReason() === "length";
      stopPendingCard();
      messages = messages.filter((m) => !(m.card && m.card.kind === "pending"));
      if (data) {
        lessonEndOk = true; // 小结产出成功：后续才会自动拉起随堂测验 / 群聊复盘
        const summaryId = "sum_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
        // 写入跨会话记忆：含掌握情况（memory）与用户画像（userProfile，用于因材施教）
        if (data.memory || data.userProfile) {
          mergeMemory(currentTopicKey(), Object.assign({}, data.memory || {}, data.userProfile ? { userProfile: data.userProfile } : {}));
        }
        // 因材施教：AI 课后观察（userProfile）并入全局画像（source='ai'），用户可在设置里查看/修改
        if (data.userProfile) {
          const aiEntries = Array.isArray(data.userProfile.entries) ? data.userProfile.entries : null;
          const r = addAiObservations(data.userProfile) || {};
          const added = typeof r.added === "number" ? r.added : 0;
          try { profileUI.render(); } catch (e) { console.error("profileUI.render failed:", e); }
          // 课后 diff toast：右下角提示 AI 提炼了多少新画像、被去重忽略了多少
          if (aiEntries && aiEntries.length) {
            const skipped = aiEntries.length - added;
            profileUI.showDiffToast(added, skipped, aiEntries);
          }
        }
        // 下课 ≠ 已完成：先标记为 ended（休息/待巩固），用户可后续手动标记为 completed
        if (S.currentLessonId) {
          // paused：标记「下课≠学完，只是中途休息」，再次上课时据此进入续学（查漏补缺）而非从头重讲
          setLessonStatus(S.currentLessonId, "ended", {
            summary: data.summary || "",
            selfScore: (data.memory && data.memory.selfScore != null) ? data.memory.selfScore : null,
            endedAt: todayISO(),
            paused: true,
            quiz: ensureQuizAnswers(data.quiz), // 存上次题目，供续学后再下课时换新题、重温错题（answer 已归一化为整数索引）
          });
          // 这次是正常下课（而非意外中断）：清掉 interrupted 标记，避免下次续学卡误报「意外中断」
          const progAfterEnd = loadLessonProg();
          if (progAfterEnd[S.currentLessonId]) {
            delete progAfterEnd[S.currentLessonId].interrupted;
            delete progAfterEnd[S.currentLessonId].interruptedAt;
          }
          saveLessonProg(progAfterEnd);
          // 覆盖度：记录本节课实际覆盖 / 未覆盖的关键知识点，供续学补讲与复习调度
          if (data.coveredKeyPoints || data.uncoveredKeyPoints) {
            progAfterEnd[S.currentLessonId].coverage = {
              covered: Array.isArray(data.coveredKeyPoints) ? data.coveredKeyPoints : [],
              uncovered: Array.isArray(data.uncoveredKeyPoints) ? data.uncoveredKeyPoints : [],
            };
            saveLessonProg(progAfterEnd);
          }
          releaseLessonLock(); // 解除上课锁，但保留 ended 状态
          renderBookList();
        }
        // 构建“下课报告”：清掉对话，只保留小结卡 + 答题卡（+下一节/全部完成提示）
        const covNote = (data.uncoveredKeyPoints && data.uncoveredKeyPoints.length)
          ? "\n\n⚠️ 本课还有未覆盖的知识点：" + data.uncoveredKeyPoints.join("、") + "（下次「继续学习」会优先补讲）"
          : "";
        const report = [{ role: "system", card: { kind: "summary", text: (data.summary || "") + covNote, id: summaryId, lid: endedLessonId, truncated: truncated } }];
        if (Array.isArray(data.quiz) && data.quiz.length) {
          // 聊天里放一条「去答题」提示卡，真正的测验在答题浮层里做
          report.push({ role: "system", card: { kind: "gotoQuiz", text: "📝 老师为你准备了 " + data.quiz.length + " 道闯关题，点击下方按钮开始答题～" } });
          quiz.setPending(ensureQuizAnswers(data.quiz), endedLessonId); // 暂存，供答题浮层使用（answer 已归一化为整数索引）
        } else {
          quiz.clearPending();
        }
        // 下课 ≠ 学完：不推「下一节」，只提示「继续学习本课」衔接（未点 ✓ 标记完成前进度记 0）
        report.push({ role: "system", card: { kind: "resumeLesson", text: "📚 本节课已下课，还没学完。点左侧本节「继续学习」随时回来衔接；确认掌握后，在课时旁点 ✓ 标记完成。" } });
        // 课后笔记：保存模型产出的 notes（按课时），并放入报告卡
        if (data.notes) {
          saveLessonNotes(endedLessonId, data.notes);
          report.push({ role: "system", card: { kind: "lessonNotes", text: "📓 老师已为你整理好本节课的课后笔记（核心问题 / 你的回答 / 易错点 / 待思考）。点击查看或补充你的反思。", lid: endedLessonId } });
        }
        // 20260915 行为变更：此前「打了啊哈标签的课时，课后保留完整对话实录」——
        // 因为啊哈的"跳回当时那条消息"依赖实录还在。啊哈时刻已下线，该条件永远不成立，
        // 这里回到最朴素的行为：下课即清掉对话，只留小结卡 / 答题卡 / 课后笔记 / 继续学习提示。
        // 若日后想恢复「保留实录」，应换一个不依赖啊哈的触发条件（如用户显式勾选），
        // 不要再把某个已下线功能的副产品当判据。
        messages = report;
        renderMessages();
        S.selectedLessonId = endedLessonId; // 下课完仍选中本节，「继续学习」立即可用
        applyLessonUIMode(); // 下课态：禁用输入/发送/下课，聊天窗口关闭
      } else {
        // 解析彻底失败：仍视为下课，释放课时锁并标记为已完成（带错误标记），避免左侧一直显示“进行中”
        console.warn("[Socratopia] lessonEnd JSON 解析失败，原始回复：", reply);
        if (S.currentLessonId) {
          // 解析失败也视为「已下课」，但不计入 completed；保留上课锁便于当前会话内重试
          setLessonStatus(S.currentLessonId, "ended", { summary: "", endedAt: todayISO(), hasError: true });
          saveLessonProg(loadLessonProg());
          renderBookList();
        }
        // 清掉旧错误卡，避免用户多次点下课叠加多张
        messages = messages.filter((m) => !(m.card && m.card.kind === "summaryError"));
        // 2026-09-10（B7）：解析彻底失败时区分"被输出上限截断"与"模型没按格式给"。
        // 原文案只说「格式问题」，与真因（截断）完全不搭边 —— 用户只会反复重试，
        // 永远想不到该去换一个输出上限更大的模型。这里按 finish_reason 如实说明。
        messages.push({
          role: "system",
          card: {
            kind: "summaryError",
            truncated: truncated,
            text: truncated
              ? "⚠️ 老师的输出被【模型的输出上限】截断了（JSON 没吐完），所以小结没能生成。"
                + "多半是当前模型能输出的长度偏小：到 ⚙️ 设置里换一个输出上限更大的模型，"
                + "或把资料 / 课时拆小一点，然后点「重新生成总结」。"
              : "⚠️ 老师的小结整理遇到了一点格式问题，没能正常生成小结卡。这节课的对话记录已保存，你可以点「重新生成总结」再试一次。",
            lid: S.currentLessonId,
          },
        });
        quiz.clearPending();
        S.selectedLessonId = endedLessonId;
        applyLessonUIMode();
      }
    } catch (e) {
      stopPendingCard();
      messages = messages.filter((m) => !(m.card && m.card.kind === "pending"));
      console.error("[Socratopia] lessonEnd 异常：", e);
      messages.push({ role: "system", card: { kind: "summary", text: "⚠️ 老师在整理小结时遇到了问题（" + friendlyApiError(e) + "）。这节课的对话记录已保存，你可以重新下课试试～" } });
      quiz.clearPending();
      S.selectedLessonId = endedLessonId;
      applyLessonUIMode();
    } finally {
      renderMessages(); saveChat(); setBusy(false); updateContextMeter();
      lessonEnding = false;
    }
    // 下课报告已展示（聊天窗口只读关闭）；按既有流程弹出答题 / 群聊复盘。
    // 小结未成功产出（解析失败 / 被停止 / API 异常，lessonEndOk=false）时不再自动拉起，
    // 避免"小结没生成还连发群聊"的劣质复盘叠加在报错卡上。
    if (lessonEndOk && quiz.hasPending()) {
      quiz.openQuiz();
    } else if (lessonEndOk && S.currentBook) {
      group.openGroup(true, endedLessonId);
    }
  }

  // 小结生成失败后，用户点击「重新生成总结」
  async function retryLessonEnd(lid) {
    if (lessonEnding) { toast("正在整理中，请稍候…"); return; }
    // 错误卡上保存了课时 id；若内存中仍有 currentLessonId 则优先使用
    const errCard = messages.find((m) => m.card && m.card.kind === "summaryError");
    lid = lid || S.currentLessonId || (errCard && errCard.card.lid);
    if (!lid || !S.currentBook) { toast("当前没有进行中的课时，无法重新生成总结"); return; }
    const reportKinds = { summaryError: 1, summary: 1, gotoQuiz: 1, nextLesson: 1, allDone: 1, lessonNotes: 1 };
    if (!S.currentLessonId) {
      // 刷新页面后内存锁已丢：从 localStorage 恢复课时对话并重新进入上课状态
      let chat = [];
      try { chat = JSON.parse(localStorage.getItem(lessonChatKey(lid))) || []; } catch (e) {}
      chat = chat.filter((m) => !(m.card && reportKinds[m.card.kind]));
      if (!chat.some((m) => m.role === "user")) { toast("找不到这节课的对话记录，无法重试"); return; }
      S.currentLessonId = lid;
      S.activeSessionBookId = S.currentBook.id;
      setLessonStatus(lid, "in_progress");
      saveLessonProg(loadLessonProg());
      messages = chat;
      renderBookList();
    } else {
      // 当前会话内直接清掉报告卡，基于现有 messages 重试
      messages = messages.filter((m) => !(m.card && reportKinds[m.card.kind]));
    }
    renderMessages();
    await generateLessonEnd();
  }

  // 展示“已下课 / 未上课”占位（聊天窗口关闭态）
  function renderClosedChatPlaceholder() {
    if (!els.messages) return;
    els.messages.innerHTML =
      '<div class="msg system chat-closed-hint">📚 本节课已下课（休息一下，回来还能继续）。<br>' +
      '点左侧课时可浏览 / 复习；已下课或已学过的课时，再点「📚 继续学习」会衔接上次进度接着学，不会从头开始。</div>';
  }

  // ---- 群聊复盘 ----
  // 20260902.1：整块迁出至 js/group.js —— 群聊自己的状态（groupMessages /
  // groupThinkingMsg / groupLessonId）收敛在该模块闭包内，宿主能力一律走 deps 注入。
  // 这里只保留一次装配：把群聊需要的能力交给它，拿回一组操作接口。
  const group = createGroupChat({
    els: {
      groupInput: els.groupInput,
      groupMessages: els.groupMessages,
      groupOverlay: els.groupOverlay,
      groupSend: els.groupSend,
      groupStop: els.groupStop,
      groupSub: els.groupSub,
      groupTitle: els.groupTitle,
      roleSelect: els.roleSelect,
    },
    getBookKey: () => (S.currentBook ? S.currentBook.bookKey : null),
    getBookTitle: () => (S.currentBook ? S.currentBook.title : ""),
    bookLS,
    // 20260913：错误文案改为注入。此前 js/group.js 自己读 classic 全局
    // window.SocratopiaCore.friendlyApiError —— 它是 7 个插件里唯一的 DI 破口
    // （宿主对 roles 早就注入了同一个函数），也导致该行为在单测里无法替换。
    friendlyApiError,
    callAPIWith: api.call,
    buildSystemPrompt,
    buildPromptCtx,
    // 群聊复盘要带「本节课」的上课记录：按课时从 localStorage 读，超长自动截断。
    // 无 lessonId（手动查看历史群聊）时退回当前会话记录。
    getLessonTranscript: (lessonId) => transcriptTextCapped(lessonId ? loadLessonChat(lessonId) : messages),
    userAlias: () => roles.userAlias(),
    toHalfWidth,
    escapeHtml,
    renderRichText,
    getAvatar,
    // 关闭群聊浮层后的「课后引导」属课程流程职责，留在宿主，避免模块反向依赖课时状态
    onGroupClosed: () => {
      if (!S.currentLessonId) return;
      const st = getLessonStatus(S.currentLessonId);
      if (st === "ended") {
        messages.push({ role: "system", card: { kind: "resumeLesson", text: "📚 本节课已下课，还没学完。点左侧本节「继续学习」随时回来衔接；确认掌握后，在课时旁点 ✓ 标记完成。" } });
        renderMessages(); saveCurrentLessonChat();
      } else if (st === "completed") {
        const nextLs = getNextIncompleteLesson();
        if (nextLs) {
          messages.push({ role: "system", card: {
            kind: "nextLesson",
            text: "📖 本节课已完成！下一节：「" + (nextLs.title || "") + "」——" + (nextLs.focus || ""),
            nextLessonId: nextLs.id,
          }});
          renderMessages(); saveCurrentLessonChat();
        } else {
          messages.push({ role: "system", card: { kind: "allDone", text: "🎉 本节课已完成！当前没有更多课时建议。可在左侧「踏石留印」和「我的收藏」里回顾。" } });
          renderMessages(); saveCurrentLessonChat();
        }
      }
    },
  });

  // ---- 随堂测验 ----
  // 20260906.1：整块迁出至 js/quiz.js —— 测验自己的状态（pendingQuiz / quizDone /
  // pendingQuizLessonId）收敛在该模块闭包内，宿主能力一律走 deps 注入。
  // answer 归一化已下沉为 SocratopiaCore.ensureQuizAnswers（纯函数，有单测）。
  const quiz = createQuiz({
    els: {
      quizOverlay: els.quizOverlay,
      quizBody: els.quizBody,
    },
    // 20260913 收窄：测验模块只需要"当前主题的记忆"这一个窄接口，不再整包交 store 状态
    getTopicMemory: () => S.memory.topics[currentTopicKey()] || null,
    escapeHtml,
    getAllLessons,
    normalizeKpToLesson,
    uniqKp,
    touchKeypointStats,
    dissolveUncovered,
    pushWrongbook,
    recordMisconceptions,
    saveQuizWrong,
    todayISO,
    emaQuizScore,
    recalcNextReview,
    saveBookMemory,
    renderMemoryPanel,
    // 答完测验后拉起群聊复盘：属课程流程职责，留在宿主，避免模块反向依赖群聊
    onFinished: (lessonId) => group.openGroup(true, lessonId),
  });

  // ---- 查看原文浮层 ----
  // 20260910.1：整块迁出至 js/source-viewer.js，宿主只做一次装配。
  // 浮层自己的状态与交互（切章 / 查找 / 点原文反查）全在模块内，宿主只拿 open/close。
  // 高亮分段与文本检索两个纯函数仍由 SocratopiaCore 提供（有单测），这里按名注入。
  const sourceViewer = createSourceViewer({
    els: {
      sourceOverlay: els.sourceOverlay,
      sourceTitle: els.sourceTitle,
      sourceSub: els.sourceSub,
      sourceLessonSelect: els.sourceLessonSelect,
      sourceText: els.sourceText,
      closeSource: els.closeSource,
      sourceFindInput: els.sourceFindInput,
      sourceFindCount: els.sourceFindCount,
      sourceFindPrev: els.sourceFindPrev,
      sourceFindNext: els.sourceFindNext,
      sourceFindClear: els.sourceFindClear,
    },
    // 20260913 收窄：只给"查看原文"真正要读的三样，不再整包交 store 状态
    getLibrary: () => S.library,
    getActiveSessionBookId: () => S.activeSessionBookId,
    getCurrentLessonId: () => S.currentLessonId,
    saveLibrary,
    indexChapterPositions,
    needsReindex,
    buildHighlightSegments,
    findTextMatches,
  });

  // ---- 本地存储用量统计（socratopia_* 前缀键的占用）----
  // ⚠️ 计量口径（20260914 修，实测得出）：配额按【UTF-16 码元数】计，不是按字节。
  // 实测（Chromium，二分逼近 setItem 抛 QuotaExceededError 的边界）：
  //   纯 ASCII 'a' 能存 5,242,869 个；纯中文 '中' 同样能存 5,242,869 个 —— 上限完全一致。
  //   若浏览器按字节计，中文上限应恰好只有 ASCII 的一半（≈2,621,434），实测否定了这一点。
  //   而 5 * 1024 * 1024 = 5,242,880，恰好就是码元数上限。
  // 旧实现把码元数 ×2 当"字节"、再除以 5MiB，等于把占用率报成真实的 2 倍：
  //   进度条走到 100% 时实际只用了 50%，85% 变红实际才 42.5% —— 会让人误以为快满了；
  //   而真正接近写满时读数还是 100%，跟半满时一模一样，预警意义反而没了。
  // 显示也改用「字符」而非「MB」：配额本身就是按字符算的，报 MB 只会再引入一层歧义。
  const QUOTA_UNITS = 5 * 1024 * 1024; // 单位：UTF-16 码元（即 5,242,880 个字符）
  // 码元数 → 「xx 万字符」；量级够用即可，不必精确到个位
  function fmtUnits(n) {
    if (n >= 10000) return (n / 10000).toFixed(n >= 1000000 ? 1 : 2) + " 万字符";
    return n + " 字符";
  }
  function storageUnits() {
    let units = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf("socratopia_") === 0) {
          const v = localStorage.getItem(k) || "";
          units += k.length + v.length; // 键 + 值，直接按码元累加（不要再 ×2）
        }
      }
    } catch (e) {}
    return units;
  }
  function renderStorageUsage() {
    if (!els.storageUsage) return;
    const units = storageUnits();
    const pct = Math.min(100, Math.round(units / QUOTA_UNITS * 100));
    els.storageUsage.textContent = "已用 " + fmtUnits(units) + " / 上限 "
      + fmtUnits(QUOTA_UNITS) + "（" + pct + "%）";
    if (els.storageBarFill) {
      els.storageBarFill.style.width = pct + "%";
      els.storageBarFill.className = pct >= 85 ? "danger" : "";
    }
  }

  // ---- 配置导出 / 导入（换端口 / 换设备不丢数据）----
  function exportConfig() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf("socratopia_") === 0) data[k] = localStorage.getItem(k);
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "socratopia-config-" + todayISO() + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    alert("已导出配置备份（含 API Key、资料、上课记录、记忆、收藏、头像）。把它存好，在另一个端口/设备打开本应用后点「导入配置」即可恢复。");
  }
  // 导入配置备份（配合 exportConfig）。
  // B11（2026-09-12）：旧实现把文件里**任意** socratopia_* 键的值原样 setItem，等于把
  // localStorage 的写入权交给了一个外部文件 —— 两处后果：
  //   ① 写入非字符串值时，localStorage 会把它存成 "[object Object]" → 静默把教材库/记忆写坏；
  //   ② 备份里的 id / 字段可以被任意构造，渲染层若有一处忘了转义就是注入点（本轮就抓到两处）。
  // 现在做最小校验：只认 socratopia_ 前缀 + 值必须是字符串（与 exportConfig 的写法对齐 ——
  // 它导出的本来就是 localStorage.getItem(k)，必然是字符串）。剔除项如实告知，不静默吞掉。
  function importConfig(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          throw new Error("顶层应是一个对象");
        }
        let n = 0, skipped = 0, quotaFailed = 0, otherFailed = 0, firstErr = "";
        Object.keys(data).forEach((k) => {
          if (k.indexOf("socratopia_") !== 0) { skipped++; return; }
          const v = data[k];
          if (typeof v !== "string") { skipped++; return; }
          // 逐键独立捕获（20260913 修）：此前任何一个键 setItem 抛异常都会被外层 catch
          // 统一报成「文件不是有效的配置备份」—— 那会把【本机存储已满】误导成【备份文件损坏】，
          // 用户可能因此把一份好备份当垃圾删掉。而且此时前面的键已经写进去了：既没回滚、
          // 也不刷新，内存里的 S.library 还是旧的，之后任何一次防抖写回都会用旧库覆盖刚导入的库。
          try {
            localStorage.setItem(k, v);
            n++;
          } catch (e) {
            const full = !!e && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.code === 22 || e.code === 1014);
            if (full) quotaFailed++;
            else { otherFailed++; if (!firstErr) firstErr = (e && e.name) || String(e); }
          }
        });
        const parts = ["已导入 " + n + " 项配置"];
        if (skipped) parts.push("忽略 " + skipped + " 项格式不符");
        if (quotaFailed) parts.push("⚠️ 有 " + quotaFailed + " 项因【本机存储已满】没能写入");
        if (otherFailed) parts.push("有 " + otherFailed + " 项写入失败（" + firstErr + "）");
        alert(parts.join("；") + "。页面即将刷新以加载已写入的部分。" +
          (quotaFailed ? "\n\n建议：先在「⚙️ 设置 → 导出配置」做好备份，再删掉不用的课程，然后重新导入。" : ""));
        location.reload();
      } catch (e) {
        // 走到这里只剩"文件本身不是 JSON / 顶层不是对象"这类情况（逐键写入已各自捕获），
        // 所以措辞可以准确地指向文件，而不是把存储问题也一并赖到文件上。
        alert("导入失败：无法把这个文件解析成配置备份（" + e.message + "）。\n请确认选的是「导出配置」生成的那个 .json 文件。");
      }
    };
    reader.onerror = () => alert("读取文件失败");
    reader.readAsText(file);
  }

  // ---- 文件解析 ----
  // 教材文档解析（PDF / EPUB / DOCX）已于 20260902.1 迁出至 js/extractors.js，
  // 统一入口 extractTextFromFile(file) 按扩展名分派，见文末 import。

  // ---- 熟悉程度 ----
  function markChip(fam) { chips.forEach((c) => c.classList.toggle("active", c.dataset.fam === fam)); }
  function chooseFamiliarity(fam) {
    state.familiarity = fam;
    markChip(fam);
    localStorage.setItem(LS.familiarity, fam);
    if (isBusy) { toast("老师还在思考中，请稍后再选～"); return; }
    // 导读态（未正式上课）也允许把熟悉度选择发给老师，让开场导读对话承接；上课态照常发送
    sendText("我选：" + fam, true);
  }

  // ---- 我的学习画像（UI 层）----
  // 20260906.1：整块迁出至 js/profile-ui.js —— 面板交互状态（editingProfileId /
  // activeProfileTab / collapsedProfileGroups / profileArchiveVisible）与全部事件绑定
  // 收敛在该模块闭包内；数据层（js/profile.js）由它直接 import，不必经宿主中转。
  // 这里只保留一次装配：把宿主独有的能力交给它，拿回一组操作接口。
  const profileUI = createProfileUI({
    toast,
    callAPIWith: api.call,
    escapeHtml,
  });

  // ---- 事件 ----
  // 设置弹窗（20260915 由「内嵌面板」改为「浮层」）：开合 + 关闭按钮 + 点遮罩关闭，
  // 与其它浮层用同一套约定。id 与 hidden class 都没变，故三个 spec 的既有断言不受影响。
  els.toggleSettings.addEventListener("click", () => els.settingsPanel.classList.toggle("hidden"));
  if (els.closeSettings) els.closeSettings.addEventListener("click", () => els.settingsPanel.classList.add("hidden"));
  els.settingsPanel.addEventListener("click", (e) => {
    if (e.target === els.settingsPanel) els.settingsPanel.classList.add("hidden");
  });
  // 左侧标签导航：只切 class 决定右侧显示哪一页，不重建 DOM（表单值就近保留）
  const settingsNavItems = els.settingsPanel.querySelectorAll(".settings-nav-item");
  const settingsPanes = els.settingsPanel.querySelectorAll(".settings-pane");
  settingsNavItems.forEach((btn) => {
    btn.addEventListener("click", () => {
      settingsNavItems.forEach((b) => b.classList.toggle("active", b === btn));
      settingsPanes.forEach((p) => p.classList.toggle("active", p.dataset.pane === btn.dataset.pane));
    });
  });
  profileUI.bindEvents();
  // 20260914：「☰ 侧栏」整栏折叠已下线（无实质教学增益，且曾引发聊天区塌陷 bug）。
  // 左栏现在常驻；下面保留的是「区块级」折叠（课程区抬头 / ⇕ 全折叠）。
  // 20260915 修两处折叠缺陷：
  //   ① 折叠态原先只活在一个内存变量里，刷新即全部还原 —— 折了也白折（现落盘 LS.folded）；
  //   ② 折叠后抬头不瘦身（38px 印章 + 双行标题 + 虚线分隔照旧），每折一段只省 ~8px。
  //      抬头压缩规则见 styles.css「区块折叠」段的 .collapsed 分支。
  const foldedSections = new Set((function () {
    try { const a = JSON.parse(localStorage.getItem(LS.folded)); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  })());
  function sectionFoldKey(sec) {
    if (!sec) return null;
    if (sec.classList.contains("course-library")) return "course";
    const h = sec.querySelector(".collapsible-head");
    return (h && h.dataset.target) || null;
  }
  function persistFolds() {
    try { localStorage.setItem(LS.folded, JSON.stringify([...foldedSections])); } catch (e) {}
  }
  function toggleFold(sec) {
    const k = sectionFoldKey(sec);
    if (!k) return;
    if (foldedSections.has(k)) foldedSections.delete(k); else foldedSections.add(k);
    persistFolds();
    applyFolds();
  }
  function applyFolds() {
    document.querySelectorAll(".sidebar section").forEach((sec) => {
      const k = sectionFoldKey(sec);
      if (k) sec.classList.toggle("collapsed", foldedSections.has(k));
    });
  }
  // 课程区折叠 / 展开（点课程抬头；但不拦截「全部折叠/展开」按钮）
  if (els.courseTopbar) els.courseTopbar.addEventListener("click", function (e) {
    if (e.target.closest("#courseExpandAll")) return;
    toggleFold(els.courseLibrary);
  });
  // 全部折叠 / 全部展开课程卡片（expandedCourses 清空或填满）
  if (els.courseExpandAll) els.courseExpandAll.addEventListener("click", function (e) {
    e.stopPropagation();
    if (expandedCourses.size > 0) expandedCourses.clear();
    else S.library.forEach((b) => expandedCourses.add(b.id));
    renderBookList();
  });
  // 踏石留印 / 我的收藏 区块折叠
  document.querySelectorAll(".collapsible-head").forEach((h) => {
    h.addEventListener("click", () => toggleFold(h.closest("section")));
  });
  applyFolds();
  // 明暗主题切换（主题在 <head> 内联脚本里于首帧前应用，避免闪烁）
  if (els.toggleTheme) els.toggleTheme.addEventListener("click", function () {
    const cur = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = cur;
    localStorage.setItem("socratopia_theme", cur);
  });
  // 课程搜索：输入即按标题/资料过滤
  if (els.bookSearch) els.bookSearch.addEventListener("input", function () {
    state.bookQuery = (els.bookSearch.value || "").trim().toLowerCase();
    renderBookList();
  });
  // 课时内聊天搜索：输入即过滤当前课时消息
  if (els.chatSearch) els.chatSearch.addEventListener("input", function () {
    state.chatQuery = els.chatSearch.value || "";
    renderMessages();
  });
  if (els.chatSearchClear) els.chatSearchClear.addEventListener("click", function () {
    els.chatSearch.value = ""; state.chatQuery = ""; renderMessages();
  });
  // 复盘浮层跨课时搜索
  if (els.reviewSearch) els.reviewSearch.addEventListener("input", function () {
    filterReviewNodes(this.value);
  });
  if (els.reviewSearchClear) els.reviewSearchClear.addEventListener("click", function () {
    els.reviewSearch.value = ""; filterReviewNodes("");
  });
  [els.apiBase, els.apiKey, els.apiModel, els.apiTemp, els.roleSelect].forEach((el) =>
    el.addEventListener("change", () => { saveSettings(); if (el === els.roleSelect) { renderMessages(); updateAvatarPreview(); roles.updateRoleButtons(); } }));
  // 服务商预设：选中自动填 baseUrl + model，Key 为空则聚焦 Key 输入
  if (els.providerPreset) els.providerPreset.addEventListener("change", () => {
    const opt = els.providerPreset.options[els.providerPreset.selectedIndex];
    if (opt && opt.dataset.base) {
      els.apiBase.value = opt.dataset.base;
      if (opt.dataset.model) els.apiModel.value = opt.dataset.model;
      if (!els.apiKey.value.trim()) els.apiKey.focus();
    } else {
      // 选「自定义」：清空 Base URL 与模型，交还给用户手动填写（避免残留上次预设的值）
      els.apiBase.value = "";
      els.apiModel.value = "";
    }
    saveSettings();
  });
  // 🔌 测试连接
  if (els.testConn) els.testConn.addEventListener("click", () => api.testConnection());
  // 🧹 清空所有数据（双重确认，删除所有 socratopia_* 键后刷新）
  if (els.resetApp) els.resetApp.addEventListener("click", () => {
    if (!confirm("确定清空本应用的所有数据吗？\n包括：全部课程、聊天记录、学习记忆、收藏、头像、API Key 设置。\n\n此操作不可恢复！")) return;
    if (!confirm("再次确认：真的要全部清空吗？")) return;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf("socratopia_") === 0) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
    location.reload();
  });
  // 教材标题/资料：实时写回当前教材（不再存全局）
  const debouncedBookSync = debounce(() => { syncUIToBook(); updateContextMeter(); }, 400);
  els.bookTitle.addEventListener("input", () => { debouncedBookSync(); });
  els.material.addEventListener("input", () => { updateCount(); debouncedBookSync(); });
  els.clearMaterial.addEventListener("click", () => { els.material.value = ""; updateCount(); syncUIToBook(); });
  els.addBook.addEventListener("click", () => {
    // 打开模态框（新增模式）：用户可输入名称、上传/粘贴材料
    openCourseEditModal("new");
  });
  els.genIntro.addEventListener("click", generateIntro);
  els.lessonEnd.addEventListener("click", generateLessonEnd);
  // 「📚 上课」按钮：将选中的课时正式进入学习模式
  els.startLessonBtn.addEventListener("click", () => {
    if (S.currentLessonId) { toast("本节课进行中，请点「📚 下课」结束"); return; }
    if (!S.selectedLessonId) { toast("请先在左侧选择一节课时"); return; }
    if (S.activeSessionBookId && S.activeSessionBookId !== S.currentBook?.id) {
      const b = S.library.find((x) => x.id === S.activeSessionBookId);
      toast("「" + (b ? b.title : "当前课程") + "」还在上课中，请先「📚 下课」。");
      return;
    }
    startLesson(S.selectedLessonId);
  });
  // 角色头像：上传（缩放到 256px 存本机）/ 清除 / 切换角色自动换头像
  els.avatarInput.addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const dataUrl = await resizeImage(f, 256);
      localStorage.setItem(LS.avatarPrefix + els.roleSelect.value, dataUrl);
      updateAvatarPreview();
      renderMessages(); group.renderGroupMessages(); // 已显示的对话也立刻换成新头像
      renderStorageUsage();
    } catch (err) { alert("头像处理失败：" + err.message); }
    finally { e.target.value = ""; }
  });
  els.clearAvatar.addEventListener("click", () => {
    localStorage.removeItem(LS.avatarPrefix + els.roleSelect.value);
    updateAvatarPreview();
    renderMessages(); group.renderGroupMessages();
    renderStorageUsage();
  });
  // 自定义角色：新建 / 编辑 / 删除 / 保存 / 取消
  els.roleNew.addEventListener("click", () => roles.openRoleEditor("new"));
  els.roleEdit.addEventListener("click", () => roles.openRoleEditor("edit"));
  els.roleDel.addEventListener("click", () => roles.deleteRole());
  els.roleAutoFill.addEventListener("click", () => roles.autoFillRole());
  if (els.roleGenToggle) els.roleGenToggle.addEventListener("click", () => roles.toggleGenDetails());
  els.roleEditSave.addEventListener("click", () => roles.saveRole());
  els.roleEditCancel.addEventListener("click", () => roles.closeRoleEditor());
  els.closeRoleEdit.addEventListener("click", () => roles.closeRoleEditor());
  els.roleEditModal.addEventListener("click", (e) => { if (e.target === els.roleEditModal) roles.closeRoleEditor(); });
  els.roleEditName.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); els.roleEditPersona.focus(); } });
  els.exportConfig.addEventListener("click", exportConfig);
  els.importConfig.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", (e) => {
    const f = e.target.files[0]; if (f) importConfig(f);
    e.target.value = "";
  });
  els.fileInput.addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const name = f.name.toLowerCase();
    setBusy(true);
    try {
      let text;
      if (name.endsWith(".pdf") || name.endsWith(".epub") || name.endsWith(".docx")) {
        // 统一分派入口见 js/extractors.js
        text = await extractTextFromFile(f);
      } else if (name.endsWith(".doc")) {
        alert("检测到旧版 .doc 文件，浏览器内暂无法直接解析。\n请先在 Word 里「另存为 .docx」或导出成 PDF 再上传，效果更稳。");
        return;
      } else {
        text = await extractPlainTextFile(f);
      }
      if (!text || !text.trim()) {
        alert("未能从文件中提取到任何文本。\n常见原因：扫描版 / 图片型 PDF（无文字层）、或文件已损坏。\n请改用文字版 PDF / EPUB / TXT / Word(.docx)，或直接把文本粘贴到下方文本框。");
        return;
      }
      els.material.value = text;
      updateCount();
      // 新增模式下：自动从文件名提取课程名
      if (cemMode === "new" && !els.bookTitle.value.trim()) {
        const rawName = f.name.replace(/\.[^.]+$/, "") // 去掉扩展名
          .replace(/[_\-]/g, " ")                     // 下划线/横杠变空格
          .replace(/\s+/g, " ").trim();               // 合并多余空格
        els.bookTitle.value = rawName || "新课程";
      }
      // 编辑模式下：实时写回当前课程
      if (cemMode === "edit") { syncUIToBook(); await generateIntro(); }
    } catch (err) {
      alert("读取文件失败：" + err.message);
    } finally {
      e.target.value = "";
      setBusy(false);
    }
  });
  // ---- 模态框按钮 ----
  els.cemCancel.addEventListener("click", () => closeCourseEditModal());
  els.cemSave.addEventListener("click", async () => {
    const title = els.bookTitle.value.trim();
    const material = els.material.value.trim();
    if (!title) { alert("请填写课程名称"); return; }
    if (cemMode === "new") {
      // 约束：有其他课程正在上课时，不允许直接上传并开始新课程（先下课）
      if (S.activeSessionBookId) {
        const b = S.library.find((x) => x.id === S.activeSessionBookId);
        alert("「" + (b ? b.title : "当前课程") + "」还在上课中，请先点「📚 下课」结束本节课，再上传并开始新课程。");
        return;
      }
      // 新建课程：创建 → 选中 → 填材料 → 自动生成大纲 → 开始第一节课
      addBook(title, material);
      closeCourseEditModal();
      if (material.length > 0) {
        setBusy(true);
        try {
          // 收到新教材后，自动请模型把内容拆成章节/课时
          if (await generateOutline()) toastOutlineResult("大纲已生成");
        } catch (err) {
          // 失败不再静默：明确告知用户，课程已建好，可在课程树点「↻ 重生成大纲」重试
          toast("大纲生成失败：" + friendlyApiError(err) + "（课程已保存，展开课程树后点「↻ 重生成大纲」可重试）");
        }
        // 大纲生成后（或失败后），尝试自动选中第一节未完成的课
        try {
          const firstLesson = getNextIncompleteLesson();
          if (firstLesson && firstLesson.id) await startLesson(firstLesson.id);
        } catch (_) {}
        setBusy(false);
      }
    } else {
      // 编辑模式：保存修改回当前课程
      const prevMaterial = (S.currentBook.material || "").trim();
      syncUIToBook();
      closeCourseEditModal();
      const newMaterial = (S.currentBook.material || "").trim();
      // 资料被替换（且非空）：无论是否已有大纲都重生成，避免新内容套旧目录
      if (newMaterial.length > 0 && newMaterial !== prevMaterial) {
        if (confirm("检测到学习资料已修改，是否根据新资料重新生成大纲？\n（原大纲结构与课时进度将按新课程结构重排）")) {
          // 旧课时聊天键的清理已上收至 generateOutline() 成功分支（仅删孤儿键），此处不再提前删除。
          setBusy(true);
          try { if (await generateOutline()) toastOutlineResult("已根据新资料重新生成大纲"); }
          catch (e) { toast("大纲重生成失败：" + friendlyApiError(e)); }
          finally { setBusy(false); }
        }
      } else if (newMaterial.length > 0 && !S.currentBook.outline) {
        // 资料未变但还没大纲：补生成（同样给出失败提示，不再静默）
        setBusy(true);
        try { if (await generateOutline()) toastOutlineResult("大纲已生成"); } catch (e) { toast("大纲生成失败：" + friendlyApiError(e)); } finally { setBusy(false); }
      }
    }
  });
  chips.forEach((c) => c.addEventListener("click", () => chooseFamiliarity(c.dataset.fam)));
  els.sendBtn.addEventListener("click", send);
  if (els.stopBtn) els.stopBtn.addEventListener("click", () => { api.abort("chat"); });
  // 大纲进度浮层内的停止按钮（B8b）：浮层遮住了页面里的 ⏹ 停止，必须给它一个自己的出口。
  // 中止后 api.abort("outline") 会让当前请求抛 AbortError，由 generateOutline 的
  // catch 给出友好提示并 hideOutlineProgress，用户不会卡在浮层里。
  if (els.outlineProgressStop) els.outlineProgressStop.addEventListener("click", () => { api.abort("outline"); });
  els.userInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });

  /* ---------------- 图片输入（20260916） ----------------
   * 入口有三条，共用 addPendingImages：
   *   ① Ctrl+V 粘贴截图（主路径 —— 用户最初就是想要这个）
   *   ② 把图片文件拖进输入区
   *   ③ 点「🖼 图片」选文件（给"不知道能粘贴"的人一个看得见的入口）
   * 三条都要能用：只做①的话，用户仍然不知道有这功能。 */
  els.userInput.addEventListener("paste", (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const imgs = filesFromDataTransfer(dt).filter((f) => isImageType(f.type));
    const plain = (typeof dt.getData === "function") ? (dt.getData("text/plain") || "") : "";
    // 该不该挂图交给纯函数判定（有文字就按文字粘贴，见 js/image-input.js 的注释）
    if (!shouldAttachFromPaste({ hasImageFiles: imgs.length > 0, plainText: plain })) return;
    e.preventDefault(); // 阻止浏览器把图片当文件名插成一行文字
    addPendingImages(imgs);
  });
  {
    const composerEl = els.userInput.parentElement; // .composer
    const dragHasImage = (ev) => !!ev.dataTransfer &&
      Array.from(ev.dataTransfer.types || []).indexOf("Files") >= 0;
    composerEl.addEventListener("dragover", (ev) => {
      if (!dragHasImage(ev)) return; // 拖文字进来不接管，保留浏览器默认行为
      ev.preventDefault();
      composerEl.classList.add("drop-active");
    });
    composerEl.addEventListener("dragleave", () => composerEl.classList.remove("drop-active"));
    composerEl.addEventListener("drop", (ev) => {
      composerEl.classList.remove("drop-active");
      const imgs = filesFromDataTransfer(ev.dataTransfer).filter((f) => isImageType(f.type));
      if (!imgs.length) return;
      ev.preventDefault();
      addPendingImages(imgs);
    });
  }
  if (els.attachBtn && els.attachInput) {
    els.attachBtn.addEventListener("click", () => els.attachInput.click());
    els.attachInput.addEventListener("change", () => {
      addPendingImages(els.attachInput.files);
      els.attachInput.value = ""; // 复位，否则同一张图选第二次不触发 change
    });
  }
  // 点聊天里的图 / 点待发送缩略图 → 看大图。用事件委托，重绘气泡不必重新绑定。
  if (els.messages) {
    els.messages.addEventListener("click", (e) => {
      const img = e.target && e.target.closest ? e.target.closest(".msg-image") : null;
      if (img) openImageZoom(img.getAttribute("src"));
    });
  }
  if (els.imgZoom) {
    els.imgZoom.addEventListener("click", closeImageZoom);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeImageZoom(); });
  }
  // 清空当前对话（由侧栏「清空对话」触发；已移出输入区，避免误触清空上课记录）
  function clearCurrentChat() {
    if (!S.currentBook) { toast("先新增一门课程～"); return; }
    const confirmMsg = S.currentLessonId
      ? "清空当前课时的对话？\n\n这会删除本节课的学习对话记录，之后重新「上课」会从头开始，不再是续学衔接。课时进度和已完成的其他课不受影响。"
      : "清空当前教材的对话？资料、进度、收藏都保留。";
    if (!confirm(confirmMsg)) return;
    messages = [];
    messages.push({ role: "assistant", content: openingText() });
    renderMessages(); saveChat();
    updateContextMeter();
    applyLessonUIMode();
  }
  els.closeGroup.addEventListener("click", () => group.closeGroup());
  els.groupStop.addEventListener("click", () => { api.abort("group"); });
  els.closeQuiz.addEventListener("click", () => quiz.closeQuizOverlay());
  els.closeReview.addEventListener("click", closeReview);
  els.reviewOverlay.addEventListener("click", (e) => { if (e.target === els.reviewOverlay) closeReview(); });
  if (els.closeNotes) els.closeNotes.addEventListener("click", () => els.notesOverlay.classList.add("hidden"));
  if (els.notesOverlay) els.notesOverlay.addEventListener("click", (e) => { if (e.target === els.notesOverlay) els.notesOverlay.classList.add("hidden"); });
  // 啊哈时刻的 modal 与面板监听已于 20260915 随功能下线一并移除
  // 原文浮层（切章 / 查找 / 点原文反查）的交互监听已随实现一并迁入
  // js/source-viewer.js，在其 createSourceViewer() 内自行绑定。
  els.groupSend.addEventListener("click", () => group.sendGroup());
  // 群聊里 AI 回复的代码块「一键复制」（groupBubble 也走 renderRichText）
  els.groupMessages.addEventListener("click", (e) => {
    const copyBtn = e.target.closest(".code-copy");
    if (copyBtn) copyCode(copyBtn);
  });
  els.groupInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); group.sendGroup(); } });

  // 意外关闭（没点「下课」就关掉窗口/标签页）：pagehide 在页面被卸载前同步执行，
  // 把当前进行中的课时打上 interrupted 标记；下次启动 cleanupStaleProgress 会把它转成
  // 「续学」态（ended+paused），进度不丢。点过「下课」的课时已是 ended，不会误标。
  window.addEventListener("pagehide", () => {
    if (!S.currentBook || !S.currentLessonId) return;
    if (getLessonStatus(S.currentLessonId) !== "in_progress") return;
    const prog = loadLessonProg();
    if (!prog[S.currentLessonId]) prog[S.currentLessonId] = {};
    prog[S.currentLessonId].interrupted = true;
    prog[S.currentLessonId].interruptedAt = Date.now();
    saveLessonProg(prog);
  });

  // ---- 启动 ----
  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

  // 角色 .js 已随页面加载完毕（<script> 标签），loadRoles 直接读注册表
    roles.loadRoles().then(() => {
    roles.initRoles();
    loadSettings();
    roles.updateRoleButtons(); // 选中项可能是自定义角色：据此开启「编辑/删除」按钮
    loadLibrary();
    // 一次性迁移：旧版存了全局 material/topic，但没有教材库 → 自动转成第一本教材
    if (!S.library.length) {
      let legacyMaterial = "";
      try { legacyMaterial = localStorage.getItem("socratopia_material_v0") || ""; } catch (e) {}
      let legacyTopic = "";
      try { legacyTopic = localStorage.getItem("socratopia_topic_v0") || ""; } catch (e) {}
      if (legacyMaterial || legacyTopic) {
        addBook(legacyTopic.trim() || "从旧版迁移的课程", legacyMaterial);
        // 迁移旧版聊天/群聊/记忆/收藏到这本教材
        migrateLegacyToBook(S.currentBook);
        return; // addBook 内部已 selectBook，会刷新 UI
      }
    }
    S.currentBook = getCurrentBook();
    cleanupStaleProgress(); // 启动时清理残留的 in_progress 状态（需先有 currentBook；中断课转续学，其余回退未开始）
    // 没有任何课程（全新用户）：自动建一本默认课程（原有首次体验）
    if (!S.library.length) {
      addBook("我的第一门课程", "");
    } else {
      // 已有课程：启动进入「课程选择」态——不自动加载/恢复任何课程的授课界面。
      // 左侧列出全部课程（无高亮、不展开），主区域显示欢迎语；用户点选某节课时才
      // selectBook 选中该课程并进入学习页面（显示该课时预览 + 上课按钮）。
      S.currentBook = null;
      S.selectedLessonId = null;
      S.currentLessonId = null;
      renderBookList();
      els.messages.innerHTML = '<div class="msg system">📚 欢迎回来！请选择左侧的课程开始学习，或点「＋ 新增课程」创建一门新课程。</div>';
      els.groupMessages.innerHTML = "";
      if (els.memoryList) els.memoryList.innerHTML = "";
      if (els.memoryEmpty) els.memoryEmpty.classList.remove("hidden");
      if (els.collectionList) els.collectionList.innerHTML = "";
      if (els.collectionEmpty) els.collectionEmpty.classList.remove("hidden");
      applyLessonUIMode(); // 未选课程：输入/发送/「下课」禁用，「上课」按钮提示先选课时
      updateContextMeter();
    }
    applyLessonUIMode(); // 未上课时正确禁用输入/发送（HTML 默认 enabled，不调用会"看着可用实际是死的"）
    updateAvatarPreview();
    renderStorageUsage();
    const savedFam = localStorage.getItem(LS.familiarity);
    if (savedFam) { state.familiarity = savedFam; markChip(savedFam); }
  }).catch((e) => {
    console.error(e);
    els.messages.innerHTML = '<div class="msg system">⚠️ 角色加载失败：' + escapeHtml(e.message) +
      '<br><br>请确认 app.js 顶部已 import 对应的角色模块（roles/*.js），且每个文件都调用了 registerRole({...})。</div>';
  });
})();

// ---- 应用更新检测：服务端换了新版本（重新打包/重启 exe）时，提示刷新 ----
// 场景：旧标签页仍开着旧版页面，用户重新运行了新版 exe（接管了 8199）。此时刷新该标签页即加载新版本。
// 每次回到本标签页时比对 /__version__ 与本地记录，版本变了就显示顶部提示条，点击刷新。
(function () {
  const KEY = "socratopia_build_seen";
  function check() {
    fetch("/__version__", { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : null))
      .then((v) => {
        if (!v) return;
        v = v.trim();
        const seen = localStorage.getItem(KEY);
        if (seen && seen !== v) {
          const el = document.getElementById("updateBanner");
          if (el && !el.dataset.shown) {
            el.dataset.shown = "1";
            el.classList.remove("hidden");
            el.addEventListener("click", () => { location.reload(); });
          }
        }
        localStorage.setItem(KEY, v);
      })
      .catch(() => {}); // 本地 file:// 或旧服务无 /__version__：静默忽略
  }
  check();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
  // 额外：周期性自检（每 15s）。避免用户一直停在同一标签页、从不切走，
  // 导致“应用已更新”提示条永不出现、长期跑着旧版 JS（表现为“修复没生效 / 功能像坏了”）。
  setInterval(check, 15000);
})();
