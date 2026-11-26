const { test, expect } = require("@playwright/test");

// 课时上下课 / 进度 / 教材切片 的回归测试
// 覆盖：
//  1) 上课中点别的课时：只高亮预览、不清聊天、不切入新课（修复「点标题栏丢记录」）
//  2) 章节进度按「核心知识点数」统计（课程进度按「已完成章节数」）
//  3) 长教材切片：每课时拿到对应区段，而非全书开头（修复教学内容漂移）

test.describe.configure({ timeout: 60000 });

const API_BASE = "http://127.0.0.1:8198/v1";

// 预置一门「已下课(ended+paused)」的多课时课，进入 ls1 上课态（无 API 调用）
async function setupInLesson(page, bookKey, bookId) {
  const book = {
    id: bookId, title: "逻辑回归课程", material: "测试材料", bookKey, createdAt: "2026-08-14",
    outline: {
      chapters: [{
        title: "第一章",
        lessons: [
          { id: "ls1", title: "第一课", focus: "A", keyPoints: ["甲", "乙", "丙"] },
          { id: "ls2", title: "第二课", focus: "B", keyPoints: ["丁", "戊"] },
        ],
      }],
      advice: "",
    },
  };
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(({ book, bookKey, base }) => {
    localStorage.clear();
    localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: base, apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
    localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
    localStorage.setItem("socratopia_current_book_v0", book.id);
    localStorage.setItem("socratopia_lessonprog_" + bookKey, JSON.stringify({ ls1: { status: "ended", paused: true, turns: 3 } }));
    localStorage.setItem("socratopia_lesson_ls1_" + bookKey, JSON.stringify([
      { role: "assistant", content: "我们开始学第一课。" },
      { role: "user", content: "这是第一课的内容标记AAA，我理解了核心。" },
      { role: "assistant", content: "很好，继续。" },
    ]));
  }, { book, bookKey, base: API_BASE });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#bookList")).toContainText("逻辑回归课程");
  await page.click(".course-head");
  await page.click('.cc-ch-title[data-chidx="0"]');
  await page.click('.cc-lesson[data-lid="ls1"]');
  await expect(page.locator("#startLessonBtn")).toContainText("继续学习");
  await page.click("#startLessonBtn");
  await expect(page.locator("#messages .msg.card")).toContainText("继续学习");
}

test.describe("上课中点击课时（不丢记录）", () => {
  test("上课中点别的课时：只高亮、不清聊天、按钮仍「上课中」", async ({ page }) => {
    await setupInLesson(page, "bkkey_inlesson", "bk_inlesson");
    // 记录上课中的聊天区内容
    const before = await page.locator("#messages").textContent();
    expect(before).toContain("第一课的内容标记AAA");

    // 点另一课时 ls2 → 应只高亮侧栏，聊天区不动
    await page.click('.cc-lesson[data-lid="ls2"]');
    const after = await page.locator("#messages").textContent();
    expect(after).toBe(before); // 聊天内容完全不变（未清空、未切入新课）
    await expect(page.locator("#startLessonBtn")).toContainText("上课中");
    // 预览卡文本不应出现（「已选中本节课」是 lessonPreview 卡的特征）
    await expect(page.locator("#messages")).not.toContainText("已选中本节课");

    // 点当前课 ls1 → 同样无操作
    await page.click('.cc-lesson[data-lid="ls1"]');
    expect(await page.locator("#messages").textContent()).toBe(before);

    // 聊天记录在 localStorage 仍完整（未被覆盖）
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("socratopia_lesson_ls1_bkkey_inlesson") || "[]"));
    expect(saved.some((m) => String(m.content || "").includes("第一课的内容标记AAA"))).toBe(true);
  });
});

test.describe("进度按核心知识点统计", () => {
  test("章节进度按 keyPoints 数、课程进度按已完成章节数", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      localStorage.clear();
      const book = {
        id: "bk_prog", title: "进度课程", material: "材料", bookKey: "bkkey_prog", createdAt: "2026-08-14",
        outline: {
          chapters: [
            { title: "第一章", lessons: [
              { id: "p1", title: "课一", keyPoints: ["a", "b", "c"] },
              { id: "p2", title: "课二", keyPoints: ["d", "e"] },
            ] },
            { title: "第二章", lessons: [
              { id: "p3", title: "课三", keyPoints: ["f"] },
            ] },
          ],
          advice: "",
        },
      };
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", book.id);
      localStorage.setItem("socratopia_lessonprog_bkkey_prog", JSON.stringify({
        p1: { status: "completed" },
        p2: { status: "ended" }, // 已下课，不计入进度，但可点 ✓ 标记完成
        p3: { status: "not_started" },
      }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("进度课程");
    await page.click(".course-head");
    await page.click('.cc-ch-title[data-chidx="0"]');

    // 第一章：p1 完成(3 知识点)，p2 已下课(2 知识点未完成) → 3/5 = 60%
    await expect(page.locator('.cc-ch-title[data-chidx="0"] .cc-ch-pct')).toHaveText("60%");
    await expect(page.locator('.cc-ch-title[data-chidx="0"] .cc-ch-count')).toHaveText("3/5");
    // 课程：第一章未全完成(缺 p2)、第二章未完成 → 0/2 = 0%
    await expect(page.locator(".course-pct")).toHaveText("0%");

    // 先选中本书（点击 p2 触发 selectBook，否则 markLessonComplete 因 currentBook 为空而失效）
    await page.click('.cc-lesson[data-lid="p2"]');
    await page.click('.cc-ch-title[data-chidx="0"]'); // selectBook 重绘后章节会收起，重新展开
    await page.click('.cc-lesson[data-lid="p2"] .cc-mark-complete');
    // p2 标记完成 → 第一章 5/5 = 100%，课程 1/2 = 50%
    await expect(page.locator('.cc-ch-title[data-chidx="0"] .cc-ch-pct')).toHaveText("100%");
    await expect(page.locator('.cc-ch-title[data-chidx="0"] .cc-ch-count')).toHaveText("5/5");
    await expect(page.locator(".course-pct")).toHaveText("50%");
  });
});

test.describe("长教材切片（内容不漂移）", () => {
  test("第二课时拿到后半段教材，而非全书开头", async ({ page }) => {
    const captured = [];
    await page.route("**/chat/completions", async (route) => {
      let body = "{}";
      try { body = route.request().postData() || "{}"; } catch {}
      const j = JSON.parse(body);
      const sys = (j.messages || []).find((m) => m.role === "system")?.content || "";
      const last = j.messages[j.messages.length - 1];
      if (sys.includes("你即将开始教授")) captured.push(last && last.content || "");
      await route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "好的，我们开始。" } }] }) });
    });

    const material = "第一部分AAAA".repeat(1200) + "\n\n" + "第二部分BBBB".repeat(1200); // ~19200 字，超 8000
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(({ material, base }) => {
      localStorage.clear();
      const book = {
        id: "bk_slice", title: "切片课程", material, bookKey: "bkkey_slice", createdAt: "2026-08-14",
        outline: { chapters: [{ title: "第一章", lessons: [
          { id: "s1", title: "上半", focus: "上半部分", keyPoints: ["上"] },
          { id: "s2", title: "下半", focus: "下半部分", keyPoints: ["下"] },
        ] }], advice: "" },
      };
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: base, apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", book.id);
    }, { material, base: API_BASE });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("切片课程");

    await page.click(".course-head");
    await page.click('.cc-ch-title[data-chidx="0"]');
    await page.click('.cc-lesson[data-lid="s2"]');
    await page.click("#startLessonBtn"); // 第二课时 → 应切到后半段

    await expect.poll(() => captured.length, { timeout: 10000 }).toBeGreaterThan(0);
    const userMsg = captured[0];
    expect(userMsg).toContain("第二部分"); // 后半段在切片里
    expect(userMsg).not.toContain("第一部分"); // 前半段不应出现（不漂移）
  });
});
