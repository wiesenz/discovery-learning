/* =====================================================================
 *  Socratopia v0 · 通用小工具 + DOM 引用 + localStorage 键名
 *  （2026-09-13 从 app.js 抽出，当时的名字是"DOM 引用与键名"）
 *
 *  为什么抽出来：
 *  ① 这一块是**纯声明/纯函数**（id → 元素的映射表、键名表、日期格式化），
 *     不含业务逻辑、不读写任何状态——它不该挤在宿主里占可读性与行数。
 *  ② 它是全站唯一一处"HTML 结构 ↔ JS 引用"的对照表。独立成文件后，
 *     改 index.html 时只需要看这一个文件就能对齐全站引用。
 *
 *  边界：**不含业务逻辑、不读写状态**。日期工具之所以在这里，是因为它同时被
 *  app.js 与 js/profile.js 需要（此前 app.js 有一份本地时区的、profile.js 用
 *  toISOString 的 UTC 版，同一个"差一天"的 bug 修了一处漏一处）。
 *  （契约测试 js/contract.test.mjs 的 [1] ID 契约会扫本文件，
 *    所以这里的每个 $("x") 依然受"HTML 里必须真有这个 id"的护栏保护。）
 * ===================================================================== */

/** 取元素。全站唯一的 getElementById 简写入口。 */
export const $ = (id) => document.getElementById(id);

/**
 * localStorage 键名表。
 * 注：教材级数据不在这里——那些键由 bookKey 派生，见 js/store.js 的 bookLS()。
 */
// 20260913 删掉两个零消费者的旧键：
//   · role（"socratopia_role_v0"）—— 角色实际存在 settings 里的 s.role，全库无人读写这个键；
//   · lessonProg（"socratopia_lessonprog_v0"）—— 课时进度实际走 bookLS(bookKey,"lessonprog")
//     （按教材隔离，见 js/store.js），这个"全局"版本从来没有被写过。
// 注意：role 这个键名在 tests/e2e/*.spec.js 里仍作为字面量出现（测试自己 seed localStorage），
// 与这个常量无关，所以删常量不影响那些用例。
export const LS = {
  settings: "socratopia_settings_v0",
  familiarity: "socratopia_familiarity_v0",
  avatarPrefix: "socratopia_avatar_", // 头像按角色名存：avatarPrefix + 角色名
  customRoles: "socratopia_custom_roles_v0", // 客户自行定制的角色（运行时编辑，随配置备份）
  library: "socratopia_library_v0",   // 教材库：[{id,title,material,bookKey,createdAt}]
  currentBook: "socratopia_current_book_v0", // 当前选中的教材 id
  // 左栏「区块级折叠」状态（20260915 加）：["course","memory","collection"] 的子集。
  // 此前折叠态只活在一个内存变量里，刷新页面就全部还原 —— 折叠等于白点。
  folded: "socratopia_folded_v0",
};

/** 输入防抖：材料/标题大段编辑时，避免每次按键都整库写 localStorage + 重建系统提示词（大教材时会卡） */
export function debounce(fn, ms) {
  let t = null;
  return function () { const self = this, args = arguments; clearTimeout(t); t = setTimeout(() => fn.apply(self, args), ms); };
}

// ---- 日期（一律本地时区）----
// ⚠️ 不要用 `new Date().toISOString().slice(0,10)` 取"今天"：toISOString 是 UTC，
//    在 UTC+8 时区，本地 00:00–08:00 之间它会返回【昨天】。
//    这个 bug 在 app.js 修过一次（当时的注释还在），但 js/profile.js 里另有两处
//    一直用 UTC 版本 —— 于是画像的 updatedAt 在清晨会记成前一天，并且会被渲染给用户看。
//    20260913 上收为唯一实现，app.js 与 js/profile.js 共用，杜绝再漏一处。
/** 两位补零 */
export function pad2(n) { return String(n).padStart(2, "0"); }
/** Date → 本地 "YYYY-MM-DD" */
export function localISO(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
/** 今天（本地时区）"YYYY-MM-DD" */
export function todayISO() { return localISO(new Date()); }
/** 本地日期串 + n 天（n 可为负） */
export function addDays(iso, n) { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return localISO(d); }

// ---- 「等待中」文案轮换（20260913 统一 app.js 与 js/group.js 里各写一遍的那份时序）----
// 两处此前是完全相同的决策数学：每 TICK 心跳一次、按 PHASE 轮换文案、超过 WARN 转入
// 「久候提醒」，且【无变化就不重绘】。差异只在渲染目标（一对一重绘整表 vs 群聊只补最后一个
// 节点）与文案来源（角色卡 thinkingPhrases vs config.js 的 groupThinkingPhrases）。
// 所以这里只收【会漂移的部分】—— 常量与决策；渲染仍归调用方。
// 真实风险：三个常量各写一份，调等待时长/警告阈值时漏改一处，就会出现
// "群聊 12 秒报警、一对一 20 秒"这种没法从代码一眼看出的不一致。
export const THINKING_WARN_MS = 12000;  // 超过 12s 提示用户可取消 / 检查网络
export const THINKING_PHASE_MS = 2000;  // 每 2s 换一句
export const THINKING_TICK_MS = 500;    // 心跳粒度（文案轮换 / warn 判定）

/**
 * 算这次心跳该显示第几句、要不要转「久候提醒」。
 * @param {number} elapsed     距开始等待的毫秒数
 * @param {number} phraseCount 文案条数
 * @param {number} prevIdx     上一次的句序号
 * @param {boolean} prevWarn   上一次是否已在提醒态
 * @returns {{idx:number, warn:boolean, changed:boolean}} changed=false 时调用方应跳过重绘
 */
export function nextThinkingPhase(elapsed, phraseCount, prevIdx, prevWarn) {
  const warn = elapsed >= THINKING_WARN_MS;
  // phraseCount<=0 时不要去算 %0：那会得到 NaN，而 `NaN === prevIdx` 恒为假 →
  // 心跳每 500ms 白重绘一次（文案本身也是 undefined）。这里直接判「无变化」，只留 warn 翻转。
  if (!(phraseCount > 0)) return { idx: 0, warn, changed: warn !== !!prevWarn };
  const idx = Math.floor(elapsed / THINKING_PHASE_MS) % phraseCount;
  return { idx, warn, changed: idx !== prevIdx || warn !== !!prevWarn };
}

/**
 * 收集页面上的固定元素引用（index.html 是静态骨架，启动时取一次即可）。
 * 返回的对象被宿主以 `els.xxx` 到处使用，也按子集注入给各插件
 * （见 app.js 的 createQuiz / createGroupChat 等装配点）。
 * @returns {Object<string, Element|null>}
 */
export function createEls() {
  return {
    toggleSettings: $("toggleSettings"),
    settingsPanel: $("settingsPanel"), closeSettings: $("closeSettings"),
    apiBase: $("apiBase"), apiKey: $("apiKey"), apiModel: $("apiModel"), apiTemp: $("apiTemp"),
    providerPreset: $("providerPreset"), testConn: $("testConn"),
    roleSelect: $("roleSelect"), roleNew: $("roleNew"), roleEdit: $("roleEdit"), roleDel: $("roleDel"), roleAutoFill: $("roleAutoFill"),
    avatarPreview: $("avatarPreview"), avatarInput: $("avatarInput"), clearAvatar: $("clearAvatar"),
    roleEditModal: $("roleEditModal"), roleEditTitle: $("roleEditTitle"), roleEditSub: $("roleEditSub"),
    roleEditName: $("roleEditName"), roleEditSeries: $("roleEditSeries"), roleEditAlias: $("roleEditAlias"),
    roleEditOpening: $("roleEditOpening"), roleEditPersona: $("roleEditPersona"), roleEditVoice: $("roleEditVoice"), roleEditThinking: $("roleEditThinking"),
    roleEditSave: $("roleEditSave"), roleEditCancel: $("roleEditCancel"), closeRoleEdit: $("closeRoleEdit"),
    roleGenToggle: $("roleGenToggle"), roleGenDetails: $("roleGenDetails"),
    exportConfig: $("exportConfig"), importConfig: $("importConfig"), importFile: $("importFile"),
    storageUsage: $("storageUsage"), storageBarFill: $("storageBarFill"), resetApp: $("resetApp"),
    usageStats: $("usageStats"),
    bookList: $("bookList"), bookEmpty: $("bookEmpty"), addBook: $("addBook"),
    bookTitle: $("bookTitle"), material: $("material"), fileInput: $("fileInput"),
    clearMaterial: $("clearMaterial"), materialCount: $("materialCount"), genIntro: $("genIntro"),
    // 课程编辑模态框
    courseEditModal: $("courseEditModal"),
    cemTitle: $("cemTitle"), cemSub: $("cemSub"),
    cemSave: $("cemSave"), cemCancel: $("closeCourseEdit"),
    messages: $("messages"), userInput: $("userInput"),
    sendBtn: $("sendBtn"), stopBtn: $("stopBtn"), startLessonBtn: $("startLessonBtn"), lessonEnd: $("lessonEnd"),
    // 图片输入（20260916）：待发送缩略图条 / 选图按钮与隐藏 input / 共用的大图查看浮层
    attachBar: $("attachBar"), attachBtn: $("attachBtn"), attachInput: $("attachInput"),
    imgZoom: $("imgZoom"), imgZoomPic: $("imgZoomPic"),
    memoryList: $("memoryList"), memoryEmpty: $("memoryEmpty"),
    collectionList: $("collectionList"), collectionEmpty: $("collectionEmpty"),
    closeGroup: $("closeGroup"), groupStop: $("groupStop"), groupOverlay: $("groupOverlay"),
    groupMessages: $("groupMessages"), groupInput: $("groupInput"), groupSend: $("groupSend"),
    groupTitle: $("groupTitle"), groupSub: $("groupSub"),
    quizOverlay: $("quizOverlay"), closeQuiz: $("closeQuiz"), quizBody: $("quizBody"),
    reviewOverlay: $("reviewOverlay"), reviewTitle: $("reviewTitle"),
    // reviewSub / ctxMeter 两个引用已删（20260913）：它们在 index.html 里各有静态文案与 title，
    // 但没有任何代码读写 —— reviewSub 是固定副标题、ctxMeter 只是个带 tooltip 的容器
    // （updateContextMeter 只碰它的子元素 ctxNum/ctxLabel/ctxBarFill/ctxHint）。
    // 元素本身保留在 HTML 里，删的只是这两个用不到的 JS 引用。
    reviewMessages: $("reviewMessages"), closeReview: $("closeReview"),
    sourceOverlay: $("sourceOverlay"), sourceTitle: $("sourceTitle"), sourceSub: $("sourceSub"),
    sourceLessonSelect: $("sourceLessonSelect"), sourceText: $("sourceText"), closeSource: $("closeSource"),
    sourceFindInput: $("sourceFindInput"), sourceFindCount: $("sourceFindCount"),
    sourceFindPrev: $("sourceFindPrev"), sourceFindNext: $("sourceFindNext"), sourceFindClear: $("sourceFindClear"),
    ctxBarFill: $("ctxBarFill"), ctxNum: $("ctxNum"),
    ctxLabel: $("ctxLabel"), ctxHint: $("ctxHint"),
    outlineProgressStop: $("outlineProgressStop"), // 进度浮层内的停止按钮（浮层会遮住页面里的 ⏹ 停止）
    bookSearch: $("bookSearch"), toggleTheme: $("toggleTheme"),
    chatSearch: $("chatSearch"), chatSearchCount: $("chatSearchCount"), chatSearchClear: $("chatSearchClear"),
    reviewSearch: $("reviewSearch"), reviewSearchClear: $("reviewSearchClear"),
    notesOverlay: $("notesOverlay"), notesSub: $("notesSub"), notesBody: $("notesBody"), closeNotes: $("closeNotes"),
    courseTopbar: $("courseTopbar"),
    courseLibrary: document.querySelector(".course-library"), courseExpandAll: $("courseExpandAll"),
    chatSection: document.querySelector(".chat"),
  };
}
