/* =====================================================================
 *  Socratopia v0 · 状态中心单元测试（node js/store.test.mjs）
 *  ---------------------------------------------------------------------
 *  安全网：20260904.1 把教材上下文 / 学习数据从 app.js 的 61 个模块级 let
 *  收敛进 js/store.js。这里锁住两件事：
 *    1) 状态字段的默认值不能被悄悄改掉（改名会让 app.js 读到 undefined）；
 *    2) 工厂模式确实产出互不干扰的实例（否则单测之间会串味）。
 *  键名格式 bookLS 也一并锁住——它决定了 localStorage 里的数据能不能被读回来。
 * ===================================================================== */
import { createStore, bookLS, safeTopicMap } from "./store.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}
function eq(name, a, b) { ok(name + " (得到 " + JSON.stringify(a) + ")", a === b); }

console.log("createStore 默认状态");
{
  const S = createStore().state;
  eq("library 默认空数组", Array.isArray(S.library) && S.library.length, 0);
  eq("currentBook 默认 null", S.currentBook, null);
  eq("currentLessonId 默认 null", S.currentLessonId, null);
  eq("selectedLessonId 默认 null", S.selectedLessonId, null);
  eq("activeSessionBookId 默认 null", S.activeSessionBookId, null);
  ok("memory 默认含 topics 容器", S.memory && typeof S.memory.topics === "object" && S.memory.topics !== null);
  eq("collection 默认空数组", Array.isArray(S.collection) && S.collection.length, 0);
}

console.log("createStore 实例隔离（工厂模式的价值所在）");
{
  const a = createStore();
  const b = createStore();
  a.state.currentBook = { id: "book-A" };
  eq("a 写入不影响 b", b.state.currentBook, null);
  eq("b 写入不回写 a", a.state.currentBook.id, "book-A");
  ok("两个实例 state 不是同一对象", a.state !== b.state);
  ok("两个实例 memory.topics 不是同一对象", a.state.memory.topics !== b.state.memory.topics);
}

console.log("createStore initial 覆盖（单测注入用）");
{
  const S = createStore({ currentBook: { id: "x" }, library: [{ id: 1 }] }).state;
  eq("覆盖 currentBook", S.currentBook.id, "x");
  eq("覆盖 library", S.library.length, 1);
  eq("未覆盖字段回落默认值", S.currentLessonId, null);
}

console.log("safeTopicMap —— 键是课程标题，撞上 Object.prototype 就会丢记忆");
{
  // 这是真实踩过的 bug：课程改名为 toString / __proto__ 后，
  // `topics[key] || {...}` 会取到原型链上的方法（真值），记忆被写到共享对象上。
  const m = safeTopicMap({ 经济学: { mastered: ["供需"] } });
  eq("原型为 null", Object.getPrototypeOf(m), null);
  eq("自有键照常拷贝", m["经济学"].mastered.length, 1);
  eq("撞 toString 时取到 undefined（= 没有记忆），而不是继承来的函数", m["toString"], undefined);
  eq("撞 constructor 同样安全", m["constructor"], undefined);
  eq("撞 __proto__ 同样安全", m["__proto__"], undefined);
  eq("没有污染 Object.prototype", ({}).mastered, undefined);

  // 真的往里写一个 __proto__ 键：必须是普通自有键，不能改原型
  const m2 = safeTopicMap();
  m2["__proto__"] = { mastered: ["x"] };
  eq("__proto__ 成为普通自有键", Object.keys(m2).length, 1);
  eq("写入 __proto__ 不改动该对象原型", Object.getPrototypeOf(m2), null);
  eq("写入 __proto__ 不污染全局", ({}).mastered, undefined);

  // localStorage 往返：JSON.parse 出来是普通对象（原型又回来了），必须再过一次 safeTopicMap
  const stored = JSON.stringify({ 数学: { weak: ["极限"] } });
  const parsed = JSON.parse(stored);
  eq("JSON.parse 的结果是普通对象（所以才需要重建成无原型）", Object.getPrototypeOf(parsed), Object.prototype);
  const roundTrip = safeTopicMap(parsed);
  eq("重建后撞 toString 安全", roundTrip["toString"], undefined);
  eq("重建后自有键仍在", roundTrip["数学"].weak[0], "极限");

  eq("非对象入参得到空映射", Object.keys(safeTopicMap(null)).length, 0);
  eq("数组入参按自有键拷贝（不继承 Array 方法）", safeTopicMap([1, 2])["push"], undefined);
}

console.log("createStore 的 memory.topics 必须是无原型映射（防止原型污染复发）");
{
  const S = createStore().state;
  eq("默认 topics 原型为 null", Object.getPrototypeOf(S.memory.topics), null);
  eq("默认 topics 撞 toString 安全", S.memory.topics["toString"], undefined);
}

console.log("bookLS 键名格式（决定能否读回旧数据，不可随意改）");
{
  eq("教材隔离键带 socratopia_ 前缀与 kind", bookLS("abc", "memory"), "socratopia_memory_abc");
  eq("chat 键", bookLS("bk1", "chat"), "socratopia_chat_bk1");
  eq("课时键", bookLS("bk1", "lesson_ch1_L2"), "socratopia_lesson_ch1_L2_bk1");
  ok("不同教材键不同", bookLS("a", "chat") !== bookLS("b", "chat"));
  ok("同教材不同 kind 键不同", bookLS("a", "chat") !== bookLS("a", "group"));
}

console.log("");
if (fail > 0) { console.error(`store 测试失败：${fail} 项`); process.exit(1); }
console.log(`store 测试全部通过 ✓ (${pass} 项)`);
