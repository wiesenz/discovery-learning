const { test, expect } = require("@playwright/test");

// 设置弹窗（左标签导航）+ 画像独立弹窗 —— 20260915 的结构改动回归。
//
// 背景：此前设置**不是浮层**，而是插在 topbar 与主界面之间的内嵌 <section>，展开时会把
// 主界面整体向下推；而它内部最长的一块是「我的学习画像」（页签 + 分组 + 回收站 + 添加行），
// 顶栏却另有一个独立的「🧭 我的画像」入口 —— 同一份内容两个门，且都挤在一条长条里。
//
// 现在：设置 → 浮层 + 左侧标签导航（一屏一页）；画像 → 独立弹窗。
// 本 spec 锁四件事：
//   ① 设置真的浮起来了（主界面几何不再被推动）
//   ② 三路关闭都有效（顶栏按钮 / 关闭按钮 / 点遮罩），与其它 9 个浮层同一套约定
//   ③ 页签切换真的切了显示，且始终只有一页激活
//   ④ 「新建角色」弹窗必须压在设置弹窗之上（DOM 层序 —— 同为 z-index:50 时靠出现顺序定胜负）

test.describe.configure({ timeout: 60000 });

test.beforeEach(async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#bookList")).toContainText("我的第一门课程");
});

test("设置是浮层而非内嵌面板：打开不推挤主界面，且可关闭", async ({ page }) => {
  await expect(page.locator("#settingsPanel")).toHaveClass(/hidden/);

  const before = await page.locator(".layout").boundingBox();
  await page.click("#toggleSettings");
  await expect(page.locator("#settingsPanel")).not.toHaveClass(/hidden/);
  // ① 浮层：主界面几何不变（旧的内嵌面板会把它整体下推，这正是"粗糙"的来源之一）
  const after = await page.locator(".layout").boundingBox();
  expect(Math.round(after.y), "设置已改为浮层，主界面不应被推动").toBe(Math.round(before.y));
  expect(Math.round(after.height)).toBe(Math.round(before.height));

  // ② 关闭按钮
  await page.click("#closeSettings");
  await expect(page.locator("#settingsPanel")).toHaveClass(/hidden/);

  // ③ 点遮罩（弹窗外的 overlay 区域，左上角必在遮罩上）
  await page.click("#toggleSettings");
  await page.locator("#settingsPanel").click({ position: { x: 6, y: 6 } });
  await expect(page.locator("#settingsPanel")).toHaveClass(/hidden/);

  // ④ 顶栏按钮仍是开启入口。
  //    注意断言到此为止：浮层打开时整块屏幕都在遮罩之下，顶栏按钮点不到 ——
  //    "再点一次收起"已经不是可用路径（这也是它与其他 9 个浮层一致的语义），
  //    收起一律走关闭按钮或点遮罩。写在这里，免得以后有人按旧内嵌面板的直觉去补那一步。
  await page.click("#toggleSettings");
  await expect(page.locator("#settingsPanel")).not.toHaveClass(/hidden/);
  await expect(page.locator("#settingsPanel")).toBeInViewport();
});

test("左侧标签导航：默认 API 连接，切页后只显示当前页", async ({ page }) => {
  await page.click("#toggleSettings");

  // 默认页：API 连接（填 Key 是最高频动作，必须零点击可达）
  await expect(page.locator("#settingsPanel .settings-pane.active")).toHaveAttribute("data-pane", "api");
  await expect(page.locator("#apiKey")).toBeVisible();
  await expect(page.locator("#roleSelect")).toBeHidden();
  await expect(page.locator("#storageUsage")).toBeHidden();
  await expect(page.locator("#resetApp")).toBeHidden();

  // 切到「角色」
  await page.click('.settings-nav-item[data-pane="role"]');
  await expect(page.locator("#settingsPanel .settings-pane.active")).toHaveAttribute("data-pane", "role");
  await expect(page.locator("#roleSelect")).toBeVisible();
  await expect(page.locator("#apiKey")).toBeHidden();

  // 切到「数据与备份」
  await page.click('.settings-nav-item[data-pane="data"]');
  await expect(page.locator("#storageUsage")).toBeVisible();
  await expect(page.locator("#storageUsage")).toContainText("字符");

  // 切到「危险区」
  await page.click('.settings-nav-item[data-pane="danger"]');
  await expect(page.locator("#resetApp")).toBeVisible();

  // 任何时候都只有一页 / 一个导航项处于激活态
  await expect(page.locator("#settingsPanel .settings-pane.active")).toHaveCount(1);
  await expect(page.locator("#settingsPanel .settings-nav-item.active")).toHaveCount(1);

  // 切页不丢表单值（页签只切 class、不重建 DOM）：
  // 在 API 页写入 → 切走（字段随之隐藏）→ 切回 → 值仍在
  await page.click('.settings-nav-item[data-pane="api"]');
  await page.fill("#apiKey", "sk-keep-me");
  await page.click('.settings-nav-item[data-pane="role"]');
  await expect(page.locator("#apiKey")).toBeHidden();
  await page.click('.settings-nav-item[data-pane="api"]');
  await expect(page.locator("#apiKey")).toHaveValue("sk-keep-me");
});

test("我的画像：独立弹窗，设置面板里不再残留画像块", async ({ page }) => {
  // 设置里已经不该再有画像
  await page.click("#toggleSettings");
  await expect(page.locator("#settingsPanel #profileGroups"), "画像已迁出设置面板").toHaveCount(0);
  await expect(page.locator("#settingsPanel #profileAddInput")).toHaveCount(0);
  await page.click("#closeSettings");

  // 顶栏入口直接开自己的弹窗
  await expect(page.locator("#profileModal")).toHaveClass(/hidden/);
  await page.click("#toggleProfile");
  await expect(page.locator("#profileModal")).not.toHaveClass(/hidden/);
  await expect(page.locator("#profileModal #profileGroups")).toHaveCount(1);
  await expect(page.locator("#profileModal #profileAddInput")).toBeVisible();

  // 关闭按钮
  await page.click("#closeProfile");
  await expect(page.locator("#profileModal")).toHaveClass(/hidden/);

  // 点遮罩
  await page.click("#toggleProfile");
  await page.locator("#profileModal").click({ position: { x: 6, y: 6 } });
  await expect(page.locator("#profileModal")).toHaveClass(/hidden/);
});

test("「新建角色」弹窗压在设置弹窗之上（DOM 层序）", async ({ page }) => {
  await page.click("#toggleSettings");
  await page.click('.settings-nav-item[data-pane="role"]');
  await page.click("#roleNew");
  await expect(page.locator("#roleEditModal")).not.toHaveClass(/hidden/);
  // 关键：同为 z-index:50，靠 DOM 出现顺序定胜负。若设置弹窗排在角色弹窗之后，
  // 这里的 fill 会因「元素被遮挡、收不到事件」而超时失败。
  await expect(page.locator("#roleEditName")).toBeVisible();
  await page.fill("#roleEditName", "层序探针");
  await expect(page.locator("#roleEditName")).toHaveValue("层序探针");
  await page.click("#closeRoleEdit");
  await expect(page.locator("#roleEditModal")).toHaveClass(/hidden/);
});
