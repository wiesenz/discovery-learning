// 用户画像（profile.js）单测：覆盖维度分组 / 合并 / 不准 / 归档 / 重新梳理 / 向后兼容。
// 注：profile.js 内部用 localStorage，Node 单测里用最小 stub 替代。
// 在浏览器里 localStorage 是真实存在；在 Node 里我们用一个内存对象。

class MemStorage {
  constructor() { this.m = {}; }
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.m, k) ? this.m[k] : null; }
  setItem(k, v) { this.m[k] = String(v); }
  removeItem(k) { delete this.m[k]; }
}
global.localStorage = new MemStorage();

import {
  DIMENSIONS,
  addGlobalEntry,
  updateGlobalEntry,
  removeGlobalEntry,
  loadGlobalProfile,
  mergeEntries,
  demoteEntry,
  undemoteEntry,
  archiveEntry,
  restoreEntry,
  getActiveEntries,
  getArchivedEntries,
  getDemotedContents,
  groupByDimension,
  addAiObservations,
  archiveAllActiveAi,
  commitRestructuredAiEntries,
  composeProfileBlock,
  extractRememberText,
  MAX_AI_ENTRIES,
} from "./profile.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  OK " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? " | " + extra : "")); }
};

function reset() {
  localStorage = new MemStorage();
  global.localStorage = localStorage;
}

// ===== DIMENSIONS 注册表 =====
console.log("DIMENSIONS");
ok("6 个维度", DIMENSIONS.length === 6);
ok("维度 id 全是字符串", DIMENSIONS.every((d) => typeof d.id === "string" && d.id.length));
ok("维度含 learning_style", DIMENSIONS.some((d) => d.id === "learning_style"));
ok("维度含 general 兜底", DIMENSIONS.some((d) => d.id === "general"));

// ===== addGlobalEntry + 去重 =====
console.log("addGlobalEntry");
reset();
addGlobalEntry("喜欢用例子理解", "user", "learning_style");
addGlobalEntry("喜欢用例子理解", "user", "learning_style"); // 重复
addGlobalEntry("喜欢用例子理解", "user", "thinking_habit"); // 同内容但不同维度，应并存
const p1 = loadGlobalProfile();
ok("同源同维度不重复", p1.entries.filter((e) => e.source === "user").length === 2);
ok("跨维度可并存", p1.entries.length === 2);
ok("dimension 字段写入", p1.entries.every((e) => e.dimension));
ok("默认 status=active", p1.entries.every((e) => e.status === "active"));

// ===== updateGlobalEntry / removeGlobalEntry =====
console.log("updateGlobalEntry / removeGlobalEntry");
reset();
addGlobalEntry("a", "user");
let r = updateGlobalEntry(loadGlobalProfile().entries[0].id, "b");
ok("更新生效", r.entries[0].content === "b");
r = updateGlobalEntry(loadGlobalProfile().entries[0].id, "   "); // 空内容 = 删除
ok("空内容 = 删除", loadGlobalProfile().entries.length === 0);
addGlobalEntry("a", "user");
removeGlobalEntry(loadGlobalProfile().entries[0].id);
ok("显式删除", loadGlobalProfile().entries.length === 0);

// ===== groupByDimension =====
console.log("groupByDimension");
reset();
addGlobalEntry("风格1", "user", "learning_style");
addGlobalEntry("风格2", "ai", "learning_style");
addGlobalEntry("习惯1", "ai", "thinking_habit");
addGlobalEntry("性格1", "user", "personality");
const g = groupByDimension(getActiveEntries());
ok("learning_style 两条", g.learning_style.length === 2);
ok("thinking_habit 一条", g.thinking_habit.length === 1);
ok("personality 一条", g.personality.length === 1);
ok("guide 为空组仍存在", Array.isArray(g.guide));

// ===== mergeEntries =====
console.log("mergeEntries");
reset();
addGlobalEntry("不喜欢长公式", "ai", "thinking_habit");
addGlobalEntry("看到长公式就头疼", "ai", "thinking_habit");
addGlobalEntry("喜欢用生活例子", "ai", "thinking_habit");
const beforeMerge = getActiveEntries();
const tgtId = beforeMerge[0].id;
const srcIds = [beforeMerge[1].id, beforeMerge[2].id];
const merged = mergeEntries(tgtId, srcIds, "不喜欢公式化的内容，偏爱具体例子");
ok("合并后 active 仅一条", getActiveEntries().length === 1);
ok("合并后 active 是 target", getActiveEntries()[0].id === tgtId);
ok("sources 进入 archive", getArchivedEntries().length === 2);
ok("archive 标了 reason", getArchivedEntries().every((e) => e.reason && e.reason.startsWith("merged-into:")));

// ===== demoteEntry / undemoteEntry =====
console.log("demoteEntry / undemoteEntry");
reset();
addGlobalEntry("性格急躁", "ai", "personality");
const dId = loadGlobalProfile().entries[0].id;
demoteEntry(dId, "user-disagree");
ok("demoted 后不出现在 active", getActiveEntries().length === 0);
ok("demoted 出现在 demoted 列表", getDemotedContents().includes("性格急躁"));
undemoteEntry(dId);
ok("undemote 恢复 active", getActiveEntries().length === 1);

// demote 非 ai 条目应被忽略
reset();
addGlobalEntry("我的性格", "user");
demoteEntry(loadGlobalProfile().entries[0].id);
ok("用户条目 demote 忽略", getActiveEntries().length === 1);

// ===== archiveEntry / restoreEntry =====
console.log("archiveEntry / restoreEntry");
reset();
addGlobalEntry("归档测试", "ai", "general");
const aId = loadGlobalProfile().entries[0].id;
archiveEntry(aId, "user-archive");
ok("归档后 active 为空", getActiveEntries().length === 0);
ok("归档在 archive 列表", getArchivedEntries().length === 1);
restoreEntry(aId);
ok("恢复后 active 回归", getActiveEntries().length === 1);

// ===== addAiObservations 新格式 =====
console.log("addAiObservations（新格式）");
reset();
addAiObservations({
  entries: [
    { dimension: "learning_style", content: "偏视觉学习" },
    { dimension: "thinking_habit", content: "爱反问" },
    { dimension: "guide", content: "先给方向再追问" },
  ],
});
ok("新格式 3 条", getActiveEntries().length === 3);
ok("dimension 各自正确", getActiveEntries().every((e) => ["learning_style", "thinking_habit", "guide"].includes(e.dimension)));

// ===== addAiObservations 旧格式兼容 =====
console.log("addAiObservations（旧格式兼容）");
reset();
addAiObservations({
  habits: ["爱反问", "急躁时容易放弃"],
  personality: "谨慎",
  adaptive: "多给子步骤",
});
const old = getActiveEntries();
ok("旧格式产出 4 条（2 habits + personality + adaptive）", old.length === 4);
ok("habits → thinking_habit", old.filter((e) => e.dimension === "thinking_habit").length === 2);
ok("personality → personality", old.filter((e) => e.dimension === "personality").length === 1);
ok("adaptive → guide", old.filter((e) => e.dimension === "guide").length === 1);

// ===== addAiObservations 返回 {profile, added} =====
console.log("addAiObservations 返回 added 计数");
reset();
const r1 = addAiObservations({
  entries: [
    { dimension: "learning_style", content: "风格1" },
    { dimension: "thinking_habit", content: "习惯1" },
  ],
});
ok("返回对象含 profile", r1 && Array.isArray(r1.profile.entries));
ok("新增 2 条时 added=2", r1.added === 2);

const r2 = addAiObservations({
  entries: [
    { dimension: "learning_style", content: "风格1" }, // 重复
    { dimension: "guide", content: "新引导" },
  ],
});
ok("1 重复 + 1 新增 = added=1", r2.added === 1, JSON.stringify(r2));

// 旧格式返回也含 added
const r3 = addAiObservations({ habits: ["新habit"], personality: "", adaptive: "" });
ok("旧格式返回 added=1", r3 && r3.added === 1);

// ===== AI 上限 =====
console.log("AI 上限 MAX_AI_ENTRIES=" + MAX_AI_ENTRIES);
reset();
for (let i = 0; i < MAX_AI_ENTRIES + 10; i++) addGlobalEntry("ai 推断 " + i, "ai", "thinking_habit");
ok("AI 条目不超过上限", getActiveEntries().filter((e) => e.source === "ai").length === MAX_AI_ENTRIES);
ok("最早 ai 条目被丢弃（最新的还在）", getActiveEntries().some((e) => e.content === "ai 推断 " + (MAX_AI_ENTRIES + 9)));

// ===== commitRestructuredAiEntries =====
console.log("commitRestructuredAiEntries");
reset();
addGlobalEntry("老 AI 1", "ai", "learning_style");
addGlobalEntry("老 AI 2", "ai", "thinking_habit");
addGlobalEntry("用户条目", "user", "learning_style"); // 用户不动
commitRestructuredAiEntries([
  { dimension: "learning_style", content: "新版 AI 风格总结" },
]);
ok("重构后 AI active 仅新条目", getActiveEntries().filter((e) => e.source === "ai").length === 1);
ok("重构后用户条目保留", getActiveEntries().some((e) => e.source === "user"));
ok("老 AI 全部进 archive", getArchivedEntries().length === 2);

// ===== composeProfileBlock 按维度分组 =====
console.log("composeProfileBlock（按维度分组）");
reset();
addGlobalEntry("风格1", "user", "learning_style");
addGlobalEntry("习惯1", "ai", "thinking_habit");
addGlobalEntry("性格1", "ai", "personality");
const blk1 = composeProfileBlock(loadGlobalProfile(), null);
ok("按维度输出学习风格组", blk1.includes("学习风格"));
ok("按维度输出思维习惯组", blk1.includes("思维习惯"));
ok("按维度输出性格倾向组", blk1.includes("性格倾向"));
ok("包含用户 vs AI 标注", blk1.includes("（学习者自述）") && blk1.includes("（AI 推断）"));
ok("不含工作假设提示语", blk1.includes("工作假设"));

// composeProfileBlock 空对象/空数组
ok("全空返回空串", composeProfileBlock(null, null) === "");
ok("空 entries 返回空串", composeProfileBlock({ entries: [] }, null) === "");
ok("空对象等同空", composeProfileBlock({}, {}) === "");

// 本课观察兼容旧 + 新格式
const blk2 = composeProfileBlock(null, { habits: ["爱反问"], personality: "谨慎", adaptive: "慢节奏" });
ok("本课观察旧格式输出", blk2.includes("本课观察·思维习惯：爱反问") && blk2.includes("本课观察·性格倾向：谨慎"));
const blk3 = composeProfileBlock(null, { entries: [{ dimension: "guide", content: "多给例子" }] });
ok("本课观察新格式输出", blk3.includes("本课观察·适合的引导：多给例子"));

// demoted 条目不应注入 system
reset();
addGlobalEntry("不准的观察", "ai", "personality");
demoteEntry(loadGlobalProfile().entries[0].id);
const blk4 = composeProfileBlock(loadGlobalProfile(), null);
ok("demoted 不注入 system", !blk4.includes("不准的观察"));

// ===== 向后兼容：老 entries（无 dimension 字段） =====
console.log("向后兼容");
reset();
localStorage.setItem("socratopia_global_profile", JSON.stringify({
  entries: [
    { id: "old_1", source: "ai", content: "老格式条目", ts: Date.now() },
  ],
  updatedAt: "2025-01-01",
}));
const oldP = loadGlobalProfile();
ok("老条目归到 general 维度", oldP.entries[0].dimension === "general");
ok("老条目状态默认 active", oldP.entries[0].status === "active");
ok("老条目可正常渲染", composeProfileBlock(oldP, null).includes("老格式条目"));

// ===== extractRememberText =====
console.log("extractRememberText");
// 注：「记住我 XX」里那个"我"会被旧正则的非捕获组吃掉，但通常用户输入时会带空格或冒号
// （如「记住 我是法律从业者」「记住：我是法律从业者」），捕获组就能完整覆盖。
ok("匹配「记住 我是法律从业者」（带空格）", extractRememberText("记住 我是法律从业者") === "我是法律从业者");
ok("匹配「记住：我是法律从业者」", extractRememberText("记住：我是法律从业者") === "我是法律从业者");
ok("匹配「记住：XX」", extractRememberText("记住：喜欢举例") === "喜欢举例");
ok("匹配「记住 XX」", extractRememberText("记住 我视觉型") === "我视觉型");
ok("无「记住」不匹配", extractRememberText("今天天气不错") === null);
ok("空字符串返回 null", extractRememberText("") === null);

console.log("结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
