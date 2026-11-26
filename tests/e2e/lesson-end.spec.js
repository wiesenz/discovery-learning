const { test, expect } = require("@playwright/test");

// 下课 → 群聊复盘 / 教学「未读全书」约束 的端到端测试（mock API，无真实 Key）
// 覆盖：
//  1) 群聊复盘请求真的带上「上课记录」（真实师生对话），而非空串 → 修复"群聊还是有问题"
//  2) 小结解析失败：干净重试卡、不自动弹群聊、无「查看原始响应」调试按钮；重试成功后恢复流程
//  3) 课时开始提示词包含「未读过整本书」约束
//  4) 用户在群里发言时，群聊仍复用同一份上课记录（groupLessonId 未被清）
//  5) B7：下课请求必须显式带足 max_tokens（> provider 默认 4096），否则小结 JSON 会被截断
//  6) B7：输出真被截断时（finish_reason=length），小结卡必须显式说明"被截断、本次缺内容"
//     —— 截断会被 parseLessonJson 抢救成"只有 summary"的真值，从而**不弹错误卡**，
//        用户只会以为"老师这次没出题"，这比直接报错更阴。

// 与 smoke.spec.js 一致：走测试专用端口 8198，外部字体 CDN 挂起不影响（用 domcontentloaded）
const API_BASE = "http://127.0.0.1:8198/v1";

const VALID_LESSON_END = {
  summary: "本节课学习了变量作用域。\n- 要点1：作用域是变量可访问的范围\n- 一句话带走：记住作用域边界由定义位置决定。",
  quiz: [], // 空 → 下课直接走群聊，不弹测验（绕开答题步骤）
  memory: { mastered: ["变量作用域"], weak: [], misconceptions: [], selfScore: 0.7 },
  userProfile: { habits: ["习惯先举例子理解"], personality: "可能是「深思型」", adaptive: "多给例子" },
  notes: { coreQuestions: [], myAnswers: "答", pitfalls: [], nextTime: "" },
};
const GROUP_ROUND1 = "三月七：这节课你学得很扎实，变量作用域理解得很到位！";
const GROUP_ROUND2 = "星见雅：补充一句，作用域还涉及闭包，课后可以想想。";

// 在 Node 侧捕获请求体 + 可变 mock 模式（用于"先失败、后成功"的重试用例）
function installApiMock(page, opts = {}) {
  const captured = { lessonEnd: [], group: [], lessonStart: [], other: [] };
  // "valid" | "invalid"（格式不对）| "truncated"（JSON 吐一半 + finish_reason=length）
  let lessonEndMode = opts.lessonEndMode || "valid";
  page.route("**/chat/completions", async (route) => {
    const req = route.request();
    let body = "{}";
    try { body = req.postData() || "{}"; } catch {}
    const j = JSON.parse(body);
    const sys = (j.messages || []).find((m) => m.role === "system")?.content || "";
    const last = j.messages && j.messages[j.messages.length - 1];
    let content = "";
    let finishReason = "stop";
    if (sys.includes("你即将开始教授")) { // 课时开始规则（lessonStartRules）的特征句
      captured.lessonStart.push({ sys, user: (last && last.content) || "" });
      content = "好的，我们开始。先从一个生活例子说起…";
    } else if (sys.includes("按下课总结规则") || sys.includes("请按规则产出 JSON")) {
      captured.lessonEnd.push(body);
      if (lessonEndMode === "valid") {
        content = JSON.stringify(VALID_LESSON_END);
      } else if (lessonEndMode === "truncated") {
        // 模拟「模型输出撞上 max_tokens 上限」：JSON 没吐完，finish_reason=length。
        // 这是 B7 的真实故障形态——前端只能看到"解析失败"，真因藏在 finish_reason 里。
        content = '{"summary":"本节课学习了变量作用域。\\n- 要点1：作用域是变量可访问的范围","quiz":[{"q":"下列哪项';
        finishReason = "length";
      } else {
        content = "Sorry, I can't output that.";
      }
    } else if (sys.includes("上课记录") || sys.includes("群聊复盘")) {
      captured.group.push(body);
      content = captured.group.length === 1 ? GROUP_ROUND1 : GROUP_ROUND2;
    } else {
      captured.other.push(body);
      content = "（通用回复）";
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }] }),
    });
  });
  return { captured, setLessonEndMode: (m) => { lessonEndMode = m; } };
}

const CHAT = [
  { role: "assistant", content: "上次我们开始学变量作用域。" },
  { role: "user", content: "我记得作用域是变量能访问的区域，先看一个具体例子：函数内部的变量在外面就访问不到了，这个例子帮我理解了变量作用域这个核心概念。" },
  { role: "assistant", content: "很好，那全局和局部的区别呢？" },
  { role: "user", content: "全局变量在哪都能访问，局部变量只在函数内部生效，作用域的边界其实就是看变量定义的位置，我先把全局和局部的这个区别记住。" },
  { role: "assistant", content: "不错，还有提升（hoisting）的影响。" },
  { role: "user", content: "提升就是变量声明会被先处理，所以判断作用域要先弄清声明的真实位置，结合例子我理解了变量作用域和提升的关系。" },
];

// 预置一门「已下课(ended+paused)」的课 + 课时聊天 → reload → 续学进入 → 可直接下课走 T2 复盘
async function setupResumeLesson(page, bookKey, bookId) {
  const book = {
    id: bookId, title: "E2E 群聊课程", material: "测试材料", bookKey, createdAt: "2026-08-09",
    outline: { chapters: [{ title: "第一章", lessons: [{ id: "ls1", title: "变量作用域", focus: "作用域", keyPoints: ["变量作用域"], materialHint: "第一段" }] }], advice: "加油" },
  };
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(({ book, bookKey, CHAT }) => {
    localStorage.clear();
    localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: "http://127.0.0.1:8198/v1", apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
    localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
    localStorage.setItem("socratopia_current_book_v0", book.id);
    localStorage.setItem("socratopia_role_v0", "sanbingqi");
    localStorage.setItem("socratopia_lessonprog_" + bookKey, JSON.stringify({ ls1: { status: "ended", paused: true, turns: 3 } }));
    localStorage.setItem("socratopia_lesson_ls1_" + bookKey, JSON.stringify(CHAT));
  }, { book, bookKey, CHAT });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#bookList")).toContainText("E2E 群聊课程");
  // 展开课程 → 展开第一章 → 选中课时 → 「继续学习」→ 上课（chat 已有 → 不会调 lessonStart）
  await page.click(".course-head");
  await page.click('.cc-ch-title[data-chidx="0"]');
  await page.click('.cc-lesson[data-lid="ls1"]');
  await expect(page.locator("#startLessonBtn")).toContainText("继续学习");
  await page.click("#startLessonBtn");
  await expect(page.locator("#messages .msg.card")).toContainText("继续学习"); // 续学卡出现
}

// 本文件走 mock API 的完整下课/开课链路，浏览器冷启动 + 外部字体 CDN 可能偶发变慢，
// 放宽到 60s，避免被默认 30s 测试超时误伤（与 smoke 的纯本地用例不同）。
test.describe.configure({ timeout: 60000 });

test.describe("下课 → 群聊复盘（mock API）", () => {
  test("群聊复盘请求真实带上上课记录（而非空串）", async ({ page }) => {
    const { captured } = installApiMock(page, { lessonEndMode: "valid" });
    await setupResumeLesson(page, "bkkey_group", "bk_group");

    await page.click("#lessonEnd");
    // 等待群聊首轮请求发出
    await expect.poll(() => captured.group.length, { timeout: 10000 }).toBeGreaterThan(0);
    const sys = JSON.parse(captured.group[0]).messages[0].content;
    expect(sys).toContain("【上课记录】");
    expect(sys).toContain("我理解了变量作用域"); // 真实用户消息必须出现在群聊上下文里

    // 群聊浮层已打开
    await expect(page.locator("#groupOverlay")).not.toHaveClass(/hidden/);
    await expect(page.locator("#groupMessages .g-msg").first()).toBeVisible({ timeout: 10000 });

    // —— 回归：用户在群里发言，第二次 group 请求仍带同一份上课记录（groupLessonId 未被清）——
    const beforeSend = captured.group.length;
    await page.fill("#groupInput", "老师，我想再巩固一下作用域。");
    await page.press("#groupInput", "Enter");
    await expect.poll(() => captured.group.length, { timeout: 10000 }).toBeGreaterThan(beforeSend);
    const sys2 = JSON.parse(captured.group[captured.group.length - 1]).messages[0].content;
    expect(sys2).toContain("【上课记录】");
    expect(sys2).toContain("我理解了变量作用域");
  });

  test("小结解析失败：干净重试卡、不自动弹群聊、无「查看原始响应」；重试成功后恢复", async ({ page }) => {
    const { captured, setLessonEndMode } = installApiMock(page, { lessonEndMode: "invalid" });
    await setupResumeLesson(page, "bkkey_fail", "bk_fail");

    await page.click("#lessonEnd");
    // 干净的错误重试卡
    await expect(page.locator("#messages .msg.card.summary.error")).toBeVisible();
    await expect(page.locator("#messages .msg.card.summary.error")).toContainText("重新生成总结");
    // 无「查看原始响应」调试按钮 / details
    await expect(page.locator("#messages .view-raw-btn")).toHaveCount(0);
    await expect(page.locator("#messages .raw-response")).toHaveCount(0);
    // 不自动弹群聊，且没有发起任何群聊请求
    await expect(page.locator("#groupOverlay")).toHaveClass(/hidden/);
    expect(captured.group.length).toBe(0);

    // 把 mock 切回合法，点「重新生成总结」→ 恢复成功流程（第二次小结请求 → 群聊）
    setLessonEndMode("valid");
    await page.click(".retry-summary-btn");
    await expect.poll(() => captured.lessonEnd.length, { timeout: 10000 }).toBeGreaterThan(1);
    await expect(page.locator("#messages .msg.card.summary")).toBeVisible(); // 知识总结卡
    await expect.poll(() => captured.group.length, { timeout: 10000 }).toBeGreaterThan(0);
    await expect(page.locator("#groupOverlay")).not.toHaveClass(/hidden/);
  });

  // B7（2026-09-10）：config 里算出预算 ≠ 调用点真的传了 —— B1 大纲截断就是栽在
  // 「两条路径都没传 max_tokens」上（单测全绿也照样翻车）。所以这道网必须打在**请求体**上。
  test("下课请求显式带足 max_tokens（防落 provider 默认 4096 → 小结 JSON 被截断）", async ({ page }) => {
    const { captured } = installApiMock(page, { lessonEndMode: "valid" });
    await setupResumeLesson(page, "bkkey_maxtok", "bk_maxtok");

    await page.click("#lessonEnd");
    await expect.poll(() => captured.lessonEnd.length, { timeout: 10000 }).toBeGreaterThan(0);

    const body = JSON.parse(captured.lessonEnd[0]);
    expect(body.max_tokens, "下课请求必须带 max_tokens").toBeTruthy();
    // 必须**严格大于** provider 默认 4096，否则等于没修
    expect(body.max_tokens).toBeGreaterThan(4096);
    // 且不得超出 config 里声明的模型输出能力
    expect(body.max_tokens).toBeLessThanOrEqual(65536);
  });

  // B7 的真实故障形态（比"报错"更阴）：输出被截断时 parseLessonJson 会把前半截抢救出来，
  // data 为真 → 不弹错误卡 → 小结卡看着正常，只是**悄悄少了随堂测验 / 课后笔记 / 画像**。
  // 所以护栏要断言：① 小结卡上必须出现"截断"说明 ② 确实没有测验卡（如实反映残缺）。
  test("输出被 max_tokens 截断时：仍出小结卡，但必须显式说明「被截断、本次缺内容」", async ({ page }) => {
    const { captured } = installApiMock(page, { lessonEndMode: "truncated" });
    await setupResumeLesson(page, "bkkey_trunc", "bk_trunc");

    await page.click("#lessonEnd");
    await expect.poll(() => captured.lessonEnd.length, { timeout: 10000 }).toBeGreaterThan(0);

    const card = page.locator("#messages .msg.card.summary:not(.error)");
    await expect(card).toBeVisible();
    // 真因必须出现在用户看得见的地方（否则「这次怎么没出题」永远是玄学）
    await expect(card).toContainText("输出上限");
    await expect(card).toContainText("截断");
    // 残缺被如实反映：截断的 JSON 里没有 quiz，就不该冒出测验卡
    await expect(page.locator("#messages .msg.card.goto-quiz")).toHaveCount(0);
  });
});

test.describe("教学「未读全书」约束（mock API）", () => {
  test("课时开始提示词包含『未读过整本书』约束", async ({ page }) => {
    const { captured } = installApiMock(page, { lessonEndMode: "valid" });
    // 新课时（无聊天）→ 点击「上课」会触发 lessonStart 请求
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      localStorage.clear();
      const bookKey = "bkkey_new";
      const book = {
        id: "bk_new", title: "E2E 新课", material: "测试材料，讲变量作用域。", bookKey, createdAt: "2026-08-09",
        outline: { chapters: [{ title: "第一章", lessons: [{ id: "ls1", title: "变量作用域", focus: "作用域", keyPoints: ["变量作用域"], materialHint: "第一段" }] }], advice: "加油" },
      };
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: "http://127.0.0.1:8198/v1", apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", book.id);
      localStorage.setItem("socratopia_role_v0", "sanbingqi");
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("E2E 新课");
    await page.click(".course-head");
    await page.click('.cc-ch-title[data-chidx="0"]');
    await page.click('.cc-lesson[data-lid="ls1"]');
    await page.click("#startLessonBtn");

    await expect.poll(() => captured.lessonStart.length, { timeout: 10000 }).toBeGreaterThan(0);
    const ls = captured.lessonStart[0];
    // 系统提示词（含 knowledgeRules / lessonStartRules）带上"未读/铺垫"约束
    expect(ls.sys).toMatch(/未读|铺垫/);
    // 显式 user 约束（generateLessonStart）
    expect(ls.user).toContain("未读过整本书");
  });
});
