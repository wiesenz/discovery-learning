const { test, expect } = require("@playwright/test");

// 主区布局回归测试（20260914 起，替代原 sidebar-collapse.spec.js）。
//
// 背景：顶栏原先有「☰ 侧栏」按钮，点击会给 .layout 加 .sidebar-collapsed 把左栏整块藏起。
// 该功能已下线，理由是它没有实质教学增益，却有真实代价：
//   .layout 是 `grid-template-columns: 340px 1fr`，.sidebar 被 display:none 移出网格后，
//   .chat 成了唯一的网格项，会被自动放进【第一列】—— 而第一列正是 340px 之外被压成 0 的那列。
//   结果聊天区宽度归零，搜索框缩到 24px、消息区 48px，欢迎语 / 消息气泡 /「我的基础：🌱 完全小白」
//   全部逐字竖排成一条窄条（用户在 1279px 宽窗口里看到的那根"竖条"）。
//
// 左栏本体（课程列表 / 踏石留印 / 我的收藏）是应用主干，必须常驻。
// 本用例锁死「固定两列、左栏常在、聊天区不被挤塌」这个不变式。
//
// 注：源码级残留检查（index.html / js/dom.js / app.js / styles.css 里不得再出现
// toggleSidebar 或 sidebar-collapsed）不在这里做 —— spec 经转译后 __dirname 不再指向
// 源文件目录，读文件会 ENOENT。那部分归 js/source-hygiene.test.mjs。

test.describe.configure({ timeout: 60000 });

const readLayout = (page) => page.evaluate(() => {
  const w = (sel) => {
    const el = document.querySelector(sel);
    return el ? Math.round(el.getBoundingClientRect().width) : null;
  };
  const layout = document.querySelector(".layout");
  return {
    cls: layout.className,
    cols: getComputedStyle(layout).gridTemplateColumns,
    viewport: document.documentElement.clientWidth,
    sidebar: w(".sidebar"),
    chat: w(".chat"),
    chatSearch: w(".chat-search"),
    messages: w("#messages"),
  };
});

test.describe("主区布局 · 左栏常驻且聊天区不被挤塌", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("我的第一门课程");
  });

  test("桌面：左栏 340px，聊天区占余下整宽（固定两列）", async ({ page }) => {
    const m = await readLayout(page);
    expect(m.cls).toBe("layout");
    expect(m.sidebar).toBe(340);
    expect(m.chat).toBe(m.viewport - 340);
    // 聊天区内部各块必须与聊天区同宽 —— 一旦整块被打进 0 宽列，这里会缩成 24 / 48px
    expect(m.chatSearch).toBe(m.chat);
    expect(m.messages).toBe(m.chat);
  });

  test("窄屏（<820px）：单列，左栏与聊天区都占整宽", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 700 });
    const m = await readLayout(page);
    expect(m.sidebar).toBe(m.viewport);
    expect(m.chat).toBe(m.viewport);
  });

  test("折叠按钮已下线：顶栏不再有它，布局也不带折叠态", async ({ page }) => {
    expect(await page.locator("#toggleSidebar").count()).toBe(0);
    const m = await readLayout(page);
    expect(m.cls).not.toContain("sidebar-collapsed");
    // 「没有 0 宽列」必须解析成宽度数组再判断。不要写 toContain("0px")：
    // 左栏常驻时列宽形如 `340px 940px`，而 "940px" 这个字符串本身含 "0px"，会误报失败。
    const widths = m.cols.trim().split(/\s+/).map((s) => parseFloat(s));
    expect(widths.length).toBe(2);
    expect(widths.every((w) => w > 0), "不应出现 0 宽列：" + m.cols).toBe(true);
    // 顶栏剩下的都是有用的：主题 / 设置帮助 / 我的画像
    expect(await page.locator(".topbar-actions button").count()).toBeGreaterThanOrEqual(3);
  });
});
