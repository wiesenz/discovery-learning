/* =====================================================================
 *  Socratopia v0 · 群聊复盘（多位老师围观点评 + 学员插话）
 *  20260902.1 从 app.js 抽出（技术债拆分第二刀）。
 *
 *  设计：本模块不直接读写 app.js 的任何模块级状态。
 *  群聊自己的状态（groupMessages / groupThinkingMsg / groupLessonId / groupReviewedKey /
 *  genToken）收敛在 createGroupChat() 的闭包里，外部只能通过返回的接口访问。
 *  所有对宿主能力的依赖（API 调用、渲染函数、当前教材）一律走 deps 注入，
 *  便于将来单测时替换为假实现。
 *
 *  已知边界（2026-09-13 复查，未改，理由见下）：
 *  ① 本模块直接用 localStorage 读写群聊记录，只从 deps 拿键名（bookLS）。
 *     store 只提供"键工厂"、不提供读写封装，所以键名受控、读写不受控。
 *     后果：群聊的持久化行为在单测里无法替换/断言。要收掉需要注入
 *     read/write 两个适配器（约 4 个调用点），属于独立一刀，暂不混在行为修复里做。
 *  ② deps 里曾有一个 DI 破口：错误文案自己读 classic 全局 window.SocratopiaCore。
 *     已于 20260913 改为注入 friendlyApiError（宿主对 roles 早就注入了同一个函数）。
 *
 *  用法：
 *    const group = createGroupChat({ els, getBookKey, bookLS, callAPIWith, ... });
 *    group.openGroup(true, lessonId);
 * ===================================================================== */
import { APP_CONFIG } from "../config.js";
// 等待文案轮换的常量与决策数学与 app.js 共用一份（20260913 上收至 js/dom.js）——
// 此前两边各写一遍完全相同的时序，调阈值漏改一处就会出现"群聊 12 秒报警、一对一 20 秒"。
import { THINKING_TICK_MS, nextThinkingPhase } from "./dom.js";

// 群聊发言节奏（毫秒）：先显示「XX 正在输入…」，随机打字时长后再落定为真实发言
const TYPING_MIN = 1200;
const TYPING_MAX = 2000;
const PAUSE_MIN = 300;
const PAUSE_MAX = 800;

// 群聊等待态（思考指示）的三个常量已与 app.js 合并到 js/dom.js，见上方 import。

export function createGroupChat(deps) {
  const {
    els,
    getBookKey,        // () => 当前教材 bookKey | null
    bookLS,            // (bookKey, kind) => localStorage 键
    callAPIWith,       // async (messages) => 模型返回的文本
    buildSystemPrompt, // (mode, ctx) => string
    buildPromptCtx,    // (mode, opts?) => ctx
    getLessonTranscript, // (lessonId) => string，本节课上课记录（宿主按课时载入后截断）
    userAlias,         // () => 学员在群里的称呼
    toHalfWidth,       // (s) => string
    escapeHtml,        // (s) => string
    renderRichText,    // (s) => html
    getAvatar,         // (roleName) => dataURL | null
    friendlyApiError,  // (e) => string，把异常转成给用户看的错误文案（20260913 改为注入）
    onGroupClosed,     // () => void，关闭群聊浮层后的课后引导（宿主逻辑）
  } = deps;

  // ---- 群聊私有状态（不再散落在 app.js）----
  let groupMessages = [];        // {speaker, text, isUser?, status?}
  let groupThinkingMsg = null;   // 当前活跃的等待消息（同一时刻仅一个）
  let groupLessonId = null;      // 当前群聊所属课时 id
  // 当前 groupMessages 是哪一节【哪本书】的复盘。必须是 bookKey + 课时 id 的复合键：
  // 课时 id 由大纲生成（"ch0_L0"），**每本书都从 ch0_L0 开始，跨书必然重名**。
  // 20260913 修复：此前只存 lessonId，于是「A 书复盘过 ch0_L0」会让「B 书的 ch0_L0」
  // 误判成"已复盘过"，跳过生成只做重绘 —— 浮层一片空白、无任何错误提示，只有刷新能恢复。
  let groupReviewedKey = null;
  function reviewedKey(lessonId) { return (getBookKey() || "") + "|" + (lessonId || ""); }

  // ---- 生成令牌：换书 / 清空时作废进行中的生成 ----
  // revealGroupLines 是 async 循环，每条气泡之间 await sleep(1~3s)；期间用户完全可能
  // 收起浮层去点另一门课。此前没有任何取消机制，后果有两条（都实测过）：
  //   ① 上一门课剩下的点评被 append 进【新书】的 groupMessages；
  //   ② saveGroupChat() 在【调用时】才解析 getBookKey()，于是这批内容被写进新书的
  //      存取键 —— 跨书污染；且 idx 按旧数组长度算，会覆盖新书已有的群聊记录（静默丢数据）。
  // 现在：令牌自增即作废；异步循环每一步比对，过期立刻收手、不再写任何数据。
  let genToken = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randBetween = (min, max) => min + Math.round(Math.random() * (max - min));

  function setGroupBusy(b) { els.groupSend.disabled = b; }
  function setGroupStopVisible(v) { if (els.groupStop) els.groupStop.style.display = v ? "inline-block" : "none"; }

  /** 群聊落盘：跳过「正在输入 / 等待中」这类不落盘的瞬时状态 */
  function saveGroupChat() {
    const bk = getBookKey();
    if (!bk) return;
    try {
      localStorage.setItem(
        bookLS(bk, "group"),
        JSON.stringify(groupMessages.filter((m) => !(m.status && m.thinking)))
      );
    } catch (e) { /* 配额满等：静默忽略 */ }
  }

  function renderGroupMessages() {
    els.groupMessages.innerHTML = "";
    groupMessages.forEach((m) => els.groupMessages.appendChild(groupBubble(m)));
    els.groupMessages.scrollTop = els.groupMessages.scrollHeight;
  }

  function formatGroupThinkingHtml(phrase, warn) {
    const warnHtml = warn
      // 同 app.js 的 thinking-warn：文言腔对活泼人设是硬伤，统一改成大白话。
      ? '<span class="thinking-warn">（老师们还在想…如果等太久，多半是网络或接口没响应。可以点群聊右上角「⏹ 停笔」中断，稍后再开。）</span>'
      : "";
    return '<div class="thinking-wrap">' +
      '<span class="thinking-spinner"></span>' +
      '<span class="thinking-label">' + escapeHtml(phrase) + "</span>" +
      warnHtml +
      "</div>";
  }

  /** 「XX 正在输入…」瞬时气泡：只进内存 + DOM，不落盘（避免中断时残留 thinking） */
  function appendGroupTyping(speaker) {
    const m = { status: true, typing: { speaker: speaker || "" } };
    groupMessages.push(m);
    const node = groupBubble(m);
    node.classList.add("g-enter");
    els.groupMessages.appendChild(node);
    els.groupMessages.scrollTop = els.groupMessages.scrollHeight;
    return groupMessages.length - 1;
  }

  /** 打字结束：移除「正在输入」气泡，替换为真实发言（带淡入动画） */
  function resolveGroupTyping(idx, line) {
    const thinkNodes = els.groupMessages.querySelectorAll(".msg.g-think");
    const lastThink = thinkNodes[thinkNodes.length - 1];
    if (lastThink && lastThink.parentNode) lastThink.parentNode.removeChild(lastThink);
    groupMessages[idx] = line;
    const node = groupBubble(line);
    node.classList.add("g-enter");
    els.groupMessages.appendChild(node);
    els.groupMessages.scrollTop = els.groupMessages.scrollHeight;
    saveGroupChat();
  }

  async function revealGroupLines(lines) {
    const token = genToken;
    for (let i = 0; i < lines.length; i++) {
      if (token !== genToken) return; // 已换书/已清空：立刻收手，一个气泡都不再写
      const idx = appendGroupTyping(lines[i].speaker);
      await sleep(randBetween(TYPING_MIN, TYPING_MAX)); // 假装打字中
      // 关键：打盹期间用户可能已经切了书，此时 groupMessages 已被整组换成新书的数组，
      // 继续 resolveGroupTyping 就会把这本书的台词按旧下标写进新书（并落盘到新书的键）。
      if (token !== genToken) return;
      resolveGroupTyping(idx, lines[i]);
      if (i < lines.length - 1) await sleep(randBetween(PAUSE_MIN, PAUSE_MAX)); // 发言间停顿
    }
  }

  function startGroupThinking() {
    stopGroupThinking(); // 先清掉可能残留的旧等待消息
    const phrases = APP_CONFIG.groupThinkingPhrases;
    groupThinkingMsg = { status: true, thinking: { start: Date.now(), phrases, phraseIdx: 0, warn: false } };
    groupMessages.push(groupThinkingMsg);
    renderGroupMessages();
    groupThinkingMsg.thinking.timer = setInterval(() => {
      const t = groupThinkingMsg && groupThinkingMsg.thinking;
      if (!t) return;
      const { idx, warn, changed } = nextThinkingPhase(Date.now() - t.start, phrases.length, t.phraseIdx, t.warn);
      if (!changed) return;
      t.phraseIdx = idx;
      t.warn = warn;
      // 只更新当前等待节点，避免整页重绘导致历史气泡动画重播
      const nodes = els.groupMessages.querySelectorAll(".msg.system.g-think");
      const node = nodes[nodes.length - 1];
      if (node) node.innerHTML = formatGroupThinkingHtml(phrases[idx], warn);
    }, THINKING_TICK_MS);
    return groupThinkingMsg;
  }

  function stopGroupThinking(finalText) {
    if (!groupThinkingMsg) {
      // 即便没有活跃等待消息，也兜底清理任何残留的 thinking 标记
      groupMessages.forEach((m) => { if (m.thinking) { clearInterval(m.thinking.timer); delete m.thinking; } });
    } else {
      clearInterval(groupThinkingMsg.thinking.timer);
      const idx = groupMessages.indexOf(groupThinkingMsg);
      if (idx >= 0) {
        if (finalText != null) groupMessages[idx] = { status: true, text: finalText };
        else groupMessages.splice(idx, 1);
      }
      delete groupThinkingMsg.thinking;
      groupThinkingMsg = null;
    }
    renderGroupMessages();
    saveGroupChat();
  }

  function groupBubble(m) {
    const d = document.createElement("div");
    if (m.status) {
      if (m.typing) {
        // 「XX 正在输入…」瞬时提示气泡
        d.className = "msg system g-think";
        d.innerHTML = '<div class="thinking-wrap"><span class="thinking-spinner"></span><span class="thinking-label">' +
          escapeHtml((m.typing.speaker || "老师") + " 正在输入…") + "</span></div>";
      } else if (m.thinking) {
        d.className = "msg system g-think";
        const gp = (m.thinking.phrases && m.thinking.phrases.length) ? m.thinking.phrases : APP_CONFIG.groupThinkingPhrases;
        d.innerHTML = formatGroupThinkingHtml(gp[0], false);
      } else {
        d.className = "msg system";
        d.textContent = m.text;
      }
      return d;
    }
    const isUser = !!m.isUser;
    const color = isUser ? "gold" : (m.speaker === els.roleSelect.value ? "cinnabar" : "ultra");
    const sealChar = isUser ? "我" : (m.speaker || "?").charAt(0);
    d.className = "g-msg " + (isUser ? "g-user" : "g-ai");
    let headInner;
    if (isUser) {
      headInner = '<span class="seal-mini g-seal ' + color + '">' + escapeHtml(sealChar) + "</span>";
    } else {
      const av = getAvatar(m.speaker);
      // av 已由 app.js 的 getAvatar 做了 data:image 白名单过滤；这里再转义一次是纵深防御
      // （HTML 属性插值必须转义，别依赖上游——这正是本项目反复踩的"同族只守一半"）。
      headInner = av
        ? '<img class="g-avatar" src="' + escapeHtml(av) + '" alt="" />'
        : '<span class="seal-mini g-seal ' + color + '">' + escapeHtml(sealChar) + "</span>";
    }
    d.innerHTML = '<div class="g-head">' + headInner + '<span class="g-name">' + escapeHtml(m.speaker) + '</span></div><div class="g-text">' + renderRichText(m.text) + "</div>";
    return d;
  }

  /** 把模型的整段回复切成「角色名：内容」的发言数组 */
  function parseGroupLines(text) {
    const out = [];
    const lines = (text || "").split(/\r?\n/);
    for (const raw of lines) {
      let line = raw.trim();
      if (!line) continue;
      // 去掉常见 markdown 装饰（行首 #、-、*、>、引号包裹等），避免名字被污染
      line = line.replace(/^\s*[*\->#>]+\s*/, "").replace(/^["「『“]+|["」』”]+$/g, "").trim();
      const m = line.match(/^([^：:]{1,12})[：:]\s*(.*)$/);
      if (m) {
        const speaker = m[1].replace(/[*_`"「」“”]/g, "").trim();
        const body = m[2].trim();
        if (speaker && body) out.push({ speaker, text: body });
      } else if (out.length) {
        // 非「角色名：」的续行 → 接上一条发言（模型可能断行 / 补充说明）
        out[out.length - 1].text += " " + line;
      }
    }
    // 兜底：整段都是自然段落（没有任何「角色名：」格式）→ 归为当前老师一条发言，
    // 避免群聊"不说话了"的空转。
    if (!out.length) {
      const flat = (text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(" ");
      if (flat) out.push({ speaker: els.roleSelect.value || "老师", text: flat });
    }
    return out.filter((x) => x.text);
  }

  // 群聊的提示词上下文：每次构造都带上「本次群聊所对应课时」的真实上课记录，
  // 否则模型只会看到「请根据上课记录点评」却拿不到记录（历史遗留缺失，20260905 修复）。
  function groupCtx() {
    return buildPromptCtx("group", { transcript: getLessonTranscript(groupLessonId) });
  }

  async function generateGroup() {
    const token = genToken;
    setGroupBusy(true);
    setGroupStopVisible(true);
    try {
      // —— 第一轮：当前老师主评 + 其他老师各自补充（先有"开场"，像人刚进群）——
      startGroupThinking();
      const r1 = await callAPIWith([
        { role: "system", content: buildSystemPrompt("group", groupCtx()) },
        { role: "user", content: "请开始群聊复盘的第一轮：先由当前老师做主要点评（肯定亮点 + 指出可改进处 + 一句鼓励），再由其他 1~2 位老师从各自角度补充。每人 1~3 句，用「角色名：」格式。先不要抛思考题——这一轮是老师们先各自亮明看法。" },
      ], { slot: "group" });
      if (token !== genToken) return; // 等待期间切了书：本次生成整体作废，不留痕
      stopGroupThinking();
      await revealGroupLines(parseGroupLines(r1)); // 第一轮：每个角色逐条登场

      // —— 第二轮：老师们接着聊（互问互答 / 接话 / 轻微争论），最后抛思考题 ——
      if (token !== genToken) return;
      startGroupThinking();
      const hist = groupMessages.filter((m) => !m.status).map((m) => (m.isUser ? userAlias() : m.speaker) + "：" + m.text);
      const r2 = await callAPIWith([
        { role: "system", content: buildSystemPrompt("group", groupCtx()) },
        { role: "user", content: "当前群聊记录：\n" + hist.join("\n") +
          "\n\n请继续这场群聊（第二轮），让老师们自然接话、先后问答：可以有一位老师接上一句展开，或向另一位老师提问并等对方作答，也可就某个点轻微争论；语气更口语、更像真人闲聊。最后请一位老师向「" + userAlias() + "」抛一个课后小思考题。再增加 4~8 句，用「角色名：」格式，不要重复第一轮已说过的内容。" },
      ], { slot: "group" });
      if (token !== genToken) return;
      stopGroupThinking();
      await revealGroupLines(parseGroupLines(r2)); // 第二轮：老师们接着接话，逐条登场
    } catch (e) {
      // 已换书则连错误气泡都不要写——否则「⚠️ 群聊生成失败」会落到另一门课的复盘里
      if (token !== genToken) return;
      const aborted = e && e.name === "AbortError";
      stopGroupThinking(aborted ? "⏹ 已停止生成。" : "⚠️ 群聊生成失败：" + friendlyApiError(e));
    } finally {
      // 按钮状态是浮层级的，无论是否作废都要复位；数据写入才需要看令牌
      setGroupBusy(false);
      setGroupStopVisible(false);
      if (token === genToken) { renderGroupMessages(); saveGroupChat(); }
    }
  }

  async function sendGroup() {
    const text = els.groupInput.value.trim();
    if (!text) return;
    els.groupInput.value = "";
    groupMessages.push({ speaker: userAlias(), text: toHalfWidth(text), isUser: true });
    renderGroupMessages(); saveGroupChat();
    const token = genToken; // 学员插话同样可能中途切书，走同一套作废机制
    setGroupBusy(true);
    setGroupStopVisible(true);
    try {
      startGroupThinking();
      const hist = groupMessages.filter((m) => !m.status).map((m) => (m.isUser ? userAlias() : m.speaker) + "：" + m.text);
      const reply = await callAPIWith([
        { role: "system", content: buildSystemPrompt("group", groupCtx()) },
        { role: "user", content: "当前群聊记录：\n" + hist.join("\n") +
          "\n\n" + userAlias() + "刚在群里说了上面的话，请让合适的老师接着回应（继续用「角色名：」格式，1~3 句）。" },
      ], { slot: "group" });
      if (token !== genToken) return;
      stopGroupThinking();
      await revealGroupLines(parseGroupLines(reply));
    } catch (e) {
      if (token !== genToken) return;
      const aborted = e && e.name === "AbortError";
      stopGroupThinking(aborted ? "⏹ 已停止生成。" : "⚠️ " + friendlyApiError(e));
    } finally {
      setGroupBusy(false);
      setGroupStopVisible(false);
      if (token === genToken) { renderGroupMessages(); saveGroupChat(); }
    }
  }

  function openGroup(auto, lessonId) {
    // 记录本次群聊对应的课时：群聊的「上课记录」据此从该课时的真实聊天中读取
    groupLessonId = lessonId || null;
    // 更新群聊标题为当前课程名
    if (els.groupTitle) els.groupTitle.textContent = (deps.getBookTitle ? deps.getBookTitle() : "") + " · 群聊复盘";
    if (els.groupSub) els.groupSub.textContent = "老师们正在点评你的表现";
    els.groupOverlay.classList.remove("hidden");
    setGroupStopVisible(false);
    if (auto) {
      // 自动复盘（下课/测验后、知识总结卡上的「💬 群聊复盘」）：必须展示【本节课】的新鲜复盘。
      // 若当前 groupMessages 还停留在上一课时/旧记录（或从未生成过），先清掉再重新生成；
      // 同一课时已生成过则直接展示已有内容，避免重复调用。
      // 判据是 bookKey+课时id 复合键：课时 id 跨书重名（都叫 ch0_L0），只比 lessonId 会把
      // 别本书的复盘误当成本节的，跳过生成 → 浮层空白。
      if (groupReviewedKey !== reviewedKey(lessonId)) {
        groupMessages = [];
        groupReviewedKey = reviewedKey(lessonId);
        genToken++; // 作废仍在跑的上一节课/上一本书的生成，避免它继续往这个新数组里写
        renderGroupMessages();
        generateGroup();
      } else {
        renderGroupMessages();
      }
    } else {
      // 手动查看历史（课程卡上的 💬 按钮）：直接展示已有记录
      renderGroupMessages();
    }
  }

  function closeGroup() {
    els.groupOverlay.classList.add("hidden");
    setGroupStopVisible(false);
    // 课后引导属宿主（课程流程）职责，回调出去，避免本模块反向依赖课时状态
    if (onGroupClosed) onGroupClosed();
  }

  /** 切换教材时载入该教材的群聊记录 */
  function loadFromStorage() {
    genToken++; // 切书：作废进行中的生成（否则旧书的台词会写进新书的数组、并落盘到新书的键）
    groupLessonId = null; // 切书后旧课时的群聊"上课记录"来源作废
    groupReviewedKey = null; // 复盘归属也一并作废（复合键已能区分跨书，这里是显式对称）
    const bk = getBookKey();
    if (!bk) { groupMessages = []; return; }
    try { groupMessages = JSON.parse(localStorage.getItem(bookLS(bk, "group"))) || []; } catch (e) { groupMessages = []; }
    // 导入的历史备份可能是旧 schema / 非数组，兜底成数组避免下游 .filter 崩
    if (!Array.isArray(groupMessages)) groupMessages = [];
    groupMessages = groupMessages.filter((m) => !(m.status && m.thinking)); // 群聊"等待中"不落盘，加载时兜底清理
  }

  // 20260913 删掉三个零消费者的对外方法：clearMessages / getMessages / getLessonId。
  // 全库 grep 各自只命中定义与导出本身（宿主一处都没调）。清空发生在 openGroup 内部
  // （它直接 `groupMessages = []` 并自增 genToken 作废进行中的生成），不需要对外开口子。
  return {
    openGroup,
    closeGroup,
    sendGroup,
    renderGroupMessages,
    saveGroupChat,
    loadFromStorage,
    parseGroupLines, // 纯函数（导出给单测用；注：本模块目前【没有】测试文件，见下）
  };
}
// 注：parseGroupLines 的注释原本写"便于单测"，但 js/ 下并没有 group 的测试文件 ——
// 那是一句没有兑现的话（与 findLessonById 那条假注释同类）。留着导出无害，
// 但它解析的是模型输出（最容易出畸形数据的地方），值得补一组测试，而不是靠注释暗示已覆盖。

