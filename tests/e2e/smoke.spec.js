const { test, expect } = require("@playwright/test");

// Socratopia 冒烟测试（无需真实 API Key）
// 覆盖：加载无报错、设置面板开合、暗色主题切换+持久化、服务商预设「自定义」清空字段、
//       新增课程、课程搜索过滤、切换/新增课程时清空残留搜索（修复 #9）。
// 说明：发送消息→流式回复的完整链路需要真实 LLM 或更复杂的课时启动+API 桩，
//       暂未纳入，留作后续扩展（见文件末尾模板）。

test.describe("Socratopia 冒烟测试（无真实 API）", () => {
  let capturedErrors = null; // beforeEach 里捕获该用例加载期的未捕获异常（含两次加载）

  test.beforeEach(async ({ page }) => {
    capturedErrors = [];
    // 必须在 reload 之前挂上监听，否则应用初始化期抛出的异步异常会漏网
    page.on("pageerror", (e) => capturedErrors.push(e.message));
    // 先访问一次拿到页面上下文 → 清空 localStorage → reload，使被监听的那次加载就是干净状态
    // 用 domcontentloaded（而非默认 load）：页面引用了外部字体 CDN，沙箱无外网时这些请求会挂起，
    // 导致 load 事件永不触发、goto 超时；冒烟测试关注的是应用逻辑，无需等外部字体。
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    // 等 JS 初始化真正跑完（默认课程出现 = init 完成），之后的错误断言才可靠
    await expect(page.locator("#bookList")).toContainText("我的第一门课程");
  });

  test("页面加载且无未捕获错误", async ({ page }) => {
    await expect(page.locator(".topbar h1")).toBeVisible();
    expect(capturedErrors, "加载不应有未捕获异常: " + capturedErrors.join(" | ")).toEqual([]);
  });

  test("设置面板可开合", async ({ page }) => {
    await expect(page.locator("#settingsPanel")).toHaveClass(/hidden/);
    await page.click("#toggleSettings");
    await expect(page.locator("#settingsPanel")).not.toHaveClass(/hidden/);
    // 20260915：设置由「内嵌面板」改为「浮层」。打开态下整屏都在遮罩之下，顶栏按钮点不到，
    // 所以"再点一次顶栏收起"这条路径不复存在 —— 收起一律走关闭按钮或点遮罩。
    await page.click("#closeSettings");
    await expect(page.locator("#settingsPanel")).toHaveClass(/hidden/);
  });

  // 39c198a 起默认改为深色优先，初始主题不再是浅色——
  // 因此这里断言「切换会翻转主题且与 localStorage 一致」，而非写死切到 dark。
  test("主题切换并持久化", async ({ page }) => {
    const before = await page.locator("html").getAttribute("data-theme");
    await page.click("#toggleTheme");
    const after = await page.locator("html").getAttribute("data-theme");
    expect(after).toBeTruthy();
    expect(after).not.toBe(before); // 必须真的翻转
    await expect(page.locator("html")).toHaveAttribute("data-theme", after);
    const stored = await page.evaluate(() => localStorage.getItem("socratopia_theme"));
    expect(stored).toBe(after);
  });

  test("服务商预设：选「自定义」清空 Base URL 与模型（修复 #8）", async ({ page }) => {
    await page.click("#toggleSettings"); // 输入框在默认隐藏的设置面板内，需先打开
    await page.fill("#apiBase", "https://example.com/v1");
    await page.fill("#apiModel", "my-model");
    // 选具体预设 → 自动填充
    await page.selectOption("#providerPreset", "deepseek");
    await expect(page.locator("#apiBase")).toHaveValue("https://api.deepseek.com/v1");
    await expect(page.locator("#apiModel")).toHaveValue("deepseek-chat");
    // 切回「自定义」→ 应清空，交还手动填写
    await page.selectOption("#providerPreset", "");
    await expect(page.locator("#apiBase")).toHaveValue("");
    await expect(page.locator("#apiModel")).toHaveValue("");
  });

  test("新增课程（空材料，不触发 API）并出现在列表", async ({ page }) => {
    await page.click("#addBook");
    await expect(page.locator("#courseEditModal")).not.toHaveClass(/hidden/);
    await page.fill("#bookTitle", "E2E 测试课程");
    await page.click("#cemSave");
    await expect(page.locator("#courseEditModal")).toHaveClass(/hidden/);
    await expect(page.locator("#bookList")).toContainText("E2E 测试课程");
  });

  test("课程搜索过滤", async ({ page }) => {
    await page.click("#addBook");
    await page.fill("#bookTitle", "可搜索课程ABC");
    await page.click("#cemSave");
    await page.fill("#bookSearch", "xyz不存在");
    await expect(page.locator("#bookEmpty")).toBeVisible();
    await page.fill("#bookSearch", "可搜索");
    await expect(page.locator("#bookList")).toContainText("可搜索课程ABC");
  });

  test("切换/新增课程时清空残留搜索（修复 #9）", async ({ page }) => {
    const addCourse = async (name) => {
      await page.click("#addBook");
      await page.fill("#bookTitle", name);
      await page.click("#cemSave");
    };
    await addCourse("课程一");
    await addCourse("课程二");
    // 输入一个过滤掉所有的搜索
    await page.fill("#bookSearch", "zzz不存在zzz");
    await expect(page.locator("#bookEmpty")).toBeVisible();
    // 新增课程会触发 selectBook，应清空搜索框并恢复列表
    await addCourse("课程三");
    await expect(page.locator("#bookSearch")).toHaveValue("");
    await expect(page.locator("#bookEmpty")).not.toBeVisible();
    await expect(page.locator("#bookList")).toContainText("课程三");
  });
});

// ---- 中断恢复 + 章节级进度（纯本地状态注入，无需 API）----
test.describe("Socratopia 中断恢复与章节进度（无真实 API）", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("我的第一门课程");
  });

  test("意外关闭后再次启动：中断课时自动转续学，进度不丢", async ({ page }) => {
    await page.evaluate(() => {
      const bookKey = "bkkey_interrupt";
      const bookId = "bk_interrupt";
      const outline = {
        chapters: [
          { title: "第一章", lessons: [
            { id: "ls1", title: "课时一", focus: "知识点A" },
            { id: "ls2", title: "课时二", focus: "知识点B" },
          ] },
          { title: "第二章", lessons: [
            { id: "ls3", title: "课时三", focus: "知识点C" },
          ] },
        ],
      };
      localStorage.setItem("socratopia_library_v0", JSON.stringify([{
        id: bookId, title: "E2E 中断恢复课程", material: "测试材料", bookKey, createdAt: "2026-08-06", outline,
      }]));
      localStorage.setItem("socratopia_current_book_v0", bookId);
      // ls1 上次上课中直接关掉：in_progress + interrupted 标记 + 已有实质聊天（≥30 字才算有实质学习）
      localStorage.setItem("socratopia_lessonprog_" + bookKey, JSON.stringify({
        ls1: { status: "in_progress", interrupted: true, turns: 3 },
      }));
      localStorage.setItem("socratopia_lesson_ls1_" + bookKey, JSON.stringify([
        { role: "assistant", content: "这节课我们开始学知识点A。" },
        { role: "user", content: "明白了，A 就是苏格拉底式提问法的核心，通过不断追问引导学习者自己推导出答案，收获很大。" },
        { role: "assistant", content: "很好，继续。" },
      ]));
    });

    // 重新加载 → cleanupStaleProgress 把中断课时转成 ended+paused（续学态）
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("E2E 中断恢复课程");

    // 展开课程，章节级进度条 + 百分比出现（进度口径 = 已学完占比：ls1 下课≠学完，第一章 0/2 = 0%）
    await page.click(".course-head");
    const barStyle = await page.locator('.cc-ch-title[data-chidx="0"] .cc-ch-bar i').getAttribute("style");
    expect(barStyle).toMatch(/width:\s*0%/);
    await expect(page.locator('.cc-ch-title[data-chidx="0"] .cc-ch-pct')).toHaveText("0%");
    await expect(page.locator('.cc-ch-title[data-chidx="0"] .cc-ch-count')).toHaveText("0/2");

    // 该课时显示「已下课」，而非残留「进行中」
    await expect(page.locator('.cc-lesson[data-lid="ls1"] .cc-status')).toHaveText("已下课");

    // 课程级比例按 已学完/总数 = 0/3 = 0% 计算
    await expect(page.locator(".course-pct")).toHaveText("0%");

    // 展开第一章，选中并「继续学习」→ 出现续学卡（文案带「意外中断」）
    await page.click('.cc-ch-title[data-chidx="0"]');
    await page.click('.cc-lesson[data-lid="ls1"]');
    await expect(page.locator("#startLessonBtn")).toContainText("继续学习");
    await page.click("#startLessonBtn");
    await expect(page.locator("#messages .msg.card")).toContainText("意外中断");
    await expect(page.locator("#messages .msg.card")).toContainText("继续学习");
  });

  test("残留 in_progress（无中断标记）启动后回退为未开始", async ({ page }) => {
    await page.evaluate(() => {
      const bookKey = "bkkey_stale";
      const bookId = "bk_stale";
      const outline = {
        chapters: [{ title: "第一章", lessons: [{ id: "sa", title: "课时A", focus: "x" }] }],
      };
      localStorage.setItem("socratopia_library_v0", JSON.stringify([{
        id: bookId, title: "E2E 残留课程", material: "m", bookKey, createdAt: "2026-08-06", outline,
      }]));
      localStorage.setItem("socratopia_current_book_v0", bookId);
      localStorage.setItem("socratopia_lessonprog_" + bookKey, JSON.stringify({
        sa: { status: "in_progress", turns: 2 },
      }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("E2E 残留课程");
    await page.click(".course-head");
    await expect(page.locator('.cc-lesson[data-lid="sa"] .cc-status')).toHaveText("未开始");
  });
});

// ---- 下课分级 + 按钮状态 + 新对话迁移（纯本地状态注入，无需 API）----
test.describe("Socratopia 下课分级与按钮状态（无真实 API）", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("我的第一门课程");
  });

  test("初步学习（不足完整阈值）下课：本地轻卡、不调 API、无 quiz 卡、无「开始下一节」", async ({ page }) => {
    await page.evaluate(() => {
      const bookKey = "bkkey_t1";
      const bookId = "bk_t1";
      const outline = { chapters: [{ title: "第一章", lessons: [{ id: "ls1", title: "课时一", focus: "知识点A" }] }] };
      localStorage.setItem("socratopia_library_v0", JSON.stringify([{
        id: bookId, title: "E2E 初步学习", material: "测试材料", bookKey, createdAt: "2026-08-07", outline,
      }]));
      localStorage.setItem("socratopia_current_book_v0", bookId);
      // ls1 已下课(ended+paused)：恢复为「继续学习」续学态；用户内容 ≥30 字但轮次/字数不足完整复盘阈值
      localStorage.setItem("socratopia_lessonprog_" + bookKey, JSON.stringify({
        ls1: { status: "ended", paused: true, turns: 1 },
      }));
      localStorage.setItem("socratopia_lesson_ls1_" + bookKey, JSON.stringify([
        { role: "assistant", content: "这节课我们开始学知识点A。" },
        { role: "user", content: "好，我理解了核心是不断追问引导学习者自己推导出答案，先把这个要点记下来。" },
      ]));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("E2E 初步学习");

    // 展开课程 → 选中已下课课时 → 按钮显示「继续学习」（而非「上课」）
    await page.click(".course-head");
    await page.click('.cc-ch-title[data-chidx="0"]');
    await page.click('.cc-lesson[data-lid="ls1"]');
    await expect(page.locator("#startLessonBtn")).toContainText("继续学习");
    await page.click("#startLessonBtn");
    await expect(page.locator("#messages .msg.card")).toContainText("继续学习");

    // 下课 → T1 分级：本地轻卡「初步学习」，不调 API，无 quiz 卡、无「开始下一节」按钮
    await page.click("#lessonEnd");
    await expect(page.locator("#messages .msg.card")).toContainText("初步学习");
    await expect(page.locator("#messages .msg.card")).toContainText("未生成完整总结");
    await expect(page.locator("#messages .start-quiz-btn")).toHaveCount(0);
    await expect(page.locator("#messages .next-les-btn")).toHaveCount(0);
    // 课时仍为「已下课」（未标记完成）
    await expect(page.locator('.cc-lesson[data-lid="ls1"] .cc-status')).toHaveText("已下课");
    // 下课完「继续学习」仍可用（selectedLessonId 未被清空）
    await expect(page.locator("#startLessonBtn")).toContainText("继续学习");
  });

  test("启动进入「课程选择」态：不自动加载任何课程的授课界面", async ({ page }) => {
    await page.evaluate(() => {
      const bookId = "bk_sel";
      localStorage.setItem("socratopia_library_v0", JSON.stringify([{
        id: bookId, title: "选择态课程", material: "材料", bookKey: "bkkey_sel", createdAt: "2026-08-07",
        outline: { chapters: [{ title: "第一章", lessons: [{ id: "l1", title: "课时一", focus: "x" }] }] },
      }]));
      localStorage.setItem("socratopia_current_book_v0", bookId); // 即使记录了上次课程，也不自动进入授课界面
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    // 主区域显示欢迎/选择提示，而不是上次课程的对话
    await expect(page.locator("#messages")).toContainText("请选择左侧的课程");
    // 课程列表已列出、无「上课中」授课界面
    await expect(page.locator("#bookList")).toContainText("选择态课程");
    // 未选课时：「上课」按钮禁用
    await expect(page.locator("#startLessonBtn")).toBeDisabled();
    // 点课程展开 → 展开章节 → 点课时 → 才进入该课的学习页面（课时预览 + 可上课）
    await page.click(".course-head");
    await page.click('.cc-ch-title[data-chidx="0"]');
    await page.click('.cc-lesson[data-lid="l1"]');
    await expect(page.locator("#messages .msg.card")).toContainText("已选中本节课");
    await expect(page.locator("#startLessonBtn")).toContainText("上课");
  });

  test("「新对话」已移出输入区，只在侧栏当前课程操作栏出现", async ({ page }) => {
    await expect(page.locator("#newChat")).toHaveCount(0);
    // 默认课程创建后自动展开，操作栏即出现「清空对话」
    await expect(page.locator(".course-clear-chat")).toBeVisible();
    await expect(page.locator(".course-clear-chat")).toContainText("清空对话");
  });
});

// ---------------------------------------------------------------------
// B11（2026-09-12）：恶意 / 畸形持久化数据的渲染防护。
// 背景：设置面板的「导入配置」会把备份文件里的 socratopia_* 值写进 localStorage。
// 旧实现零校验，于是**一份被改过的备份**就能让教材库里的 id、记忆里的字段变成任意字符串。
// 而渲染侧当时"同族只守一半"：ls.id 转义了、bk.id 没有；personality/habits 转义了、
// observations 没有 —— 两处都是可直接注入 innerHTML 的口子。
// 这条用真实页面证明三件事：① 不注入（无 <img>、无脚本执行）
//                        ② 转义不改变 id 的值（dataset 里仍是原文）
//                        ③ 畸形数据下功能照常（卡片/章节树仍能渲染、展开、选中课时）
// ---------------------------------------------------------------------
test.describe("恶意持久化数据的渲染防护（B11）", () => {
  test("被改过的备份：id 与字段带 HTML 时不注入，且功能仍可用", async ({ page }) => {
    const INJECT = '"><img src=x onerror="window.__pwned=1">';
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate((INJECT) => {
      localStorage.clear();
      const book = {
        id: INJECT, title: "恶意备份课程", material: "这份材料只是占位。", bookKey: "bkkey_evil",
        createdAt: "2026-09-12",
        outline: { chapters: [{ title: "第一章", lessons: [{ id: "ls1", title: "课时一", focus: "f", keyPoints: ["k"] }] }], advice: "" },
      };
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", INJECT);
      // observations 本该是数字（应用自增），这里模拟"备份里被改成了字符串"
      localStorage.setItem("socratopia_memory_bkkey_evil", JSON.stringify({
        topics: {
          "恶意备份课程": {
            mastered: [], weak: [], misconceptions: [], sessions: 1, selfScore: 0.5,
            userProfile: { habits: [], personality: "", adaptive: "", observations: INJECT },
          },
        },
      }));
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: "http://x/v1", apiKey: "k", model: "m", temperature: 0.7, role: "sanbingqi" }));
    }, INJECT);
    await page.reload({ waitUntil: "domcontentloaded" });

    // ① 未注入：没有多余的 <img>，也没有脚本被执行
    await expect(page.locator("#bookList")).toContainText("恶意备份课程");
    expect(await page.locator("#bookList img").count(), "不得渲染出注入的 <img>").toBe(0);
    expect(await page.evaluate(() => window.__pwned), "注入的脚本不得执行").toBeUndefined();

    // ② 转义不改变 id 的值：dataset 读回来必须还是原文（否则按 id 查书会全失效）
    expect(await page.locator(".course-card").first().getAttribute("data-bid")).toBe(INJECT);

    // ③ 畸形 id 下功能仍然可用：展开 → 章节树正常 → 点课时选中（走 dataset 比较，不再拼选择器）
    await page.click(".course-head");
    await expect(page.locator(".cc-ch-title").first()).toContainText("第一章");
    await page.click('.cc-ch-title[data-chidx="0"]');
    await page.click('.cc-lesson[data-lid="ls1"]');
    await expect(page.locator("#messages .msg.card")).toContainText("已选中本节课");

    // ④ 记忆面板：observations 非数字时不得原样拼进 HTML，也不得因类型异常而渲染崩掉
    expect(await page.locator("#memoryList img").count(), "记忆面板不得出现注入元素").toBe(0);
    expect(await page.locator("#memoryList").innerText(), "不得把原始载荷当文本显示")
      .not.toContain("onerror");
    await expect(page.locator("#memoryList")).toContainText("恶意备份课程");
    expect(await page.evaluate(() => window.__pwned), "全程都不得执行注入脚本").toBeUndefined();
  });
});

// ---- 后续扩展模板：发送消息 → 流式回复（需 API 桩或真实 Key）----
// 思路：用 page.route 拦截 **/chat/completions，返回与 OpenAI 兼容的 SSE 流，
//       然后启动一节「上课」、在 #userInput 输入并点 #sendBtn，断言 AI 气泡出现。
// 因「上课」需先选中课时且应用主打 file://，建议在 http 模式下、课程已含大纲时再启用。
