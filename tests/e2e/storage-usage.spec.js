const { test, expect } = require("@playwright/test");

// 「本地存储用量」面板的计量口径测试。
//
// 背景：localStorage 的配额按【UTF-16 码元数】计，不是按字节 —— 实测（Chromium 二分逼近
// setItem 抛 QuotaExceededError 的边界）：纯 ASCII 与纯中文各自都能存到 5,242,880 个字符，
// 上限完全一致；若按字节计，中文上限应恰好只有 ASCII 的一半。而 5*1024*1024 正是码元上限。
//
// 旧实现把码元数 ×2 当"字节"再除以 5MiB → 占用率报成真实的 2 倍：进度条显示 100% 时实际
// 只用了 50%，85% 变红实际才 42.5%。本用例锁死新口径，防止被改回去。

test.describe.configure({ timeout: 60000 });

const QUOTA_UNITS = 5 * 1024 * 1024; // 5,242,880 个 UTF-16 码元
const PROBE_KEY = "socratopia_storage_probe";

// 往应用自身的源写入指定「码元总量」的假数据，再 reload（初始化会重算用量）
async function seedUnits(page, totalUnits) {
  await page.evaluate(({ key, totalUnits }) => {
    localStorage.clear();
    localStorage.setItem(key, "x".repeat(totalUnits - key.length));
  }, { key: PROBE_KEY, totalUnits });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#bookList")).toContainText("我的第一门课程");
}

const readPanel = (page) => page.evaluate(() => ({
  text: document.querySelector("#storageUsage").textContent,
  width: document.querySelector("#storageBarFill").style.width,
  cls: document.querySelector("#storageBarFill").className,
}));

test.describe("本地存储用量 · 计量口径", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("我的第一门课程");
  });

  test("百分比 = 真实占用率，不按字节重复计数（旧口径会翻倍）", async ({ page }) => {
    await seedUnits(page, 500000);
    const p = await readPanel(page);
    const expectPct = Math.round(500000 / QUOTA_UNITS * 100); // 10%
    // 旧口径会显示 19%：断言精确到 10%，直接堵住 ×2 回潮
    expect(p.text, "面板文案：" + p.text).toContain(`（${expectPct}%）`);
    expect(p.text).not.toContain("19%");
    expect(p.width).toBe(expectPct + "%");
    expect(p.cls).toBe(""); // 未越阈值不加 danger
    // 显示单位是「字符」而非「MB」：配额本身按字符算，报 MB 会再引入歧义
    expect(p.text).not.toContain("MB");
  });

  test("越过 85% 阈值时进度条转红，且用量文案与配额同量纲", async ({ page }) => {
    await seedUnits(page, 4500000); // 85.8% → 86%
    const p = await readPanel(page);
    expect(p.text).toContain(`（${Math.round(4500000 / QUOTA_UNITS * 100)}%）`);
    expect(p.cls).toBe("danger");
    expect(p.text).toContain("524.3 万字符"); // 上限口径 = 5*1024*1024 码元
  });

  test("塞到浏览器真实上限时显示 ~100%（口径对齐的最终证明）", async ({ page }) => {
    const filled = await page.evaluate(({ QUOTA }) => {
      localStorage.clear();
      const key = "socratopia_storage_probe";
      const works = (n) => { try { localStorage.setItem(key, "x".repeat(n)); return true; } catch (e) { return false; } };
      let lo = 0, hi = QUOTA * 2;
      while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (works(mid)) lo = mid; else hi = mid; }
      return { accepted: lo, refusedMore: !works(lo + 10000) };
    }, { QUOTA: QUOTA_UNITS });

    // 前提校验：浏览器确实按码元计（上限 ≈ 5*1024*1024），否则后面读数无意义
    expect(filled.refusedMore).toBe(true);
    expect(filled.accepted).toBeGreaterThan(QUOTA_UNITS * 0.99);

    // 面板文案是初始化时渲染的，必须先重载才会用新用量重算
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("我的第一门课程");
    const p = await readPanel(page);
    const pct = Number((p.text.match(/（(\d+)%）/) || [])[1]);
    expect(pct).toBeGreaterThanOrEqual(99);
    expect(pct).toBeLessThanOrEqual(100);
    expect(p.cls).toBe("danger");
  });
});
