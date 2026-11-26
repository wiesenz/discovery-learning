// 用户画像（因材施教）合并逻辑——纯函数，便于单测。
//
// 数据模型：
//   GLOBAL_PROFILE = { entries:[Entry], updatedAt }
//   Entry = {
//     id, source:'ai'|'user',
//     dimension: 学习风格|思维习惯|性格倾向|适合的引导|知识基础|其它观察,
//     content, ts, status:'active'|'demoted'|'archived', reason?
//   }
// 全局画采用【条目式】模型，让「AI 自动提炼」与「用户手动修改」和平共处：
//   - source='ai'  ：AI 在复习/下课小结时从对话推断并写入（用户可见、可改、可删、可"不准"）
//   - source='user'：用户主动填写，或聊天中说「记住我 XX」即时写入
//   - 每条可单独编辑 / 删除 / 不准 / 合并到另一条 / 进回收站
//   - AI 只追加自己的条目，绝不整块覆盖、也不会改写用户条目
//   - "不准" = demote：该内容进入 demoted 清单，下次 AI 输出会绕开类似描述
//   - 回收站 = archive：合并/重构时旧条目进 archive，可手动恢复
//   - 这样既满足「AI 提炼到学习画像」，又满足「用户可看可改」，且换书不归零

// 日期一律走本地时区（js/dom.js 的唯一实现）。
// 20260913 修：本模块此前两处用 `new Date().toISOString().slice(0,10)` —— 那是 UTC，
// 在 UTC+8 的本地 00:00–08:00 之间会返回昨天，导致画像 updatedAt 记错一天并被渲染给用户。
// app.js 早就修过这个 bug（注释还在），是本文件漏改了。
import { todayISO } from "./dom.js";

const GLOBAL_PROFILE_KEY = "socratopia_global_profile"; // 保留历史键名，向后兼容
export const MAX_AI_ENTRIES = 30; // AI 推断条目上限，避免无限增长（仅限制 AI 推断条目；用户手动写的条目不限）

// 维度注册表：标签 + 色板（色板同步给前端 styles.css）
// 顺序就是前端分组的展示顺序。改这里会自动影响 UI 分组。
export const DIMENSIONS = [
  { id: "learning_style", label: "学习风格",   short: "风格", hint: "偏视觉/听觉/动手/阅读？举例子/拆步骤/类比？", color: "#3b82f6" },
  { id: "thinking_habit", label: "思维习惯",   short: "习惯", hint: "思考节奏、答题偏好、卡住时的反应等",         color: "#8b5cf6" },
  { id: "personality",    label: "性格倾向",   short: "性格", hint: "耐心程度、完美主义、风险态度等",             color: "#06b6d4" },
  { id: "guide",          label: "适合的引导", short: "引导", hint: "老师用什么节奏/方式讲这位学员最容易接受",   color: "#f59e0b" },
  { id: "knowledge_base", label: "知识基础",   short: "基础", hint: "已掌握 / 薄弱 / 易错点的领域",               color: "#10b981" },
  { id: "general",        label: "其它观察",   short: "其它", hint: "暂未归入以上维度的观察",                     color: "#6b7280" },
];
const DIM_INDEX = Object.fromEntries(DIMENSIONS.map((d) => [d.id, d]));
function normDim(d) { return DIM_INDEX[d] ? d : "general"; }

function norm(s) {
  return (s || "").toLowerCase().replace(/\s+/g, "");
}

function genId() {
  return "gp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
}

// 把任意 entry 对象规整成符合 schema 的形式（兼容老数据：缺字段补默认）
function normalizeEntry(e) {
  if (!e || typeof e !== "object") return null;
  const id = e.id || genId();
  const source = e.source === "ai" ? "ai" : "user";
  const content = (e.content || "").trim();
  if (!content) return null;
  return {
    id,
    source,
    dimension: normDim(e.dimension),
    content,
    ts: typeof e.ts === "number" ? e.ts : Date.now(),
    status: e.status === "demoted" || e.status === "archived" ? e.status : "active",
    reason: e.reason || null,
  };
}

// 把整个 profile 对象规整成符合 schema 的形式
function normalizeProfile(p) {
  if (!p || typeof p !== "object") return null;
  const list = Array.isArray(p.entries) ? p.entries : [];
  const entries = list.map(normalizeEntry).filter(Boolean);
  return { entries, updatedAt: p.updatedAt || todayISO() };
}

export function loadGlobalProfile() {
  try {
    const raw = localStorage.getItem(GLOBAL_PROFILE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return normalizeProfile(p);
  } catch (e) {
    return null;
  }
}

function saveEntries(entries) {
  const p = { entries: Array.isArray(entries) ? entries : [], updatedAt: todayISO() };
  try { localStorage.setItem(GLOBAL_PROFILE_KEY, JSON.stringify(p)); } catch (e) {}
  return p;
}

// 写一条新条目。content 必填，source/dimension 可省。
// 同 source + 同 content 不重复追加。
export function addGlobalEntry(content, source = "user", dimension = "general") {
  content = (content || "").trim();
  if (!content) return loadGlobalProfile() || { entries: [] };
  const p = loadGlobalProfile() || { entries: [] };
  const dim = normDim(dimension);
  // 同 source + 同 dimension 下完全一致的条目不重复追加（跨维度不互斥）
  if (p.entries.some((e) => e.source === source && e.dimension === dim && norm(e.content) === norm(content))) return p;
  p.entries.push({
    id: genId(),
    source,
    dimension: dim,
    content,
    ts: Date.now(),
    status: "active",
  });
  // AI 推断条目上限：保留最近 MAX_AI_ENTRIES 条 active 状态
  if (source === "ai") {
    const activeAi = p.entries.filter((e) => e.source === "ai" && e.status === "active");
    if (activeAi.length > MAX_AI_ENTRIES) {
      const drop = new Set(activeAi.slice(0, activeAi.length - MAX_AI_ENTRIES).map((e) => e.id));
      p.entries = p.entries.filter((e) => !drop.has(e.id));
    }
  }
  return saveEntries(p.entries);
}

// 更新条目文本（dimension 不可改，content 为空 = 删除）
export function updateGlobalEntry(id, content) {
  content = (content || "").trim();
  const p = loadGlobalProfile();
  if (!p) return null;
  const e = p.entries.find((x) => x.id === id);
  if (!e) return p;
  if (!content) return removeGlobalEntry(id);
  e.content = content;
  return saveEntries(p.entries);
}

export function removeGlobalEntry(id) {
  const p = loadGlobalProfile();
  if (!p) return null;
  p.entries = p.entries.filter((e) => e.id !== id);
  return saveEntries(p.entries);
}

export function clearGlobalProfile() {
  return saveEntries([]);
}

// 把多条 AI 条目合并到 target：
//   - target 保留并 active
//   - sources 进 archive（status='archived'），可在回收站恢复
// 返回最新的 profile
export function mergeEntries(targetId, sourceIds, mergedContent) {
  const p = loadGlobalProfile();
  if (!p) return null;
  const target = p.entries.find((x) => x.id === targetId);
  if (!target) return p;
  const ids = Array.isArray(sourceIds) ? sourceIds : [sourceIds];
  if (mergedContent && mergedContent.trim()) target.content = mergedContent.trim();
  ids.forEach((sid) => {
    if (sid === targetId) return;
    const s = p.entries.find((x) => x.id === sid);
    if (!s) return;
    s.status = "archived";
    s.reason = "merged-into:" + targetId;
  });
  return saveEntries(p.entries);
}

// 「不准」：把这条 AI 推断的画像标 demoted——
//   - status 变 'demoted'，不再参与画像渲染与 system 注入
//   - 内容进 demoted 清单，下次 AI 输出会绕开类似描述
export function demoteEntry(id, reason) {
  const p = loadGlobalProfile();
  if (!p) return null;
  const e = p.entries.find((x) => x.id === id);
  if (!e || e.source !== "ai") return p;
  e.status = "demoted";
  e.reason = reason || "user-marked-incorrect";
  return saveEntries(p.entries);
}

// 撤回「不准」：恢复成 active
export function undemoteEntry(id) {
  const p = loadGlobalProfile();
  if (!p) return null;
  const e = p.entries.find((x) => x.id === id);
  if (!e) return p;
  e.status = "active";
  e.reason = null;
  return saveEntries(p.entries);
}

// 归档 / 恢复（给「让 AI 重新梳理」和「合并」用）
export function archiveEntry(id, reason) {
  const p = loadGlobalProfile();
  if (!p) return null;
  const e = p.entries.find((x) => x.id === id);
  if (!e) return p;
  e.status = "archived";
  e.reason = reason || "user-archive";
  return saveEntries(p.entries);
}

export function restoreEntry(id) {
  const p = loadGlobalProfile();
  if (!p) return null;
  const e = p.entries.find((x) => x.id === id);
  if (!e) return p;
  e.status = "active";
  e.reason = null;
  return saveEntries(p.entries);
}

// 取出所有 demoted 内容的字符串列表（喂给 AI 提示词，让它下次别再写类似内容）
export function getDemotedContents() {
  const p = loadGlobalProfile();
  if (!p) return [];
  return p.entries.filter((e) => e.status === "demoted").map((e) => e.content);
}

// 取所有 active 条目（用于渲染 & 注入 system）
export function getActiveEntries() {
  const p = loadGlobalProfile();
  if (!p) return [];
  return p.entries.filter((e) => e.status === "active");
}

// 取归档条目（回收站）
export function getArchivedEntries() {
  const p = loadGlobalProfile();
  if (!p) return [];
  return p.entries.filter((e) => e.status === "archived");
}

// 取被标「不准」的条目（20260913 新增：此前 demoted 的条目在 UI 上【无处可见】——
// 点「不准」后就永久消失了，既不在 active 列表、也不在回收站，而 undemoteEntry
// 是个从未被调用的死导出。误点一下就无法挽回，且因为去重会命中它，那句话再也写不回来。）
export function getDemotedEntries() {
  const p = loadGlobalProfile();
  if (!p) return [];
  return p.entries.filter((e) => e.status === "demoted");
}

// 按维度分组 active 条目（供 UI 渲染 + system 注入）
export function groupByDimension(entries) {
  const groups = {};
  DIMENSIONS.forEach((d) => { groups[d.id] = []; });
  (entries || []).forEach((e) => {
    const k = normDim(e.dimension);
    if (!groups[k]) groups[k] = [];
    groups[k].push(e);
  });
  return groups;
}

// AI 课后观察并入全局画像（source='ai'）。
// 新格式：obs = { entries: [{ dimension, content, why? }] }
// 旧格式（兼容）：obs = { habits:[], personality:'', adaptive:'' } —— 标 dimension=legacy-* 并入
// 返回 { profile, added }：added 是本次实际新写入的条目数（去重后）
export function addAiObservations(obs) {
  if (!obs || typeof obs !== "object") return { profile: loadGlobalProfile() || { entries: [] }, added: 0 };
  const before = loadGlobalProfile() || { entries: [] };
  const beforeIds = new Set(before.entries.map((e) => e.id));
  let p = before;
  const tryAdd = (content, dim) => {
    const oldLen = (loadGlobalProfile() || { entries: [] }).entries.length;
    p = addGlobalEntry(content, "ai", dim);
    const newLen = p.entries.length;
    return newLen > oldLen; // 返回是否真新增了
  };
  // 新格式：每条带 dimension
  if (Array.isArray(obs.entries)) {
    obs.entries.forEach((it) => {
      if (!it || typeof it !== "object") return;
      const content = (it.content || "").trim();
      if (!content) return;
      tryAdd(content, normDim(it.dimension));
    });
    const after = loadGlobalProfile() || { entries: [] };
    const added = after.entries.filter((e) => !beforeIds.has(e.id)).length;
    return { profile: after, added };
  }
  // 旧格式兼容：把 habits/personality/adaptive 三个字段拆成条目
  if (Array.isArray(obs.habits)) obs.habits.forEach((h) => { if ((h || "").trim()) tryAdd(h.trim(), "thinking_habit"); });
  if (obs.personality && obs.personality.trim()) tryAdd(obs.personality.trim(), "personality");
  if (obs.adaptive && obs.adaptive.trim()) tryAdd(obs.adaptive.trim(), "guide");
  const after = loadGlobalProfile() || { entries: [] };
  const added = after.entries.filter((e) => !beforeIds.has(e.id)).length;
  return { profile: after, added };
}

// 「让 AI 重新梳理」专用：把当前所有 active AI 条目归档为一批，
// 让调用方拿着 AI 给出的新版 entries 数组，调 commitRestructuredAiEntries 落库。
export function archiveAllActiveAi(reason) {
  const p = loadGlobalProfile();
  if (!p) return null;
  p.entries.forEach((e) => {
    if (e.source === "ai" && e.status === "active") {
      e.status = "archived";
      e.reason = reason || "restructure";
    }
  });
  return saveEntries(p.entries);
}

// 接 AI 重新梳理后的新条目，写回；用户条目保留不动。
// newAiEntries: [{ dimension, content }]
export function commitRestructuredAiEntries(newAiEntries) {
  let p = archiveAllActiveAi("restructure");
  if (!Array.isArray(newAiEntries)) return p || { entries: [] };
  (newAiEntries || []).forEach((it) => {
    if (!it || typeof it !== "object") return;
    const content = (it.content || "").trim();
    if (!content) return;
    p = addGlobalEntry(content, "ai", normDim(it.dimension));
  });
  return p;
}

// 全局条目 + 本课观察合并成注入 system 提示词的文本块。
// 全局条目按维度分组呈现（更结构化，便于 AI 选用）；本课观察作为「本次特殊观察」单列。
export function composeProfileBlock(globalProfile, topicProfile) {
  const lines = [];
  const gp = globalProfile && typeof globalProfile === "object" ? globalProfile : null;
  if (gp && Array.isArray(gp.entries) && gp.entries.length) {
    const active = gp.entries.filter((e) => e.status === "active");
    if (active.length) {
      lines.push("【跨课本全局画像（按维度分组，作为因材施教的工作假设）】");
      const groups = groupByDimension(active);
      DIMENSIONS.forEach((d) => {
        const list = groups[d.id] || [];
        if (!list.length) return;
        const userOnes = list.filter((e) => e.source === "user");
        const aiOnes = list.filter((e) => e.source === "ai");
        if (!userOnes.length && !aiOnes.length) return;
        lines.push("【" + d.label + "】");
        userOnes.forEach((e) => lines.push("- （学习者自述）" + e.content));
        aiOnes.forEach((e) => lines.push("- （AI 推断）" + e.content));
      });
    }
  }
  if (topicProfile && typeof topicProfile === "object") {
    const topicLines = [];
    if (Array.isArray(topicProfile.habits) && topicProfile.habits.length) topicLines.push("- 本课观察·思维习惯：" + topicProfile.habits.join("；"));
    if (topicProfile.personality) topicLines.push("- 本课观察·性格倾向：" + topicProfile.personality);
    if (topicProfile.adaptive) topicLines.push("- 本课观察·适合引导：" + topicProfile.adaptive);
    if (topicProfile.entries && Array.isArray(topicProfile.entries)) {
      topicProfile.entries.forEach((it) => {
        if (it && it.content) {
          const dim = DIM_INDEX[it.dimension] || DIM_INDEX.general;
          topicLines.push("- 本课观察·" + dim.label + "：" + it.content);
        }
      });
    }
    if (topicLines.length) {
      lines.push("");
      lines.push("【本课即时观察（仅本次）】");
      lines.push(...topicLines);
    }
  }
  if (!lines.length) return "";
  return lines.join("\n") +
    "\n\n把这当作对这位学习者的【工作假设】，用来选择更贴合的比喻、节奏与鼓励方式，并在对话中持续验证、修正；不要向学习者复述这份画像。";
}

// 从用户句子里抽取「记住我 XX / 记住：XX / 记住 XX」的待记录内容。
// 仅当显式出现「记住」关键词才触发，避免误吞普通对话。
export function extractRememberText(text) {
  if (!text) return null;
  const m = text.match(/记住(?:我|一下|住)?[:：,，]?\s*(.+?)[。.!?！？；;]?\s*$/);
  if (m && m[1].trim()) return m[1].trim();
  return null;
}
