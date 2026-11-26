/* =====================================================================
 *  Socratopia v0 · 学习画像 UI 层（设置页「我的学习画像」）
 *  20260906.1 从 app.js 抽出（技术债拆分第五刀）。
 *
 *  分工：js/profile.js 只管数据（增删改查、归档、AI 观察落库），
 *        本模块只管视图（按维度分组渲染、卡片编辑、合并对话框、AI 重新梳理）
 *        与自身交互状态。两者靠 import 解耦，不必经宿主中转。
 *
 *  设计：与 group.js / roles.js / quiz.js 同构 —— 画像面板自己的
 *  交互状态（editingProfileId / activeProfileTab / collapsedProfileGroups /
 *  profileArchiveVisible）收敛在 createProfileUI() 闭包内；只有真正属于宿主的
 *  能力（toast / callAPIWith / escapeHtml / 设置面板）走 deps 注入。
 *
 *  用法：
 *    const profileUI = createProfileUI({ els, toast, callAPIWith, escapeHtml });
 *    profileUI.bindEvents();     // 装配时调用一次
 *    profileUI.render();         // 数据变更后重绘
 * ===================================================================== */
import {
  MAX_AI_ENTRIES,
  DIMENSIONS,
  loadGlobalProfile,
  addGlobalEntry,
  updateGlobalEntry,
  removeGlobalEntry,
  clearGlobalProfile,
  mergeEntries,
  demoteEntry,
  undemoteEntry,
  restoreEntry,
  getDemotedContents,
  getDemotedEntries,
  getActiveEntries,
  getArchivedEntries,
  groupByDimension,
  commitRestructuredAiEntries,
} from "./profile.js";
// 结构化 JSON 输出需要显式给足输出预算（否则落 provider 默认 4096，见 config.js 的
// limits.structuredOutputMaxTok），与 js/roles.js 同款用法。
import { APP_CONFIG } from "../config.js";

// AI 重新梳理时的系统提示词（prompt 较长，单独放常量，避免淹没主流程）
const RESTRUCTURE_SYSTEM_PROMPT =
  "你是一个用户学习画像压缩器。输入是一组 AI 之前对这位学习者的观察条目（每条带维度标签）。\n" +
  "任务：把它们去重、合并、精炼成更短、更结构化的画像列表（不超过 8 条）。\n" +
  "要求：\n" +
  "- 保留有信号、有差异的观察；去掉冗余、互相重复的\n" +
  "- 每条 1~2 句话，要具体、有据\n" +
  "- 维度必须从以下 6 个选一个：learning_style / thinking_habit / personality / guide / knowledge_base / general\n" +
  "- 如果某维度没有值得保留的观察，可以省略该维度\n" +
  "- 严格按 JSON 输出，不要加任何解释文字或前后缀\n";

export function createProfileUI(deps) {
  const {
    toast,          // (msg, ms?) => void
    callAPIWith,    // async (messages) => string
    escapeHtml,     // (s) => string
  } = deps;

  // ---- 画像面板私有交互状态（不再散落在 app.js）----
  let editingProfileId = null;             // 当前正在编辑的条目 id
  let activeProfileTab = "all";            // 'all' | 'user' | 'ai'
  const collapsedProfileGroups = new Set(); // 默认全部展开
  let profileArchiveVisible = false;

  // ---- DOM 引用（面板专属元素，模块内自取，不必惊动宿主）----
  // 【20260913 复查结论：保持现状，这是有意的边界，不是遗漏】
  //  · 这些元素（profileGroups / profileArchive / toggleProfile …）只属于画像面板，
  //    是【本模块的私有 UI】，不是宿主共享的 els；宿主从不碰它们。
  //  · 与"整包拿 store 状态"那类问题不同：这里没有越权——模块够得着的只有自己的 DOM。
  //  · 已确认不存在"缓存引用失效"风险：宿主从不重写本模块任何容器的 innerHTML，
  //    所以构造期抓到的节点不会变游离。
  //  · 【20260915】画像原先是挂在设置面板里的一块，openProfilePanel 只能借宿主的
  //    els.settingsPanel 去展开它；画像迁成独立弹窗后，本模块已不再依赖宿主 els
  //    （app.js 的 deps 里不再传），"自给的私有 UI"这条边界到此才是完整的。
  //  · 下面 render/ 等处仍会重新 getElementById —— 那些是"每次渲染重新定位"的防御写法，
  //    代价可忽略；真要统一成构造期引用，应连同两处一起改，别只改一半。
  //  · 契约测试 [1]（ID 契约）会扫本文件，所以这些 id 改名会被护栏拦住。
  const profileAddInput = document.getElementById("profileAddInput");
  const profileAddBtn = document.getElementById("profileAddBtn");
  const profileAddDimension = document.getElementById("profileAddDimension");
  const profileGroups = document.getElementById("profileGroups");
  const profileArchive = document.getElementById("profileArchive");
  const profileShowArchiveBtn = document.getElementById("profileShowArchiveBtn");
  const profileRestructureBtn = document.getElementById("profileRestructureBtn");
  const profileTabs = document.querySelectorAll(".pf-tab");
  const clearProfileBtn = document.getElementById("clearProfile");
  const toggleProfileBtn = document.getElementById("toggleProfile");
  const profileModal = document.getElementById("profileModal");
  const closeProfileBtn = document.getElementById("closeProfile");

  function fmtProfileDate(ts) {
    if (!ts) return "";
    try {
      const d = new Date(ts);
      const now = new Date();
      const sameYear = d.getFullYear() === now.getFullYear();
      const fmt = sameYear
        ? d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })
        : d.toLocaleDateString("zh-CN");
      return fmt;
    } catch (e) { return ""; }
  }

  function render() {
    const groupsBox = document.getElementById("profileGroups");
    const summaryEl = document.getElementById("profileSummary");
    const archiveBtn = document.getElementById("profileShowArchiveBtn");
    const archiveBox = document.getElementById("profileArchive");
    // 底部提示语从常量读取，避免「常量改了文案没跟着改」的漂移
    const footHint = document.getElementById("profileFootHint");
    if (footHint) footHint.textContent = "AI 上限 " + MAX_AI_ENTRIES + " 条；超出会自动丢弃最旧的观察。";
    if (!groupsBox) return;
    // Tab 计数通过下方 setTabNum 按 data-tab 定位按钮，不依赖 id 落点（id 当前在数字 span 上）

    const p = loadGlobalProfile();
    const allActive = getActiveEntries();
    const archived = getArchivedEntries();
    const userCount = allActive.filter((e) => e.source === "user").length;
    const aiCount = allActive.filter((e) => e.source === "ai").length;
    const filtered = activeProfileTab === "user" ? allActive.filter((e) => e.source === "user")
      : activeProfileTab === "ai" ? allActive.filter((e) => e.source === "ai")
        : allActive;

    // 顶部摘要
    if (summaryEl) {
      if (!allActive.length) {
        summaryEl.textContent = "AI 会在上课 / 复习时自动提炼对你的观察，你也可以随时添加、修改或删除。聊天中说「记住 XX」也会即时写入。";
      } else {
        const parts = ["共 " + allActive.length + " 条", "你写 " + userCount + " 条", "AI 推断 " + aiCount + " 条"];
        if (p && p.updatedAt) parts.push("更新于 " + p.updatedAt);
        summaryEl.textContent = parts.join(" · ");
      }
    }

    // Tab 数字 + 激活态（按 data-tab 定位按钮，避免 id 落在数字 span 上导致 querySelector 取空崩溃）
    const setTabNum = (tab, n) => {
      const btn = document.querySelector('.pf-tab[data-tab="' + tab + '"]');
      if (!btn) return;
      const num = btn.querySelector(".pf-tab-num");
      if (num) num.textContent = n;
    };
    setTabNum("all", allActive.length);
    setTabNum("user", userCount);
    setTabNum("ai", aiCount);
    document.querySelectorAll(".pf-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === activeProfileTab);
    });

    // 回收站按钮 + 回收站区
    if (archiveBtn) {
      const badge = archiveBtn.querySelector(".pf-badge");
      if (badge) {
        badge.textContent = archived.length;
        badge.classList.toggle("has", archived.length > 0);
      }
    }
    if (archiveBox) {
      archiveBox.classList.toggle("hidden", !profileArchiveVisible);
      if (profileArchiveVisible) renderArchive();
    }

    // 分组
    if (!filtered.length) {
      const emptyMsg = activeProfileTab === "user"
        ? "还没有你写的画像。在下方输入框里加一条，或在聊天里说「记住 XX」。"
        : activeProfileTab === "ai"
          ? "AI 还没推断出画像。上完一节课点「📚 下课」，AI 会自动提炼。"
          : "还没有画像条目。在下方输入框里加一条，或上完课让 AI 自动提炼。";
      groupsBox.innerHTML = '<div class="profile-groups-empty">' + escapeHtml(emptyMsg) + '</div>';
      return;
    }

    const groups = groupByDimension(filtered);
    groupsBox.innerHTML = DIMENSIONS.map((d) => {
      const list = groups[d.id] || [];
      if (!list.length) return "";
      const isCollapsed = collapsedProfileGroups.has(d.id);
      const cards = list.map((e) => renderProfileCardHtml(e, d)).join("");
      return '<div class="profile-group' + (isCollapsed ? " collapsed" : "") + '" data-dim="' + d.id + '">' +
        '<div class="profile-group-head" data-toggle="' + d.id + '">' +
        '<span class="profile-group-dot dim-dot-' + d.id + '"></span>' +
        '<span class="profile-group-name">' + escapeHtml(d.label) + '</span>' +
        '<span class="profile-group-hint">' + escapeHtml(d.hint) + '</span>' +
        '<span class="profile-group-count">' + list.length + '</span>' +
        '<span class="profile-group-arrow">▼</span>' +
        '</div>' +
        '<div class="profile-group-list">' + cards + '</div>' +
        '</div>';
    }).join("");
  }

  function renderProfileCardHtml(e, dim) {
    const isEditing = editingProfileId === e.id;
    const sourceLabel = e.source === "ai" ? "AI 推断" : "我写的";
    if (isEditing) {
      return '<div class="profile-card editing dim-' + dim.id + '" data-id="' + escapeHtml(e.id) + '">' +
        '<textarea class="profile-card-edit">' + escapeHtml(e.content) + '</textarea>' +
        '<div class="profile-card-row" style="justify-content:flex-end;gap:6px;">' +
        '<button class="pf-card-btn primary pe-save" data-id="' + escapeHtml(e.id) + '" type="button">保存</button>' +
        '<button class="pf-card-btn pe-cancel" type="button">取消</button>' +
        '</div>' +
        '</div>';
    }
    const date = fmtProfileDate(e.ts);
    const meta = date ? date + (e.source === "ai" ? " · 后续可点「不准」反馈" : "") : "";
    let actions = '<div class="profile-card-actions">' +
      '<button class="pf-card-btn pe-edit" data-id="' + escapeHtml(e.id) + '" type="button" title="编辑这条画像">编辑</button>';
    if (e.source === "ai") {
      actions += '<button class="pf-card-btn danger pe-demark" data-id="' + escapeHtml(e.id) + '" type="button" title="告诉 AI 这条不准，下次不再写类似内容">不准</button>';
    }
    actions += '<button class="pf-card-btn pe-merge" data-id="' + escapeHtml(e.id) + '" type="button" title="把其他条目合并进这条">合并</button>' +
      '<button class="pf-card-btn ghost pe-del" data-id="' + escapeHtml(e.id) + '" type="button" title="删除这条画像">删</button>' +
      '</div>';
    return '<div class="profile-card dim-' + dim.id + '" data-id="' + escapeHtml(e.id) + '">' +
      '<div class="profile-card-body">' +
      '<div class="profile-card-row">' +
      '<span class="profile-card-source ' + e.source + '">' + sourceLabel + '</span>' +
      '<div class="profile-card-content">' + escapeHtml(e.content) + '</div>' +
      '</div>' +
      '<div class="profile-card-meta">' + escapeHtml(meta) + '</div>' +
      '</div>' +
      actions +
      '</div>';
  }

  // 「打开画像面板」这一个动作的唯一实现（20260913 抽出）。
  // 此前 showDiffToast 里的「查看画像」按钮是用 document.getElementById("toggleProfile").click()
  // 绕一圈 DOM 去触发本模块自己绑的处理器 —— 同一件事两个入口，一个走 DOM、一个走函数。
  // 现在两处都调这个函数：少一次 DOM 往返，也不再依赖"那个按钮一定还在页面上、还被绑着"。
  // 20260915：画像从设置面板迁出、独立成窗 —— 不再需要"展开宿主面板 + 滚到某一块"，
  // 直接把本模块自己的弹窗打开即可（顺带摘掉了最后一个对宿主 DOM 的依赖）。
  function openProfilePanel() {
    if (!profileModal) return;
    render();
    profileModal.classList.remove("hidden");
  }

  function closeProfilePanel() {
    if (profileModal) profileModal.classList.add("hidden");
  }

  function renderArchive() {
    const box = document.getElementById("profileArchive");
    if (!box) return;
    const archived = getArchivedEntries();
    // 20260913：把「不准」（demoted）也纳入回收站。此前点「不准」= 该条永久消失
    // （不在 active、也不在回收站），而恢复函数 undemoteEntry 从未被任何 UI 调用过。
    const demoted = getDemotedEntries();
    if (!archived.length && !demoted.length) {
      box.innerHTML = '<div class="profile-archive-head"><span>回收站（暂时为空）</span></div>';
      return;
    }
    const row = (e, metaText, btnCls, btnText) => {
      const dim = DIMENSIONS.find((d) => d.id === e.dimension) || DIMENSIONS[DIMENSIONS.length - 1];
      return '<div class="profile-archive-item">' +
        '<span class="profile-group-dot dim-dot-' + dim.id + '"></span>' +
        '<span style="flex:1;min-width:0;">' + escapeHtml(e.content) + '</span>' +
        '<span class="profile-archive-meta">' + escapeHtml(metaText) + " · " + escapeHtml(fmtProfileDate(e.ts)) + '</span>' +
        '<button class="pf-card-btn primary ' + btnCls + '" data-id="' + escapeHtml(e.id) + '" type="button">' + btnText + '</button>' +
        '</div>';
    };
    let items = "";
    if (demoted.length) {
      items += '<div class="profile-archive-head" style="margin-top:0;">' +
        '<span>「不准」的 AI 推断（' + demoted.length + ' 条 · 这些内容不会再写进画像，点恢复即可撤回）</span></div>';
      items += demoted.map((e) => row(e, "已标「不准」", "pe-undemote", "恢复")).join("");
    }
    if (archived.length) {
      items += '<div class="profile-archive-head"' + (demoted.length ? ' style="margin-top:10px;"' : "") + '>' +
        '<span>已归档（' + archived.length + ' 条 · 合并/重新梳理产生的旧条目）</span></div>';
      items += archived.map((e) => row(e, e.reason || "已归档", "pe-restore", "恢复")).join("");
    }
    box.innerHTML = '<div class="profile-archive-head">' +
      '<span>回收站（共 ' + (archived.length + demoted.length) + ' 条，均可恢复）</span>' +
      '<button class="pf-tool ghost" id="profileArchiveHide" type="button">收起</button>' +
      '</div>' +
      '<div class="profile-archive-list">' + items + '</div>';
  }

  // 合并对话框：让用户选多条 active 条目合并到 target
  function openMergeDialog(targetId) {
    const target = getActiveEntries().find((e) => e.id === targetId);
    if (!target) return;
    const others = getActiveEntries().filter((e) => e.id !== targetId);
    if (!others.length) { toast("没有其他条目可以合并"); return; }
    const dimLabel = (DIMENSIONS.find((d) => d.id === target.dimension) || {}).label || "其它";
    const mask = document.createElement("div");
    mask.className = "profile-dialog-mask";
    mask.innerHTML =
      '<div class="profile-dialog" role="dialog" aria-label="合并画像条目">' +
      '<h4>合并到这条画像</h4>' +
      '<p>选中的条目会进回收站（可恢复），本条内容会被你写的新内容替换。原内容：</p>' +
      '<div class="profile-dialog-source"><b>[' + escapeHtml(dimLabel) + ']</b> ' + escapeHtml(target.content) + '</div>' +
      '<p style="margin-top:6px;">按住 Ctrl/Cmd 多选要并入的其他画像：</p>' +
      '<select id="mergeSourceSel" multiple size="6" style="width:100%;padding:6px;border:1px solid var(--line);border-radius:2px;font-family:var(--fb);font-size:12.5px;">' +
      others.map((e) => {
        const dl = (DIMENSIONS.find((d) => d.id === e.dimension) || {}).label || "其它";
        const tag = e.source === "ai" ? "AI" : "我";
        // value 也要转义：同一行的 tag/content 都过了 escapeHtml，只有这里漏了（"同族只守一半"）。
        // e.id 由 js/profile.js 的 normalizeEntry 原样透传存储/导入的 id，导入的备份可以任意构造。
        return '<option value="' + escapeHtml(e.id) + '">[' + escapeHtml(tag + "·" + dl) + '] ' + escapeHtml(e.content.slice(0, 60)) + (e.content.length > 60 ? "…" : "") + '</option>';
      }).join("") +
      '</select>' +
      '<p style="margin-top:6px;">合并后的新内容：</p>' +
      '<textarea id="mergeNewContent" placeholder="把选中的条目合并成一条更精炼的描述">' + escapeHtml(target.content) + '</textarea>' +
      '<div class="profile-dialog-actions">' +
      '<button class="pf-tool" id="mergeCancel" type="button">取消</button>' +
      '<button class="pf-tool" id="mergeConfirm" type="button" style="background:var(--ink2);color:var(--paper);border-color:var(--ink2);">合并</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.querySelector("#mergeCancel").addEventListener("click", close);
    mask.addEventListener("click", (ev) => { if (ev.target === mask) close(); });
    mask.querySelector("#mergeConfirm").addEventListener("click", () => {
      const sel = mask.querySelector("#mergeSourceSel");
      const ids = Array.from(sel.selectedOptions).map((o) => o.value);
      if (!ids.length) { toast("至少选一条要并入的画像"); return; }
      const newContent = mask.querySelector("#mergeNewContent").value.trim();
      if (!newContent) { toast("合并后的内容不能为空"); return; }
      mergeEntries(targetId, ids, newContent);
      close();
      render();
      toast("已合并 " + ids.length + " 条到当前条目，旧条目进回收站");
    });
  }

  // 「让 AI 重新梳理」：把当前 active AI 条目喂给 AI，让它去重/合并/精炼成新版本，旧条目进回收站
  async function restructureProfile() {
    const aiEntries = getActiveEntries().filter((e) => e.source === "ai");
    if (!aiEntries.length) { toast("当前没有 AI 推断的画像可以重新梳理"); return; }
    if (!window.confirm("让 AI 把当前 " + aiEntries.length + " 条 AI 推断压缩成更精炼的版本？旧的会进回收站，可随时恢复。")) return;
    if (typeof callAPIWith !== "function") { toast("AI 接口不可用"); return; }

    const toastEl = document.createElement("div");
    toastEl.className = "profile-diff-toast";
    toastEl.innerHTML = '<div class="profile-diff-title">↻ AI 正在重新梳理画像…</div>' +
      '<div style="color:var(--mist);font-size:11.5px;">把 ' + aiEntries.length + ' 条观察压缩成更精炼的版本</div>';
    document.body.appendChild(toastEl);
    try {
      const demoted = getDemotedContents();
      const sys = RESTRUCTURE_SYSTEM_PROMPT +
        (demoted.length ? "\n以下是用户标记为「不准」的观察，请勿重新写入：\n" + demoted.map((d) => "- " + d).join("\n") + "\n" : "") +
        "\n输出 JSON schema: { \"entries\": [{ \"dimension\": \"<上述6选1>\", \"content\": \"<1~2 句话具体观察>\" }] }";
      const userContent = "当前 AI 观察条目：\n" + aiEntries.map((e) => "[" + e.dimension + "] " + e.content).join("\n");
      const reply = await callAPIWith([
        { role: "system", content: sys },
        { role: "user", content: userContent },
      ], { maxTokens: APP_CONFIG.limits.structuredOutputMaxTok });
      const m = String(reply || "").match(/\{[\s\S]*\}/);
      if (!m) throw new Error("AI 未返回 JSON");
      const obj = JSON.parse(m[0]);
      const newEntries = Array.isArray(obj.entries) ? obj.entries : [];
      if (!newEntries.length) throw new Error("AI 返回的 entries 为空");
      commitRestructuredAiEntries(newEntries);
      render();
      toastEl.innerHTML = '<div class="profile-diff-title">✓ AI 重新梳理完成</div>' +
        '<div class="profile-diff-row"><span>新提炼</span><span>' + newEntries.length + ' 条</span></div>' +
        '<div class="profile-diff-row"><span>已归档</span><span>' + aiEntries.length + ' 条（进回收站）</span></div>' +
        '<div class="profile-diff-actions"><button class="pf-tool" id="profileDiffClose" type="button">好</button></div>';
      toastEl.querySelector("#profileDiffClose").addEventListener("click", () => toastEl.remove());
      setTimeout(() => { if (toastEl.parentNode) toastEl.remove(); }, 8000);
    } catch (e) {
      toastEl.innerHTML = '<div class="profile-diff-title">⚠ 重新梳理失败</div>' +
        '<div style="color:var(--cinnabar);font-size:12px;">' + escapeHtml(e.message || String(e)) + '</div>' +
        '<div class="profile-diff-actions"><button class="pf-tool" id="profileDiffClose" type="button">好</button></div>';
      toastEl.querySelector("#profileDiffClose").addEventListener("click", () => toastEl.remove());
    }
  }

  // 课后 diff toast：右下角提示 AI 提炼了多少新画像、被去重忽略了多少
  function showDiffToast(added, skipped, aiEntries) {
    const el = document.createElement("div");
    el.className = "profile-diff-toast";
    const dimName = (d) => (DIMENSIONS.find((x) => x.id === d) || {}).label || d;
    const preview = (aiEntries || []).filter((e) => e && e.content).slice(0, 3).map((e) => {
      const txt = (e.content || "").toString();
      return '<div style="margin-top:4px;padding-left:8px;border-left:2px solid var(--line);">' +
        '<span style="color:var(--mist);font-size:10.5px;">' + escapeHtml(dimName(e.dimension)) + '</span>' +
        '<div style="color:var(--ink2);">' + escapeHtml(txt.slice(0, 50)) + (txt.length > 50 ? "…" : "") + '</div>' +
        '</div>';
    }).join("");
    el.innerHTML =
      '<div class="profile-diff-title">↻ AI 课后画像提炼</div>' +
      '<div class="profile-diff-row add"><span>✚ 新增</span><span>' + added + ' 条</span></div>' +
      (skipped > 0 ? '<div class="profile-diff-row"><span>↻ 跳过（与已有重复）</span><span>' + skipped + ' 条</span></div>' : '') +
      (preview ? '<div style="margin-top:6px;font-size:11.5px;color:var(--mist);">本节新增预览：</div>' + preview : '') +
      '<div class="profile-diff-actions">' +
      '<button class="pf-tool" id="profileDiffClose" type="button">好</button>' +
      '<button class="pf-tool" id="profileDiffOpen" type="button" style="background:var(--ink2);color:var(--paper);border-color:var(--ink2);">查看画像</button>' +
      '</div>';
    document.body.appendChild(el);
    const close = () => { if (el.parentNode) el.remove(); };
    el.querySelector("#profileDiffClose").addEventListener("click", close);
    el.querySelector("#profileDiffOpen").addEventListener("click", () => {
      close();
      openProfilePanel();
    });
    setTimeout(close, 14000);
  }

  function doAddProfileEntry() {
    if (!profileAddInput) return;
    const v = profileAddInput.value.trim();
    if (!v) return;
    const dim = profileAddDimension ? profileAddDimension.value : "general";
    addGlobalEntry(v, "user", dim);
    profileAddInput.value = "";
    render();
    toast("已记入画像");
  }

  /** 装配期调用一次：绑定画像面板的全部交互 */
  function bindEvents() {
    if (profileAddBtn) profileAddBtn.addEventListener("click", doAddProfileEntry);
    if (profileAddInput) profileAddInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doAddProfileEntry(); }
    });
    profileTabs.forEach((t) => {
      t.addEventListener("click", () => {
        activeProfileTab = t.dataset.tab || "all";
        render();
      });
    });
    if (profileGroups) profileGroups.addEventListener("click", (e) => {
      const t = e.target;
      // 分组折叠/展开
      const head = t.closest && t.closest(".profile-group-head");
      if (head && (!t.closest || !t.closest(".profile-card"))) {
        const dim = head.dataset.toggle;
        if (collapsedProfileGroups.has(dim)) collapsedProfileGroups.delete(dim);
        else collapsedProfileGroups.add(dim);
        render();
        return;
      }
      const id = t.dataset && t.dataset.id;
      if (!id) return;
      if (t.classList.contains("pe-edit")) { editingProfileId = id; render(); }
      else if (t.classList.contains("pe-cancel")) { editingProfileId = null; render(); }
      else if (t.classList.contains("pe-save")) {
        const ta = profileGroups.querySelector(".profile-card.editing .profile-card-edit");
        updateGlobalEntry(id, ta ? ta.value.trim() : "");
        editingProfileId = null;
        render();
      } else if (t.classList.contains("pe-del")) {
        removeGlobalEntry(id);
        editingProfileId = null;
        render();
      } else if (t.classList.contains("pe-demark")) {
        demoteEntry(id, "user-marked-incorrect");
        render();
        toast("已标注「不准」，AI 下次不会再写类似内容");
      } else if (t.classList.contains("pe-merge")) {
        openMergeDialog(id);
      }
    });
    if (profileArchive) profileArchive.addEventListener("click", (e) => {
      const t = e.target;
      if (t.id === "profileArchiveHide") { profileArchiveVisible = false; render(); return; }
      if (t.classList.contains("pe-restore")) {
        restoreEntry(t.dataset.id);
        render();
        return;
      }
      // 撤回「不准」：该条恢复为 active，重新参与画像渲染与 system 注入
      if (t.classList.contains("pe-undemote")) {
        undemoteEntry(t.dataset.id);
        render();
        toast("已恢复，这条推理重新参与画像");
      }
    });
    if (profileShowArchiveBtn) profileShowArchiveBtn.addEventListener("click", () => {
      profileArchiveVisible = !profileArchiveVisible;
      render();
    });
    if (profileRestructureBtn) profileRestructureBtn.addEventListener("click", restructureProfile);
    if (clearProfileBtn) clearProfileBtn.addEventListener("click", () => {
      if (window.confirm("确定清除全部学习画像？这不会影响 AI 在本课已积累的观察（仅清空跨课本全局画像）。")) {
        editingProfileId = null;
        clearGlobalProfile();
        render();
        toast("已清除画像");
      }
    });
    // 🧭 我的画像：打开画像弹窗（20260915 起独立成窗），支持关闭按钮与点遮罩关闭
    if (toggleProfileBtn) toggleProfileBtn.addEventListener("click", openProfilePanel);
    if (closeProfileBtn) closeProfileBtn.addEventListener("click", closeProfilePanel);
    if (profileModal) profileModal.addEventListener("click", (e) => { if (e.target === profileModal) closeProfilePanel(); });
  }

  return {
    render,
    showDiffToast,
    bindEvents,
  };
}
