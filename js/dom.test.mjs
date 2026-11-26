/* =====================================================================
 *  Socratopia v0 · js/dom.js 的单元测试（node js/dom.test.mjs）
 *  ---------------------------------------------------------------------
 *  只测这个模块里**纯函数**的部分：日期工具与等待文案轮换。
 *  `$` / `createEls()` 依赖真实 DOM，在 Node 里测不了 —— 它们的覆盖来自
 *  契约测试 [1]（ID 契约，扫本模块的每个 $("x")）+ Playwright E2E，不在这里硬凑。
 *
 *  为什么值得单独测这两块：
 *   · 日期：`toISOString()`（UTC）的"差一天"bug 在本项目修过两次（app.js 一次、
 *     js/profile.js 漏改一次），最后才上收成这里的唯一实现。这是需要钉死的坑。
 *   · 轮换：原先 app.js 与 js/group.js 各写一份同样的时序，合并之后它是唯一实现，
 *     更需要锁住 "轮换时刻 / 警告翻转 / 无变化不重绘" 这三条语义。
 * ===================================================================== */
import { pad2, localISO, todayISO, addDays, nextThinkingPhase,
  THINKING_WARN_MS, THINKING_PHASE_MS, THINKING_TICK_MS } from "./dom.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}
function eq(name, a, b) { ok(name + " (得到 " + JSON.stringify(a) + ")", a === b); }

console.log("pad2");
{
  eq("个位数补零", pad2(0), "00");
  eq("个位数补零", pad2(9), "09");
  eq("两位数原样", pad2(10), "10");
  eq("两位数原样", pad2(31), "31");
}

console.log("localISO / todayISO —— 必须是【本地时区】，不能是 UTC");
{
  // 用本地构造的日期来断言，与运行机器的时区无关
  eq("本地 2026-01-01 凌晨 → 2026-01-01", localISO(new Date(2026, 0, 1, 3, 0, 0)), "2026-01-01");
  eq("本地月末", localISO(new Date(2026, 1, 28, 23, 59, 0)), "2026-02-28");
  // 这条是那个 bug 的核心：UTC+8 的凌晨，toISOString 会给出【前一天】。
  // 断言的是"localISO 用本地字段"，而不是"和 UTC 不同"——后者在 UTC 机器上会假失败。
  const earlyMorning = new Date(2026, 0, 1, 3, 0, 0);
  eq("凌晨三点仍是当天（这就是 toISOString 会算错的那个区间）",
    localISO(earlyMorning), "2026-01-01");
  eq("todayISO 与 localISO(new Date()) 一致", todayISO(), localISO(new Date()));
  ok("todayISO 形如 YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(todayISO()));
}

console.log("addDays（间隔复习的日期计算）");
{
  eq("跨月 +1", addDays("2026-01-31", 1), "2026-02-01");
  eq("跨月 -1", addDays("2026-03-01", -1), "2026-02-28");
  eq("闰年 2 月 +1", addDays("2024-02-28", 1), "2024-02-29");
  eq("平年 2 月 +1", addDays("2026-02-28", 1), "2026-03-01");
  eq("跨年 +1", addDays("2026-12-31", 1), "2027-01-01");
  eq("+0 原样", addDays("2026-06-15", 0), "2026-06-15");
  eq("长间隔仍跨年正确", addDays("2026-12-20", 40), "2027-01-29");
}

console.log("nextThinkingPhase —— 轮换时刻 / 警告翻转 / 无变化不重绘");
{
  eq("心跳常量与文档一致（12s 警告 / 2s 换句 / 500ms 心跳）",
    [THINKING_WARN_MS, THINKING_PHASE_MS, THINKING_TICK_MS].join(","), "12000,2000,500");

  // 第 0 拍：还停在第一句，无变化 → 不重绘
  const a = nextThinkingPhase(0, 5, 0, false);
  eq("t=0 仍是第 0 句", a.idx, 0);
  eq("t=0 未到警告阈值", a.warn, false);
  eq("t=0 无变化 → 不重绘", a.changed, false);

  // 每 2000ms 换一句
  eq("t=2000 → 第 1 句", nextThinkingPhase(2000, 5, 0, false).idx, 1);
  eq("t=8000 → 第 4 句", nextThinkingPhase(8000, 5, 3, false).idx, 4);
  eq("t=10000 → 绕回第 0 句（5 句循环）", nextThinkingPhase(10000, 5, 4, false).idx, 0);
  eq("换句算变化 → 要重绘", nextThinkingPhase(2000, 5, 0, false).changed, true);

  // 12s 起进警告态
  eq("t=11999 未到阈值", nextThinkingPhase(11999, 5, 0, false).warn, false);
  eq("t=12000 进入警告态", nextThinkingPhase(12000, 5, 1, false).warn, true);
  eq("warn 翻转也算变化 → 要重绘", nextThinkingPhase(12000, 5, 1, false).changed, true);

  // 警告态下同一句内反复心跳 → 不重绘（否则每 500ms 白写一次 DOM）
  const steady = nextThinkingPhase(12500, 5, 1, true);
  eq("同句同警告态", steady.idx, 1);
  eq("同句同警告态 → 不重绘", steady.changed, false);

  // 防御：文案表为空时不能退化成每 500ms 重绘一次
  const empty = nextThinkingPhase(5000, 0, 0, false);
  eq("空文案表：不重绘", empty.changed, false);
  const emptyWarn = nextThinkingPhase(13000, 0, 0, false);
  eq("空文案表但 warn 翻转：仍要重绘（提醒用户可取消）", emptyWarn.changed, true);
  eq("空文案表不产生 NaN 序号", Number.isNaN(empty.idx), false);
}

console.log("");
if (fail > 0) { console.error(`dom 测试失败：${fail} 项`); process.exit(1); }
console.log(`dom 测试全部通过 ✓ (${pass} 项)`);
