const { test, expect } = require("@playwright/test");

/* =====================================================================
 *  Socratopia E2E · 半句话的归因（20260917）
 *  ---------------------------------------------------------------------
 *  起因是用户的一句反馈：「前一段对话发生了截断，什么原因？」
 *  —— 他在气泡里看到的是停在「你说完这两句，咱就」的**半句话，且没有任何标记**。
 *
 *  根因：chat 是唯一**不读 finish_reason** 的调用点（大纲 / 下课小结都读了、都会说明），
 *  于是两条完全不同的故障都表现为"静默半句"：
 *    · finish_reason=length     → 输出预算用尽
 *    · 从没收到 finish_reason   → 流被网络 / 网关从中间掐断（不抛异常，catch 等不到）
 *
 *  这三条用例把「必须显式说明」和「不得误报」同时钉住：
 *    ① 流被掐断 → 出现「结束标记没收到」提示，且已生成的部分不被吞掉
 *    ② 撞输出上限 → 出现「模型的输出上限」提示
 *    ③ 正常结束 → **不得**出现任何截断提示（防止每条正常回复后面都挂一句假警报）
 *  提示必须排在老师那条回复【之后】，否则读起来像事前预警而不是事后归因。
 *
 *  API 全部打桩，不需要真实 Key。
 * ===================================================================== */

// 正常流：末块带 finish_reason=stop（OpenAI 兼容接口的正常形态）
function sseNormal(text) {
  return [
    'data: {"choices":[{"delta":{"content":' + JSON.stringify(text) + '},"finish_reason":null}]}',
    "",
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

// 被掐断的流：有内容，但**从头到尾没有 finish_reason**（连接正常关闭）
function sseCut(text) {
  return [
    'data: {"choices":[{"delta":{"content":' + JSON.stringify(text) + '}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

// 撞输出上限：末块 finish_reason=length
function sseLength(text) {
  return [
    'data: {"choices":[{"delta":{"content":' + JSON.stringify(text) + '}}]}',
    "",
    'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":4096}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

/** 播种一本书 + 进入第一节课（sendText 要求处在授课态，否则静默 return） */
async function enterLesson(page, suffix) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate((sfx) => {
    localStorage.clear();
    const bookKey = "bkkey_" + sfx;
    localStorage.setItem("socratopia_library_v0", JSON.stringify([{
      id: "bk_" + sfx, title: "E2E " + sfx, material: "这是一份足够长的测试材料，用于覆盖提示词拼装。",
      bookKey, createdAt: "2026-09-17",
      outline: { chapters: [{ title: "第一章", lessons: [{ id: "ls1", title: "课时一", focus: "打印你好" }] }] },
    }]));
    localStorage.setItem("socratopia_current_book_v0", "bk_" + sfx);
    localStorage.setItem("socratopia_lesson_ls1_" + bookKey, JSON.stringify([
      { role: "assistant", content: "我们开始吧，先说说这道题你怎么想的？" },
    ]));
    localStorage.setItem("socratopia_settings_v0", JSON.stringify({
      baseUrl: "http://127.0.0.1:8198/v1", apiKey: "test-key", model: "deepseek-chat",
      temperature: 0.7, role: "sanbingqi",
    }));
  }, suffix);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.click(".course-head");
  await page.click('.cc-ch-title[data-chidx="0"]');
  await page.click('.cc-lesson[data-lid="ls1"]');
  await page.click("#startLessonBtn");
  await expect(page.locator("#userInput")).toBeEnabled();
}

test.describe("半句话必须给出归因", () => {
  test("流被网络/网关掐断（没有 finish_reason）→ 提示「结束标记没收到」，且已生成部分不被吞", async ({ page }) => {
    const CUT = "你说完这两句，咱就"; // 真实故障里停在半句的那个位置
    await page.route("**/chat/completions", (route) =>
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseCut(CUT),
      })
    );

    await enterLesson(page, "cut");
    await page.fill("#userInput", "我试试");
    await page.click("#sendBtn");

    // ① 已生成的部分必须留在聊天里（不能因为没结束就整条丢掉）
    // ⚠️ 不能用 `.msg.ai` 的 last()：聊天区的 role:"system" 提示没有独立类名，也走 .msg.ai
    // （见 bubble()），last() 取到的会是提示本身。按文本定位那条回复才准。
    await expect(page.locator("#messages .msg", { hasText: "咱就" })).toHaveCount(1);

    // ② 必须出现归因提示
    const notice = page.locator("#messages .msg", { hasText: "结束标记没收到" });
    await expect(notice).toHaveCount(1);

    // ③ 提示要排在回复【之后】（事后归因，不是事前预警）
    const order = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("#messages .msg"));
      return {
        iCut: nodes.findIndex((n) => n.textContent.indexOf("咱就") >= 0),
        iNotice: nodes.findIndex((n) => n.textContent.indexOf("结束标记没收到") >= 0),
      };
    });
    expect(order.iNotice, "提示应排在老师那条回复之后").toBeGreaterThan(order.iCut);
  });

  test("撞上模型输出上限（finish_reason=length）→ 提示「模型的输出上限」", async ({ page }) => {
    await page.route("**/chat/completions", (route) =>
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseLength("太棒啦！你正式跑通了这条全流程，咱用一两句话收个尾：你说完这两句，咱就"),
      })
    );

    await enterLesson(page, "len");
    await page.fill("#userInput", "我试试");
    await page.click("#sendBtn");

    // 半句话本身要留在聊天里（同：不能拿 .msg.ai 的 last()，system 提示也是 .msg.ai）
    await expect(page.locator("#messages .msg", { hasText: "咱就" })).toHaveCount(1);
    await expect(page.locator("#messages .msg", { hasText: "模型的输出上限" })).toHaveCount(1);
    // 两种成因的文案必须能区分开，不能混成一句含糊的话
    await expect(page.locator("#messages .msg", { hasText: "结束标记没收到" })).toHaveCount(0);
  });

  test("正常结束 → 不得出现任何截断提示（防误报）", async ({ page }) => {
    await page.route("**/chat/completions", (route) =>
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseNormal("这道题你打算先动哪一边？"),
      })
    );

    await enterLesson(page, "ok");
    await page.fill("#userInput", "我试试");
    await page.click("#sendBtn");

    await expect(page.locator("#messages .msg.ai").last()).toContainText("先动哪一边");
    // 正常回复后面挂假警报比不提示更糟：用户会开始怀疑每一次回复
    await expect(page.locator("#messages .msg", { hasText: "结束标记没收到" })).toHaveCount(0);
    await expect(page.locator("#messages .msg", { hasText: "模型的输出上限" })).toHaveCount(0);
  });
});
