const { test, expect } = require("@playwright/test");

/* =====================================================================
 *  Socratopia E2E · 图片输入（20260916）
 *  ---------------------------------------------------------------------
 *  这条用例回答的是用户那句「文本框连图片都粘贴不了」——所以它必须真的
 *  派发一次 paste 事件、真的走到 fetch，再把**发出去的请求体**拆开看，
 *  而不是只断言"输入框里多了个东西"。
 *
 *  覆盖四件事：
 *    ① Ctrl+V 粘贴截图 → 输入框上方出现待发送缩略图（此前是静默无反应）
 *    ② 发送时该图确实进了 payload：content 变成 [{text},{image_url}] 块数组
 *    ③ 原图（base64）不落盘：localStorage 里只剩缩略图，full 被剥掉
 *    ④ 模型不收图时不把整轮打死：自动降级为纯文字重发一次
 *
 *  API 走 page.route 打桩（OpenAI 兼容 SSE），不需要真实 Key。
 * ===================================================================== */

// OpenAI 兼容的 SSE 流：api.js 的 readSSE 按行读 "data:" 事件
function sseBody(text) {
  return [
    'data: {"choices":[{"delta":{"content":' + JSON.stringify(text) + '},"finish_reason":null}]}',
    "",
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

/**
 * 在页面里造一张真实可解码的图（canvas → Blob → File），塞进 DataTransfer，
 * 再朝 #userInput 派发一次 paste。不依赖任何外部图片文件。
 * 返回值是**自证材料**：dispatchEvent 返回 false 当且仅当处理器调用了
 * preventDefault —— 这正是"我们的 paste 处理器确实接住了"的证据，
 * 否则一个拼错的 DataTransfer 会让用例以"没反应"失败，看不出是哪一环断的。
 */
function pasteImageFile(page) {
  return page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 400; c.height = 300;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 400, 300);
    g.fillStyle = "#000"; g.font = "24px sans-serif"; g.fillText("x+1=2", 40, 80);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const file = new File([blob], "shot.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    // clipboardData 在构造器里未必被 Chromium 采纳，直接定义属性最稳
    Object.defineProperty(ev, "clipboardData", { value: dt });
    const target = document.getElementById("userInput");
    const notPrevented = target.dispatchEvent(ev);
    return {
      blobSize: blob ? blob.size : 0,
      itemKinds: Array.from(dt.items).map((i) => i.kind),
      plainText: dt.getData("text/plain"),
      handlerCaughtIt: notPrevented === false,
    };
  });
}

test.describe("图片输入：粘贴截图 → 进入请求", () => {
  let captured = null;

  test.beforeEach(async ({ page }) => {
    captured = [];
    // 打桩 /chat/completions：记录请求体，返回 SSE
    await page.route("**/chat/completions", async (route) => {
      const body = route.request().postData();
      captured.push(body ? JSON.parse(body) : null);
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody("我看看这道题。"),
      });
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      localStorage.clear();
      const bookKey = "bkkey_img";
      localStorage.setItem("socratopia_library_v0", JSON.stringify([{
        id: "bk_img", title: "E2E 图片课程", material: "这是一份足够长的测试材料，用于覆盖提示词拼装。",
        bookKey, createdAt: "2026-09-16",
        outline: { chapters: [{ title: "第一章", lessons: [{ id: "ls1", title: "课时一", focus: "解一元一次方程" }] }] },
      }]));
      localStorage.setItem("socratopia_current_book_v0", "bk_img");
      // 已有聊天内容 → startLesson 不会再去生成课时开场白，用例更快也更少噪音
      localStorage.setItem("socratopia_lesson_ls1_" + bookKey, JSON.stringify([
        { role: "assistant", content: "我们开始吧，先说说这道题你怎么想的？" },
      ]));
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({
        baseUrl: "http://127.0.0.1:8198/v1", apiKey: "test-key", model: "deepseek-v4-flash-vision-exp",
        temperature: 0.7, role: "sanbingqi",
      }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("E2E 图片课程");

    // 进入一节课（sendText 要求处在授课态，否则静默 return）
    await page.click(".course-head");
    await page.click('.cc-ch-title[data-chidx="0"]');
    await page.click('.cc-lesson[data-lid="ls1"]');
    await page.click("#startLessonBtn");
    await expect(page.locator("#userInput")).toBeEnabled();
    captured.length = 0; // 丢掉开课阶段可能产生的请求
  });

  test("粘贴截图 → 出现缩略图；发送后 payload 里带 image_url 块", async ({ page }) => {
    // ① 粘贴前：缩略图条是隐藏的
    await expect(page.locator("#attachBar")).toHaveClass(/hidden/);

    const diag = await pasteImageFile(page);
    expect(diag.itemKinds, "剪贴板里应有一个 file 项").toEqual(["file"]);
    expect(diag.plainText, "纯截图不应带 text/plain（带了就会被当成文字粘贴）").toBe("");
    expect(diag.handlerCaughtIt, "paste 处理器必须接住这次事件（preventDefault）").toBe(true);

    // ② 粘贴后：缩略图条出现，且真的是一张可解码的图（naturalWidth > 0）
    await expect(page.locator("#attachBar")).not.toHaveClass(/hidden/);
    await expect(page.locator("#attachBar .attach-chip")).toHaveCount(1);
    await expect(page.locator("#attachBar .attach-tip")).toContainText("已附 1 张");
    const decoded = await page.evaluate(() => {
      const img = document.querySelector("#attachBar .attach-chip img");
      return { w: img.naturalWidth, h: img.naturalHeight, src: img.getAttribute("src") };
    });
    expect(decoded.w, "缩略图必须真的解码出来").toBeGreaterThan(0);
    expect(decoded.src.startsWith("data:image/jpeg;base64,")).toBe(true);

    // ③ 打字 + 发送
    await page.fill("#userInput", "老师，这道题我看不懂");
    await page.click("#sendBtn");
    await expect(page.locator("#messages .msg.ai").last()).toContainText("我看看这道题");

    // ④ 请求体里必须真的带上图片
    expect(captured.length, "应当至少发出一次请求").toBeGreaterThan(0);
    const last = captured[captured.length - 1];
    const userMsg = last.messages.filter((m) => m.role === "user").pop();
    expect(Array.isArray(userMsg.content), "带图的 user 消息 content 应为块数组").toBe(true);
    const textBlock = userMsg.content.find((b) => b.type === "text");
    const imgBlock = userMsg.content.find((b) => b.type === "image_url");
    expect(textBlock.text).toContain("看不懂");
    expect(imgBlock.image_url.url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(imgBlock.image_url.url.length, "应是原图而不是 320px 缩略图").toBeGreaterThan(1000);

    // 纯文字消息（system / assistant）绝不能被包成数组 —— 上游对它们带图直接 400
    last.messages.forEach((m) => {
      if (m.role !== "user") expect(typeof m.content).toBe("string");
    });

    // ⑤ 聊天里能看到这张图
    await expect(page.locator("#messages .msg.user .msg-image")).toHaveCount(1);
    // 发送后待发送条清空
    await expect(page.locator("#attachBar")).toHaveClass(/hidden/);
  });

  test("原图不落盘：localStorage 里只剩缩略图", async ({ page }) => {
    await pasteImageFile(page);
    await page.fill("#userInput", "看图");
    await page.click("#sendBtn");
    await expect(page.locator("#messages .msg.ai").last()).toContainText("我看看这道题");

    const stored = await page.evaluate(() =>
      localStorage.getItem("socratopia_lesson_ls1_bkkey_img")
    );
    const msgs = JSON.parse(stored);
    const withImg = msgs.find((m) => m.images && m.images.length);
    expect(withImg, "落盘记录里应保留该消息").toBeTruthy();
    expect(withImg.images[0].full, "base64 原图绝不能写进 localStorage").toBeUndefined();
    expect(typeof withImg.images[0].thumb).toBe("string");
    expect(withImg.images[0].thumb.length).toBeLessThan(60 * 1024);
    expect(stored.indexOf('"full"'), "整个课时记录里都不该出现 full 字段").toBe(-1);
  });

  test("剪贴板同时带文字和图片时（从网页/Word 复制）只按文字粘贴，不擅自挂图", async ({ page }) => {
    // 这是"热心过头"最容易招人烦的形态：复制一句话就凭空多出一张图、还多付 token。
    // 对应的纯逻辑判定在 js/image-input.test.mjs，这里验证它确实接在了 DOM 事件上。
    const diag = await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 200; c.height = 100;
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, 200, 100);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const dt = new DataTransfer();
      dt.setData("text/plain", "这句话是我从网页上复制下来的");
      dt.items.add(new File([blob], "sel.png", { type: "image/png" }));
      const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", { value: dt });
      return document.getElementById("userInput").dispatchEvent(ev);
    });
    expect(diag, "带文字时不得 preventDefault（要放行浏览器的文字粘贴）").toBe(true);
    await page.waitForTimeout(500);
    await expect(page.locator("#attachBar")).toHaveClass(/hidden/);
    await expect(page.locator("#attachBar .attach-chip")).toHaveCount(0);
  });

  test("点 ✕ 可移除待发送的图", async ({ page }) => {
    await pasteImageFile(page);
    await expect(page.locator("#attachBar .attach-chip")).toHaveCount(1);
    await page.click("#attachBar .attach-remove");
    await expect(page.locator("#attachBar .attach-chip")).toHaveCount(0);
    await expect(page.locator("#attachBar")).toHaveClass(/hidden/);
  });
});

test.describe("模型不收图时不把整轮打死", () => {
  test("第一次 400 → 自动去掉图片重发一次并给出提示", async ({ page }) => {
    const calls = [];
    await page.route("**/chat/completions", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      calls.push(body);
      const hasImage = (body.messages || []).some((m) => Array.isArray(m.content));
      if (hasImage) {
        await route.fulfill({
          status: 400,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: { message: "This model does not support image input." } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody("（看不到图，我们先用文字说）"),
      });
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      localStorage.clear();
      const bookKey = "bkkey_nv";
      localStorage.setItem("socratopia_library_v0", JSON.stringify([{
        id: "bk_nv", title: "E2E 无视觉课程", material: "测试材料测试材料测试材料",
        bookKey, createdAt: "2026-09-16",
        outline: { chapters: [{ title: "第一章", lessons: [{ id: "ls1", title: "课时一", focus: "f" }] }] },
      }]));
      localStorage.setItem("socratopia_current_book_v0", "bk_nv");
      localStorage.setItem("socratopia_lesson_ls1_" + bookKey, JSON.stringify([
        { role: "assistant", content: "开始吧。" },
      ]));
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({
        baseUrl: "http://127.0.0.1:8198/v1", apiKey: "test-key", model: "deepseek-v4-flash",
        temperature: 0.7, role: "sanbingqi",
      }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.click(".course-head");
    await page.click('.cc-ch-title[data-chidx="0"]');
    await page.click('.cc-lesson[data-lid="ls1"]');
    await page.click("#startLessonBtn");
    await expect(page.locator("#userInput")).toBeEnabled();
    calls.length = 0;

    await pasteImageFile(page);
    await page.fill("#userInput", "这题怎么做");
    await page.click("#sendBtn");

    // 降级后的纯文字那一轮要真的答出来
    await expect(page.locator("#messages .msg.ai").last()).toContainText("先用文字说");
    // 且必须真的重发了一次（第一次带图失败，第二次不带图）
    expect(calls.length, "应当发出两次请求（带图失败 + 纯文字重试）").toBe(2);
    expect(calls[0].messages.some((m) => Array.isArray(m.content))).toBe(true);
    expect(calls[1].messages.some((m) => Array.isArray(m.content)), "重试不得再带图").toBe(false);
    // 用户应当知道发生了什么（而不是以为老师装看不见）。
    // 注：聊天区的 role:"system" 气泡没有独立类名，走的是 .msg.ai（见 bubble()），
    // 所以这里按文本定位。同时它必须排在老师回复【之前】——那才符合时间顺序。
    const notice = page.locator("#messages .msg", { hasText: "不支持图片" });
    await expect(notice).toHaveCount(1);
    const order = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("#messages .msg"));
      const iNotice = nodes.findIndex((n) => n.textContent.indexOf("不支持图片") >= 0);
      const iAnswer = nodes.findIndex((n) => n.textContent.indexOf("先用文字说") >= 0);
      return { iNotice, iAnswer };
    });
    expect(order.iNotice, "提示应排在老师回复之前").toBeLessThan(order.iAnswer);
    // 图仍留在聊天记录里，只是没发出去
    await expect(page.locator("#messages .msg.user .msg-image")).toHaveCount(1);
  });
});
