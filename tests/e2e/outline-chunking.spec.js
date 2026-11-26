const { test, expect } = require("@playwright/test");

/* =====================================================================
 *  大纲生成两条路径的回归测试：整书优先 vs 超长书分块降级
 *  --------------------------------------------------------------------
 *  背景（2026-09-08 重构）：上下文从 64K/128K 跃到 1M 后，几乎任何真书都能整本
 *  直读，因此「分块通读」应只作为「书真的超过窗口」时的降级路径；原实现把整书
 *  门槛写死成 8000 字，导致真书一律走分块、LLM 只见局部、大纲失去全局结构。
 *  现在门槛由 ctxWindow 与「输出预算」联合派生（1M + 64K 输出档位下 = 192,000 字，
 *  见 config.js limits.outlineWholeBookMaxChars；旧文档误记为 1,328,000 字）。
 *
 *  本用例把两条路径都锁住，防止"悄悄退回分块"或"超长书忘了分块"这类静默回归：
 *    A. 普通书（远低于门槛）→ 恰好 1 次调用，且是「整书」请求（含全书文本）
 *    B. 超长书（超过门槛）  → 多次「片段」请求，每次只带一片，不再发整书请求
 *
 *  路径判据用请求里的 prompt 特征（稳定、与 LLM 返回内容无关）：
 *    整书   ：user 消息以「【学习资料】」开头
 *    片段   ：user 消息含「【资料片段（全书第 N/M 段」
 *    骨架增强：user 消息含「【已按教材原文章节整理好的大纲骨架」（分块路径的收尾增强）
 *
 *  注意：config.js 并未把 APP_CONFIG 挂到 window（STRUCTURE_REVIEW.md 曾误记），
 *        无法从页面改写 ctxWindow，因此这里用「真实默认配置 + 真·超长书」触发分块，
 *        而不是缩小窗口 —— 顺带也测了真实配置下的行为。
 * ===================================================================== */

test.describe.configure({ timeout: 180000 });

const API_BASE = "http://127.0.0.1:8198/v1";
// 1M 档位下的整书门槛（短资料快捷路径上限）= 有效上下文 200K token * 0.6 * 1.6 ≈ 192,000 字
// （见 config.js limits.outlineWholeBookMaxChars；超过则退回「按原文章节分块提取」）
const WHOLE_BOOK_THRESHOLD = 192000;

// 在页面里搭一门课并触发「重生成大纲」。material 在浏览器内构造（避免把上百万字从
// Node 传进浏览器）。返回大纲生成期间捕获到的所有请求特征。
async function seedAndRegen(page, { chapterCount, perChapter, bookId, bookKey, rejectMaxTokensAbove, responseDelayMs = 0, trackProgress = false, withExerciseSections = false }) {
  const captured = []; // { kind, userLen }
  await page.route("**/chat/completions", async (route) => {
    let body = "{}";
    try { body = route.request().postData() || "{}"; } catch (e) { /* 忽略读取失败 */ }
    let j = {};
    try { j = JSON.parse(body); } catch (e) { j = {}; }
    const msgs = j.messages || [];
    const last = msgs[msgs.length - 1];
    const user = (last && last.content) || "";
    let kind = "other";
    if (user.includes("【学习资料】")) kind = "whole";
    else if (user.includes("【资料片段（全书第")) kind = "chunk";
    else if (user.includes("【已按教材原文章节整理好的大纲骨架")) kind = "advice";
    // max_tokens：防「输出被 provider 默认 4096 截断 → 大纲 JSON 不完整 → 生成不了」回归
    // （2026-09-08：整书优先后输出需求暴涨，两条路径都必须显式给足输出预算）
    // 可选延迟：让分块路径的备课浮层在生成期间持续可见，便于断言「浮层真的出现」
    if (responseDelayMs) { await new Promise((r) => setTimeout(r, responseDelayMs)); }
    captured.push({ kind, userLen: user.length, maxTokens: (j.max_tokens == null ? null : j.max_tokens) });

    // 模拟「模型输出上限较小」的 provider：max_tokens 超过阈值就 400，
    // 用来验证客户端会降级重试，而不是把「抬输出预算」变成小模型的致命错误。
    if (rejectMaxTokensAbove && j.max_tokens > rejectMaxTokensAbove) {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "max_tokens must be less than or equal to " + rejectMaxTokensAbove } }),
      });
      return;
    }

    // 桩响应同时满足 parseOutlineJson（要 chapters）与 parseChunkJson（要 lessons）。
    // 整书路径刻意返回 2 个带特征名的章，便于断言「新大纲真的渲染出来了」
    // （占位大纲只有 1 章，若断言数量会变成空转通过）。
    let chapterTitle = "整书第一章";
    const m = user.match(/全书第\s*(\d+)\//);
    if (m) chapterTitle = "第 " + m[1] + " 章";
    const lessons = [
      { id: "l1", title: "课时一", focus: "要点一", keyPoints: ["甲", "乙"], whyImportant: "WHY_课时一" },
      { id: "l2", title: "课时二", focus: "要点二", keyPoints: ["丙"], whyImportant: "WHY_课时二" },
    ];
    const chunkBridge = (kind === "chunk") ? "BRIDGE_" + chapterTitle : undefined;
    const chapters = (kind === "whole")
      ? [{ title: "整书第一章", lessons }, { title: "整书第二章", lessons }]
      : [{ title: chapterTitle, lessons }];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify({
          chapters,
          chapterTitle,
          lessons,
          bridge: chunkBridge,
        }) } }],
      }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(({ base, chapterCount, perChapter, bookId, bookKey, withExerciseSections }) => {
    localStorage.clear();
    // 造一本带 N 个「第X章」标题的书：每章 perChapter 字，总长 = N * perChapter
    let material = "";
    const filler = "内容内容内容";
    const fill = (n) => { let s = ""; while (s.length < n) s += filler; return s.slice(0, n); };
    for (let i = 1; i <= chapterCount; i++) {
      material += "第" + i + "章 章节标题" + i + "\n" + fill(perChapter) + "\n\n";
      // withExerciseSections：每章末尾再追加一个同名的「1. 习题」小节。
      // 跨章重名小节是 B2 的真实场景——旧实现「按标题全局分组」会把它们并成同一章。
      // 注意「1. 习题」是数字编号标题，需独占一行且上一行为空行才会被判为章边界。
      if (withExerciseSections) material += "1. 习题\n" + fill(perChapter) + "\n\n";
    }
    localStorage.setItem("socratopia_material_len_" + bookKey, String(material.length));
    const book = {
      id: bookId, title: "大纲路径测试课程", material, bookKey, createdAt: "2026-09-08",
      // 先给一个合法占位大纲（渲染需要 chapters）；重生成后会被新大纲覆盖
      outline: { chapters: [{ title: "占位章", lessons: [{ id: "z0", title: "占位课时", focus: "x", keyPoints: ["k"] }] }], advice: "" },
    };
    localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: base, apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
    localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
    localStorage.setItem("socratopia_current_book_v0", bookId);
  }, { base: API_BASE, chapterCount, perChapter, bookId, bookKey, withExerciseSections });

  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#bookList")).toContainText("大纲路径测试课程");

  // 注入浮层文案捕获器：分块路径进入即调用 showOutlineProgress 设置 #outlineProgressSub /
  // #outlineProgressDetail，用 MutationObserver 记录「是否出现过目标文案」。用观察者而非读取
  // 当前文本，是因为浮层文案在生成过程中会被「正在通读全书 第 N/7 段」覆盖，瞬时读取可能漏掉
  // 首帧的备课文案。仅在 trackProgress=true 时启用（A/B/C 不需要）。
  if (trackProgress) {
    await page.evaluate(() => {
      window.__outlineProgressSeen = { sub: false, detailMinutes: false, detailStop: false };
      const sub = document.getElementById("outlineProgressSub");
      const det = document.getElementById("outlineProgressDetail");
      if (sub) new MutationObserver(() => {
        if (sub.textContent.includes("老师正在研读教材备课中")) window.__outlineProgressSeen.sub = true;
      }).observe(sub, { childList: true, characterData: true, subtree: true });
      if (det) new MutationObserver(() => {
        if (det.textContent.includes("分钟")) window.__outlineProgressSeen.detailMinutes = true;
        if (det.textContent.includes("⏹")) window.__outlineProgressSeen.detailStop = true;
      }).observe(det, { childList: true, characterData: true, subtree: true });
    });
  }

  const materialLen = Number(await page.evaluate((k) => localStorage.getItem("socratopia_material_len_" + k), bookKey));

  // 展开课程 → 点「重生成大纲」（直接调 generateOutline()）
  await page.click(".course-head");
  await page.click(".course-regen-outline");
  if (trackProgress) {
    // 分块路径进入即显示备课浮层，断言它在生成期间「真的出现」（而非只在代码里）
    await expect(page.locator("#outlineProgressOverlay"), "分块路径应实时显示备课浮层").not.toHaveClass(/hidden/);
  }
  // 等大纲生成结束：按钮恢复（setBusy(false) 后 renderBookList 重建按钮）
  await expect(page.locator(".course-regen-outline")).toBeEnabled({ timeout: 150000 });
  const progressSeen = trackProgress ? await page.evaluate(() => window.__outlineProgressSeen || {}) : null;
  return { captured, materialLen, errors, progressSeen };
}

test.describe("大纲生成路径（整书优先 / 分块降级）", () => {
  test("A. 普通书走整书优先：仅 1 次调用且带全书，不走分块", async ({ page }) => {
    const { captured, materialLen, errors } = await seedAndRegen(page, {
      chapterCount: 2, perChapter: 3000, bookId: "bk_whole", bookKey: "bkkey_whole",
    });

    // 前置：确认这本书确实低于整书门槛（否则本用例测的就不是整书路径）
    expect(materialLen).toBeLessThan(WHOLE_BOOK_THRESHOLD);
    expect(materialLen).toBeGreaterThan(0);

    const whole = captured.filter((c) => c.kind === "whole");
    const chunk = captured.filter((c) => c.kind === "chunk");

    // 核心断言：整书请求恰好 1 次，且完全没有分块请求
    expect(whole.length, "整书请求应恰好 1 次").toBe(1);
    expect(chunk.length, "普通书不应触发分块").toBe(0);
    // 整书请求里带的就是全书（user 内容长度必然 ≥ 教材长度）
    expect(whole[0].userLen).toBeGreaterThanOrEqual(materialLen);
    // 必须显式给足输出预算：不传就会落到 provider 默认 4096，整本大纲 JSON 吐到一半被截断
    expect(whole[0].maxTokens, "整书请求必须显式传 max_tokens").not.toBeNull();
    expect(whole[0].maxTokens, "max_tokens 需足够大（否则大纲 JSON 被截断）").toBeGreaterThanOrEqual(8192);

    // 新大纲真的渲染出来了（特征章名来自整书桩响应，占位大纲是「占位章」）
    await expect(page.locator(".cc-ch-title")).toHaveCount(2);
    await expect(page.locator("#bookList")).toContainText("整书第一章");
    expect(errors, "不应有未捕获异常: " + errors.join(" | ")).toEqual([]);
  });

  test("B. 超长书降级为分块通读：多次片段请求，且不再发整书请求", async ({ page }) => {
    // 7 章 × 199000 字 ≈ 139 万字 > 门槛 1,328,000 字
    const { captured, materialLen, errors } = await seedAndRegen(page, {
      chapterCount: 7, perChapter: 199000, bookId: "bk_chunk", bookKey: "bkkey_chunk",
    });

    // 前置：确认这本书确实超过整书门槛（否则本用例测的就不是分块路径）
    expect(materialLen).toBeGreaterThan(WHOLE_BOOK_THRESHOLD);

    const whole = captured.filter((c) => c.kind === "whole");
    const chunk = captured.filter((c) => c.kind === "chunk");

    // 核心断言：绝不再发「整书」请求（否则就是把 139 万字塞进单次请求 → 必然超上下文）
    expect(whole.length, "超长书不应走整书直读").toBe(0);
    // 分块请求多次（按章切出 7 段）
    expect(chunk.length, "超长书应按片段多次提取").toBeGreaterThanOrEqual(7);
    // 每一片都远小于全书（证明确实切片了，而不是把全书重复发 N 次）
    for (const c of chunk) {
      expect(c.userLen, "单个片段请求不得接近全书长度").toBeLessThan(materialLen / 2);
      // 片段提取同样要显式给足输出预算（200K 字的片段可产出很多课时）
      expect(c.maxTokens, "片段请求必须显式传 max_tokens").not.toBeNull();
      expect(c.maxTokens).toBeGreaterThanOrEqual(8192);
    }

    // 分块结果仍能按原文章节归并出完整大纲（7 章）
    await expect(page.locator(".cc-ch-title")).toHaveCount(7);
    expect(errors, "不应有未捕获异常: " + errors.join(" | ")).toEqual([]);
  });

  test("C. provider 拒 max_tokens 过大时自动降级重试，而非整体失败", async ({ page }) => {
    // 抬输出预算修好了截断，但也可能踩到「模型输出上限更小」的 provider（返回 400）。
    // 这条锁住降级逻辑：必须退到该模型真正支持的上限重试成功，而不是让大纲彻底生成不了。
    // 2026-09-10（B6）：桩里的 400 文案刻意用 DeepSeek 真实措辞
    // "must be less than or equal to N"，据此断言「只重试一次」——因为客户端现会先
    // 从报错里抠出模型声明的上限（SocratopiaCore.extractMaxTokensCap）再退，而不是逐级试探。
    const { captured, errors } = await seedAndRegen(page, {
      chapterCount: 2, perChapter: 3000, bookId: "bk_fallback", bookKey: "bkkey_fallback",
      rejectMaxTokensAbove: 8192,
    });

    expect(captured.length, "应只重试一次（直接从报错读到模型上限，而非逐级试探）").toBe(2);
    expect(captured[0].maxTokens, "首次应按 config 给足输出预算").toBe(65536);
    const last = captured[captured.length - 1];
    expect(last.maxTokens, "应退到模型声明的上限 8192").toBe(8192);

    // 降级后大纲仍然生成成功（特征章名来自整书桩响应）
    await expect(page.locator("#bookList")).toContainText("整书第一章");
    expect(errors, "不应有未捕获异常: " + errors.join(" | ")).toEqual([]);
  });

  test("D. 分块路径实时显示「老师正在研读教材备课中…约 M 分钟」备课浮层", async ({ page }) => {
    // 这条把「长书分块生成时该有的备课提示浮层」锁进自动化：之前只靠代码审阅 + 手动启动验证，
    // 没进 E2E，存在静默回退风险（例如浮层文案被改、或分块路径不再调用 showOutlineProgress）。
    // 用 MutationObserver 捕获浮层文本变化（不依赖生成时序，即使桩立即返回也能抓住首帧文案），
    // 同时用 responseDelayMs 让浮层在生成期间持续可见，断言它真的「出现」而非只在 DOM 里。
    const { captured, materialLen, errors, progressSeen } = await seedAndRegen(page, {
      chapterCount: 7, perChapter: 199000, bookId: "bk_progress", bookKey: "bkkey_progress",
      responseDelayMs: 200, trackProgress: true,
    });

    // 前置：确认确实走了分块路径（整书路径是"单步"，走不确定态浮层，见用例 P）
    expect(materialLen).toBeGreaterThan(WHOLE_BOOK_THRESHOLD);
    expect(captured.filter((c) => c.kind === "whole").length, "浮层只在分块路径出现").toBe(0);
    expect(captured.filter((c) => c.kind === "chunk").length).toBeGreaterThanOrEqual(7);

    // 核心断言：浮层在生成期间出现过，且文案正是「老师正在研读教材备课中…约 M 分钟 + 可停止」
    expect(progressSeen, "未捕获到备课浮层文本变化，可能分块路径没调用 showOutlineProgress").toBeTruthy();
    expect(progressSeen.sub, "浮层标题应为备课提示『老师正在研读教材备课中』").toBe(true);
    expect(progressSeen.detailMinutes, "浮层详情应给出预计耗时（约 M 分钟）").toBe(true);
    expect(progressSeen.detailStop, "浮层详情应提示可随时停止（⏹）").toBe(true);

    // 生成结束后浮层应收起（确认是过程浮层，而非常驻），且大纲照常生成成功
    await expect(page.locator("#outlineProgressOverlay"), "生成结束后浮层应收起").toHaveClass(/hidden/);
    await expect(page.locator(".cc-ch-title")).toHaveCount(7);
    expect(errors, "不应有未捕获异常: " + errors.join(" | ")).toEqual([]);
  });

  test("E. 进入某章第一节课时，开场提示词注入该章 bridge（章级承上），不再凭空衔接", async ({ page }) => {
    // 这条锁住「换章突兀」的修复：generateLessonStart 在课时开场时，若该课是某章第一节课，
    // 应把该章的 bridge（章导语）注入 lessonStart 的 user 提示词，并标注「章级承上 bridge」，
    // 让模型用真实信息做章级衔接，而不是凭空编造上一章内容。
    // 之前只靠代码审阅，没进自动化——存在「bridge 没生成 / 没注入」的静默回退风险。
    const captured = [];
    await page.route("**/chat/completions", async (route) => {
      let body = "{}";
      try { body = route.request().postData() || "{}"; } catch (e) { /* 忽略读取失败 */ }
      let j = {};
      try { j = JSON.parse(body); } catch (e) { j = {}; }
      const msgs = j.messages || [];
      const last = msgs[msgs.length - 1];
      const user = (last && last.content) || "";
      // 只捕获 lessonStart（含【当前课时信息】），忽略可能的其他请求
      if (user.includes("【当前课时信息】")) captured.push({ user });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "（开场白占位）" } }] }),
      });
    });

    // 直接塞一份带 bridge + whyImportant 的已知大纲，跳过大纲生成（避免桩覆盖）
    const bridgeText = "BRIDGE_MARKER_上一章解决了稀缺的来由，本章把稀缺落到日常决策";
    const whyText = "WHY_MARKER_搞懂这课你能解释为什么日常决策总被稀缺牵着走";
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(({ base, bridgeText, whyText }) => {
      localStorage.clear();
      const outline = {
        chapters: [
          { title: "第一章 起点", lessons: [
            { id: "c1_l1", title: "课时一", focus: "焦点一", keyPoints: ["甲"] },
            { id: "c1_l2", title: "课时二", focus: "焦点二", keyPoints: ["乙"] },
          ] },
          { title: "第二章 应用", bridge: bridgeText, lessons: [
            { id: "c2_l1", title: "课时A", focus: "焦点A", keyPoints: ["丙"], whyImportant: whyText },
            { id: "c2_l2", title: "课时B", focus: "焦点B", keyPoints: ["丁"] },
          ] },
        ],
        advice: "",
      };
      const book = {
        id: "bk_ls", title: "衔接测试课程",
        material: "第一章 起点\n内容\n\n第二章 应用\n内容", bookKey: "bkkey_ls",
        createdAt: "2026-09-08", outline,
      };
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: base, apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", "bk_ls");
    }, { base: API_BASE, bridgeText, whyText });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("衔接测试课程");

    // 展开课程 → 展开第二章 → 选第二章第一节课 → 点「📚 上课」触发 generateLessonStart
    await page.click(".course-head");
    // 章节默认折叠（cc-ch-lessons 无 open 类时隐藏），需先点章标题展开才能看到课时
    await page.locator(".cc-ch-title", { hasText: "第二章 应用" }).click();
    // 点击课时 → 仅选中并预览（showLessonPreview），不自动上课
    await page.locator(".cc-lesson", { hasText: "课时A" }).click();
    // 必须点「📚 上课」才真正进入课堂、触发 generateLessonStart
    await page.click("#startLessonBtn");
    // 等开场生成完成（AI 气泡类名是 msg ai，不是 msg assistant）
    await expect(page.locator(".msg.ai"), "课时开场应生成完成").toContainText("开场白占位", { timeout: 60000 });

    // 核心断言：恰好 1 次 lessonStart，且其提示词注入了该章 bridge + 章级承上标记
    expect(captured.length, "应捕获到 1 次 lessonStart 请求").toBe(1);
    const u = captured[0].user;
    expect(u, "lessonStart 应注入该章 bridge 作为章级承上").toContain(bridgeText);
    expect(u, "lessonStart 应标注「章级承上 bridge」标记").toContain("章级承上 bridge");
    // batch 2：lessonStart 应同时注入该课 whyImportant 作为价值锚点
    expect(u, "lessonStart 应注入 whyImportant 价值锚点").toContain(whyText);
  });

  test("F. 「查看原文」按章切真迹：书首带目录不命中，显示该章正文而非目录残行", async ({ page }) => {
    // 真实 bug 回归：教材书首常有带 ](#锚点) 的目录，旧实现用 indexOf 命中目录行，
    // 切出来是「第 1 章 …](#」残行、正文空白；且旧实现按课时切（课时坐标是按比例
    // 均分的假边界），会切在半句中间。现在应：下拉按章、内容按章真实标题边界切。
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(({ base }) => {
      localStorage.clear();
      // 书首目录 + 正文三章（模拟带锚点目录的电子书导出件）
      const body = (t) => t + "\n\n" + "这里是" + t + "的正文，足够长以便切片显示。".repeat(40) + "\n\n";
      const material =
        "# 目录\n\n[第一章 环境](#ch1)\n[第二章 语法](#ch2)\n[第三章 实战](#ch3)\n\n" +
        "## 第一章 环境\n" + body("MARKER_环境章") +
        "## 第二章 语法\n" + body("MARKER_语法章") +
        "## 第三章 实战\n" + body("MARKER_实战章");
      const outline = { chapters: [
        { title: "第一章 环境", lessons: [{ id: "c1_l1", title: "装环境" }, { id: "c1_l2", title: "跑起来" }] },
        { title: "第二章 语法", lessons: [{ id: "c2_l1", title: "变量" }] },
        { title: "第三章 实战", lessons: [{ id: "c3_l1", title: "小项目" }] },
      ], advice: "" };
      const book = {
        id: "bk_src", title: "原文测试课程", material, bookKey: "bkkey_src",
        createdAt: "2026-09-08", outline,
      };
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: base, apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", "bk_src");
    }, { base: API_BASE });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("原文测试课程");

    // 展开课程 → 点「📄 查看原文」
    await page.click(".course-head");
    await page.click(".course-source");
    await expect(page.locator("#sourceOverlay")).not.toHaveClass(/hidden/);

    // 粒度断言：下拉是「章」而不是「课时」（章级选项值为 ch:<序号>）
    const opts = await page.locator("#sourceLessonSelect option").allTextContents();
    expect(opts.length, "下拉应按章列出 3 项").toBe(3);
    expect(opts[0], "首项应为第一章章名").toContain("第一章 环境");
    expect(opts.join("|"), "下拉不应出现课时名（按章切）").not.toContain("装环境");

    // 内容断言：第一章显示的是正文，不是目录残行
    const text1 = await page.locator("#sourceText").textContent();
    expect(text1, "应显示第一章正文").toContain("MARKER_环境章");
    expect(text1, "不应命中书首目录的 ](# 锚点行").not.toContain("](#");
    expect(text1.length, "整章正文应有一定长度，不是残行").toBeGreaterThan(200);

    // 切到第三章：同样应切到正文，且不串章（不含第一章正文标记）
    await page.selectOption("#sourceLessonSelect", "ch:2");
    const text3 = await page.locator("#sourceText").textContent();
    expect(text3, "切章后应显示第三章正文").toContain("MARKER_实战章");
    expect(text3, "不应把第一章内容串进来").not.toContain("MARKER_环境章");
    expect(await page.locator("#sourceSub").textContent(), "副标题应标注章与字数").toContain("第 3 章 · 第三章 实战");
  });

  test("G. 上课时喂给老师的材料是「本课在章内的真实片段」，不是按比例均分的错段", async ({ page }) => {
    // 旧实现用章内按比例均分的课时坐标切材料 → 老师拿到的可能是别课的内容。
    // 现在应在章区间内按 keyPoints 定位：本课材料含本课标记，不含其他课的标记。
    const captured = [];
    await page.route("**/chat/completions", async (route) => {
      let body = "{}";
      try { body = route.request().postData() || "{}"; } catch (e) { /* 忽略读取失败 */ }
      let j = {};
      try { j = JSON.parse(body); } catch (e) { j = {}; }
      const msgs = j.messages || [];
      const last = msgs[msgs.length - 1];
      const user = (last && last.content) || "";
      if (user.includes("【当前课时信息】")) captured.push({ user });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "（开场白占位）" } }] }),
      });
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(({ base }) => {
      localStorage.clear();
      // 材料需 > shortBookChars(16000) 才走切片分支
      const pad = "章内填充正文内容。".repeat(400);
      const material =
        "第一章 基础\n" + pad + "\n这里讲【MARKER_1A 作用域】。\n" + pad +
        "\n第二章 进阶\n" + pad + "\n这里讲【MARKER_2A 闭包】。\n" + pad +
        "\n这里讲【MARKER_2B 装饰器】。\n" + pad;
      const outline = { chapters: [
        { title: "第一章 基础", lessons: [{ id: "g1_l1", title: "作用域", focus: "作用域", keyPoints: ["MARKER_1A"] }] },
        { title: "第二章 进阶", bridge: "本章承接基础", lessons: [
          { id: "g2_l1", title: "闭包", focus: "闭包", keyPoints: ["MARKER_2A"] },
          { id: "g2_l2", title: "装饰器", focus: "装饰器", keyPoints: ["MARKER_2B"] },
        ] },
      ], advice: "" };
      const book = {
        id: "bk_mat", title: "材料切片课程", material, bookKey: "bkkey_mat",
        createdAt: "2026-09-08", outline,
      };
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: base, apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", "bk_mat");
    }, { base: API_BASE });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("材料切片课程");

    // 展开课程 → 展开第二章 → 选「装饰器」（章内第 2 课，均分坐标会切错）→ 上课
    await page.click(".course-head");
    await page.locator(".cc-ch-title", { hasText: "第二章 进阶" }).click();
    await page.locator(".cc-lesson", { hasText: "装饰器" }).click();
    await page.click("#startLessonBtn");
    await expect(page.locator(".msg.ai"), "课时开场应生成完成").toContainText("开场白占位", { timeout: 60000 });

    expect(captured.length, "应捕获到 1 次 lessonStart 请求").toBe(1);
    const u = captured[0].user;
    expect(u, "本课材料应含本课的 MARKER_2B").toContain("MARKER_2B");
    expect(u, "本课材料不应含上一课的 MARKER_2A").not.toContain("MARKER_2A");
    expect(u, "本课材料不应含第一章的 MARKER_1A").not.toContain("MARKER_1A");
    expect(u, "应标注为章内定位切出").toContain("在所属章内定位切出");
  });

  test("H. 旧大纲（坐标字段齐全但算法版本落后）自动重算，用户不必重生成大纲", async ({ page }) => {
    // 真实场景：localStorage 里存着旧版本算出的坐标——字段齐全（所以旧的
    // 「缺坐标才重算」判据不会触发），但值是错的（命中目录残行 / 课时按比例均分）。
    // 期望：读取时按算法版本自动重算一次（纯前端零 token），并持久化版本，
    // 用户无需重生成大纲（那才要烧 token 且会清掉课时进度）。
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const staleStart = await page.evaluate(({ base }) => {
      localStorage.clear();
      const body = (t) => t + "\n\n" + "这里是" + t + "的正文，足够长以便切片显示。".repeat(40) + "\n\n";
      const material =
        "# 目录\n\n[第一章 环境](#ch1)\n[第二章 语法](#ch2)\n[第三章 实战](#ch3)\n\n" +
        "## 第一章 环境\n" + body("MARKER_环境章") +
        "## 第二章 语法\n" + body("MARKER_语法章") +
        "## 第三章 实战\n" + body("MARKER_实战章");
      // 故意写入错误坐标：三章起点全落在书首目录区（0/30/60），课时按均分
      const outline = {
        chapters: [
          { title: "第一章 环境", _charStart: 0, _charEnd: 30, lessons: [
            { id: "c1_l1", title: "装环境", _charStart: 0, _charEnd: 15 },
            { id: "c1_l2", title: "跑起来", _charStart: 15, _charEnd: 30 },
          ] },
          { title: "第二章 语法", _charStart: 30, _charEnd: 60, lessons: [
            { id: "c2_l1", title: "变量", _charStart: 30, _charEnd: 60 },
          ] },
          { title: "第三章 实战", _charStart: 60, _charEnd: 90, lessons: [
            { id: "c3_l1", title: "小项目", _charStart: 60, _charEnd: 90 },
          ] },
        ],
        advice: "",
        // 注意：没有 _indexVersion —— 模拟旧版本存下来的大纲
      };
      const book = { id: "bk_stale", title: "旧大纲课程", material, bookKey: "bkkey_stale", createdAt: "2026-09-08", outline };
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: base, apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", "bk_stale");
      return outline.chapters[1]._charStart;
    }, { base: API_BASE });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("旧大纲课程");

    // 打开原文面板 → 应触发自动重算
    await page.click(".course-head");
    await page.click(".course-source");
    await expect(page.locator("#sourceOverlay")).not.toHaveClass(/hidden/);

    const text1 = await page.locator("#sourceText").textContent();
    expect(text1, "旧错误坐标应被纠正，显示第一章正文").toContain("MARKER_环境章");
    expect(text1, "不应再切出目录残行").not.toContain("](#");
    expect(text1.length, "整章正文应完整，不是 30 字的残段").toBeGreaterThan(200);

    // 持久化：重算结果应写回 localStorage（版本号 + 纠正后的坐标）
    const after = await page.evaluate(() => {
      const lib = JSON.parse(localStorage.getItem("socratopia_library_v0") || "[]");
      const od = lib[0] && lib[0].outline;
      return { ver: od && od._indexVersion, ch2Start: od && od.chapters[1]._charStart };
    });
    expect(after.ver, "重算后应写入当前索引版本号并持久化").toBe(2);
    expect(after.ch2Start, "第二章坐标应被纠正（不再是旧的 30）").not.toBe(staleStart);
  });

  test("I. 长书分块路径也产出 bridge + whyImportant（batch1/2 不只对短书生效）", async ({ page }) => {
    // 真实回归：之前 batch 1（章导语 bridge）/ batch 2（价值锚点 whyImportant）只要求整书直读路径
    // 的 outlineRules 产出，而长书走的是 outlineChunkRules → 确定性归并，该路径从未产出 bridge /
    // whyImportant → 长书（绝大多数真教材）开场既无章级承上、也无价值锚点。本用例锁住：
    // 分块路径的「逐段提取」必须产出 bridge（章级）+ whyImportant（课级），并由 mergePartialsByChapter
    // 确定性归集到最终大纲，长书与短书字段完全一致。
    const { errors } = await seedAndRegen(page, {
      chapterCount: 7, perChapter: 199000, bookId: "bk_longfields", bookKey: "bkkey_longfields",
    });
    expect(errors, "不应有未捕获异常: " + errors.join(" | ")).toEqual([]);

    // 读回生成后的大纲，断言字段真的落到了大纲上（而不只是 prompt 里要求了）
    const outline = await page.evaluate(() => {
      const lib = JSON.parse(localStorage.getItem("socratopia_library_v0") || "[]");
      return lib[0] && lib[0].outline;
    });
    expect(outline && outline.chapters.length, "应生成 7 章").toBe(7);
    const bridges = outline.chapters.map((ch) => ch.bridge).filter(Boolean);
    const whys = outline.chapters.flatMap((ch) => (ch.lessons || []).map((l) => l.whyImportant)).filter(Boolean);
    expect(bridges.length, "长书每章都应产出 bridge（章导语）").toBe(7);
    expect(bridges.join("|"), "bridge 应来自分块提取（含 BRIDGE_ 标记）").toContain("BRIDGE_");
    expect(whys.length, "长书每课都应产出 whyImportant（价值锚点）").toBeGreaterThan(0);
    expect(whys.join("|"), "whyImportant 应来自分块提取（含 WHY_ 标记）").toContain("WHY_");
  });

  test("J. 跨章重名的小节（每章末尾「1. 习题」）不被并成同一章（B2）", async ({ page }) => {
    // 真实回归（2026-09-10 修 B2）：mergePartialsByChapter 原先按归一化标题**全局**分组，
    // 于是跨章重复出现的小节名（每章末尾的「1. 习题」「本章小结」「Exercises」「思考题」）
    // 会被并成同一个章，破坏教材原有章节结构。而长书必然走归并路径，所以真教材基本都会踩到。
    // 本用例用真实教材走完整链路（不做任何函数级 mock）：
    //   splitBookIntoChunks 按原文标题边界切 → 逐段提取 → mergePartialsByChapter 归并 → 落盘 localStorage
    // 记录：修复前此处会得到 3 章（两个「1. 习题」被合并），修复后为 4 章。
    const { errors } = await seedAndRegen(page, {
      chapterCount: 2, perChapter: 110000, withExerciseSections: true,
      bookId: "bk_dupsec", bookKey: "bkkey_dupsec",
    });
    expect(errors, "不应有未捕获异常: " + errors.join(" | ")).toEqual([]);

    const outline = await page.evaluate(() => {
      const lib = JSON.parse(localStorage.getItem("socratopia_library_v0") || "[]");
      return lib[0] && lib[0].outline;
    });
    const titles = (outline.chapters || []).map((ch) => ch.title);
    expect(titles.filter((t) => /习题/.test(t)).length,
      "每章末尾的同名小节应各自成章，而非被并成 1 章: " + titles.join(" | ")).toBe(2);
    expect(titles, "章序应与原文顺序一致（重名小节不得跨章合并）")
      .toEqual(["第1章 章节标题1", "1. 习题", "第2章 章节标题2", "1. 习题"]);
  });

  test("K. 点课时 📄 → 在整章里高亮该课时区段并滚过去（不切片、不切半句）", async ({ page }) => {
    // 缺口①：旧实现点课时 📄 只给「所属章」，用户还得自己在整章里翻。
    // 现在课时坐标（indexLessonPositions 算好的）改用于「高亮 + 滚动」——
    // 既不切出半句话（课时边界未必是原文小标题），也不让用户自己找。
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(({ base }) => {
      localStorage.clear();
      const head1 = "## 第一章 环境\n";
      const body1 = "LESSON_ONE_BODY\n" + "环境正文段落内容。".repeat(120) + "\n\n";
      const body2 = "LESSON_TWO_BODY\n" + "变量正文段落内容。".repeat(120) + "\n\n";
      const head2 = "## 第二章 语法\n";
      const body3 = "MARKER_语法章\n" + "语法正文段落内容。".repeat(60) + "\n";
      const material = head1 + body1 + body2 + head2 + body3;
      const l1s = head1.length, l1e = l1s + body1.length, l2e = l1e + body2.length;
      const outline = {
        // 带当前版本号 + 完整坐标 → 不触发重算，坐标即断言基准
        _indexVersion: 2,
        chapters: [
          { title: "第一章 环境", _charStart: 0, _charEnd: l2e, lessons: [
            { id: "k1_l1", title: "装环境", _charStart: l1s, _charEnd: l1e, _located: true },
            { id: "k1_l2", title: "原理", _charStart: l1e, _charEnd: l2e, _located: true },
          ] },
          { title: "第二章 语法", _charStart: l2e, _charEnd: material.length, lessons: [
            { id: "k2_l1", title: "变量", _charStart: l2e, _charEnd: material.length, _located: true },
          ] },
        ],
        advice: "",
      };
      const book = { id: "bk_hl", title: "课时高亮课程", material, bookKey: "bkkey_hl",
        createdAt: "2026-09-10", outline };
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: base, apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", "bk_hl");
    }, { base: API_BASE });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("课时高亮课程");

    // 展开课程 → 展开第一章 → 点第 2 节课的 📄
    await page.click(".course-head");
    await page.locator(".cc-ch-title").first().click();
    // 所有章的课时列表都在 DOM 里（收起只是 CSS 隐藏），故共 3 个 📄：ch1 两个 + ch2 一个
    const srcBtns = page.locator(".cc-lesson-source");
    await expect(srcBtns).toHaveCount(3);
    await srcBtns.nth(1).click();
    await expect(page.locator("#sourceOverlay")).not.toHaveClass(/hidden/);

    const info = await page.evaluate(() => {
      const box = document.getElementById("sourceText");
      const marks = box.querySelectorAll(".src-lesson");
      const mark = marks[0];
      const r = mark ? mark.getBoundingClientRect() : null;
      const c = box.getBoundingClientRect();
      return {
        markCount: marks.length,
        markText: mark ? mark.textContent : "",
        scrollTop: box.scrollTop,
        markTopInBox: r ? Math.round(r.top - c.top) : null,
      };
    });

    expect(info.markCount, "应且仅应高亮 1 个课时区段").toBe(1);
    expect(info.markText, "高亮区段应是第 2 节课的正文").toContain("LESSON_TWO_BODY");
    expect(info.markText, "不该把第 1 节课的正文也圈进来").not.toContain("LESSON_ONE_BODY");
    expect(info.scrollTop, "应自动滚动到该课时（它在整章中偏后）").toBeGreaterThan(0);
    expect(Math.abs(info.markTopInBox), "滚动后该课时应在可视区顶部附近")
      .toBeLessThan(90);

    // 手动切章后不应残留课时高亮（避免"看着像本节课，其实是别章"的误导）
    await page.selectOption("#sourceLessonSelect", "ch:0");
    expect(await page.locator("#sourceText .src-lesson").count(),
      "手动切章后应清除课时高亮").toBe(0);
  });

  test("L. 章切片过短时说明原因，而不是静默显示全文", async ({ page }) => {
    // 缺口②：旧实现 `if (!text || text.trim().length < 10)` 直接退全文并把标签改成「全文」，
    // 用户分不清是「章名没在原文里命中」还是「该章本来就短」。现在必须给出原因。
    // 造法：原文首部连续三行是三个极短章名（模拟目录式堆叠）→ 第一章跨度仅 2 字。
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const seeded = await page.evaluate(({ base }) => {
      localStorage.clear();
      const material = "甲\n乙\n丙\n" + "这是很长的正文内容。".repeat(200);
      const outline = {
        chapters: [
          { title: "甲", lessons: [{ id: "j_l1", title: "课甲" }] },
          { title: "乙", lessons: [{ id: "y_l1", title: "课乙" }] },
          { title: "丙", lessons: [{ id: "p_l1", title: "课丙" }] },
        ],
        advice: "",
        // 无 _indexVersion → 打开面板时自动重算坐标（走真实定位算法，不靠手填）
      };
      const book = { id: "bk_short", title: "过短章课程", material, bookKey: "bkkey_short",
        createdAt: "2026-09-10", outline };
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: base, apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", "bk_short");
      return material.length;
    }, { base: API_BASE });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.click(".course-head");
    await page.click(".course-source");
    await expect(page.locator("#sourceOverlay")).not.toHaveClass(/hidden/);

    // 前置确认：定位确实把第一章算成了极短跨度（否则本用例是空转通过）
    const ch1 = await page.evaluate(() => {
      const lib = JSON.parse(localStorage.getItem("socratopia_library_v0") || "[]");
      const c = lib[0].outline.chapters[0];
      return { start: c._charStart, end: c._charEnd, ver: lib[0].outline._indexVersion };
    });
    expect(ch1.ver, "应已写入索引版本号（重算确实跑了）").toBe(2);
    expect(ch1.end - ch1.start, "第一章跨度应确为极短（用例前提）").toBeLessThan(10);

    const sub = await page.locator("#sourceSub").textContent();
    expect(sub, "应说明退化为全文的原因").toContain("过短");
    const text = await page.locator("#sourceText").textContent();
    expect(text, "退化为全文时应给出完整原文").toContain("这是很长的正文内容。");
    expect(text.length, "全文应远长于那个 2 字残段").toBeGreaterThan(seeded / 2);
  });

  test("M. 原文查找：命中高亮 + 计数 + 上一个/下一个循环 + 清除", async ({ page }) => {
    // 缺口③：原文只能手翻。查找是纯本地字符串检索，零 token。
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(({ base }) => {
      localStorage.clear();
      // 无大纲 → 走「全文」路径，同时顺带验证该分支的原因提示
      const material = "开头。关键词一号。中间。关键词二号。尾部。关键词三号。结束。";
      const book = { id: "bk_find", title: "查找课程", material, bookKey: "bkkey_find",
        createdAt: "2026-09-10", outline: { chapters: [], advice: "" } };
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: base, apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", "bk_find");
    }, { base: API_BASE });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.click(".course-head");
    await page.click(".course-source");
    await expect(page.locator("#sourceOverlay")).not.toHaveClass(/hidden/);

    // 无大纲 → 应说明退化原因（而非静默「全文」）
    expect(await page.locator("#sourceSub").textContent(), "无大纲时应说明已显示全文")
      .toContain("尚未拆分大纲");

    // 无检索词时不应有任何高亮
    expect(await page.locator("#sourceText mark").count()).toBe(0);

    await page.fill("#sourceFindInput", "关键词");
    expect(await page.locator("#sourceText .src-hit").count(), "非当前命中应有 2 处").toBe(2);
    expect(await page.locator("#sourceText .src-hit-cur").count(), "当前命中应有 1 处").toBe(1);
    expect(await page.locator("#sourceFindCount").textContent(), "应显示 1/3").toBe("1/3");
    // 高亮不得吞字：正文逐字仍在
    const full = await page.locator("#sourceText").textContent();
    expect(full).toBe("开头。关键词一号。中间。关键词二号。尾部。关键词三号。结束。");

    await page.click("#sourceFindNext");
    expect(await page.locator("#sourceFindCount").textContent(), "下一个 → 2/3").toBe("2/3");
    await page.click("#sourceFindPrev");
    await page.click("#sourceFindPrev");
    expect(await page.locator("#sourceFindCount").textContent(), "上一个应首尾循环 → 3/3").toBe("3/3");

    // 回车等同「下一个」（Shift+回车 反向）
    await page.locator("#sourceFindInput").press("Enter");
    expect(await page.locator("#sourceFindCount").textContent(), "回车 → 下一处（循环回 1/3）").toBe("1/3");
    await page.locator("#sourceFindInput").press("Shift+Enter");
    expect(await page.locator("#sourceFindCount").textContent(), "Shift+回车 → 上一处（→ 3/3）").toBe("3/3");

    // 无匹配时给出「无匹配」，且不残留旧高亮
    await page.fill("#sourceFindInput", "不存在的词");
    expect(await page.locator("#sourceFindCount").textContent()).toBe("无匹配");
    expect(await page.locator("#sourceText mark").count(), "无匹配时不应残留高亮").toBe(0);

    await page.fill("#sourceFindInput", "关键词");
    await page.click("#sourceFindClear");
    expect(await page.locator("#sourceFindCount").textContent()).toBe("");
    expect(await page.locator("#sourceText mark").count(), "清除后不应残留高亮").toBe(0);
  });

  test("N. 查找跨章连续：计数是全书口径，「下一个」自动翻到下一章继续找", async ({ page }) => {
    // 缺口④：查找原本只在「当前章」内检索 —— 切章就重新从 1 开始数，
    // 用户以为只命中 1 处，其实后面几章还有。现在计数是全书口径，翻页自动跨章。
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(({ base }) => {
      localStorage.clear();
      const head1 = "## 第一章 环境\n";
      const c1 = "开头部分。" + "环境正文。".repeat(80) + "关键词甲在这里。\n\n";
      const head2 = "## 第二章 语法\n";
      const c2 = "语法开头。" + "语法正文。".repeat(80) + "关键词乙在这里。\n";
      const material = head1 + c1 + head2 + c2;
      const ch1End = (head1 + c1).length;
      const outline = {
        _indexVersion: 2,
        chapters: [
          { title: "第一章 环境", _charStart: 0, _charEnd: ch1End, lessons: [
            { id: "n1_l1", title: "装环境", _charStart: head1.length, _charEnd: ch1End, _located: true },
          ] },
          { title: "第二章 语法", _charStart: ch1End, _charEnd: material.length, lessons: [
            { id: "n2_l1", title: "变量", _charStart: ch1End, _charEnd: material.length, _located: true },
          ] },
        ],
        advice: "",
      };
      const book = { id: "bk_xch", title: "跨章查找课程", material, bookKey: "bkkey_xch",
        createdAt: "2026-09-10", outline };
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: base, apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", "bk_xch");
    }, { base: API_BASE });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.click(".course-head");
    await page.click(".course-source");
    await expect(page.locator("#sourceOverlay")).not.toHaveClass(/hidden/);
    expect(await page.locator("#sourceLessonSelect").inputValue(), "默认应停在第 1 章").toBe("ch:0");

    await page.fill("#sourceFindInput", "关键词");

    // 计数是「全书 2 处」而不是「本章 1 处」
    expect(await page.locator("#sourceFindCount").textContent(),
      "计数应为全书口径 1/2（旧实现在本章内只会显示 1/1）").toBe("1/2");
    expect(await page.locator("#sourceText .src-hit-cur").textContent()).toBe("关键词");
    // 每章只有 1 处命中 → 本章内不应有"非当前命中"残留
    expect(await page.locator("#sourceText .src-hit").count(), "本章不应出现第 2 处高亮").toBe(0);
    expect(await page.locator("#sourceText").textContent(), "第 1 章内容").toContain("关键词甲");
    expect(await page.locator("#sourceText").textContent(), "第 1 章不应串入第 2 章内容")
      .not.toContain("关键词乙");

    // 「下一个」→ 自动翻到第 2 章
    await page.click("#sourceFindNext");
    expect(await page.locator("#sourceLessonSelect").inputValue(), "应自动切到第 2 章").toBe("ch:1");
    expect(await page.locator("#sourceFindCount").textContent()).toBe("2/2");
    expect(await page.locator("#sourceText").textContent(), "应显示第 2 章内容").toContain("关键词乙");
    expect(await page.locator("#sourceText .src-hit-cur").textContent()).toBe("关键词");
    expect(await page.locator("#sourceSub").textContent(), "副标题应跟到第 2 章").toContain("第 2 章");

    // 再「下一个」→ 首尾循环回第 1 章，证明跨章是环绕的
    await page.click("#sourceFindNext");
    expect(await page.locator("#sourceLessonSelect").inputValue(), "循环应回到第 1 章").toBe("ch:0");
    expect(await page.locator("#sourceFindCount").textContent()).toBe("1/2");

    // 手动切到第 2 章后，序号应自动重锚到「本章第一个命中」（而不是停在别章的序号上）
    await page.selectOption("#sourceLessonSelect", "ch:1");
    expect(await page.locator("#sourceFindCount").textContent(), "切章后应重锚到本章的命中").toBe("2/2");
  });

  test("O. 点原文任意位置 → 反查这属于哪一节课（并保持滚动位置）", async ({ page }) => {
    // 缺口⑤：从原文反向找课时 —— 读到一段话想知道"这是哪节课在讲"。
    // 用已算好的课时区间做反查；点不同段落应切到不同课时。
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(({ base }) => {
      localStorage.clear();
      const head1 = "## 第一章 环境\n";
      const body1 = "LESSON_ONE_BODY\n" + "环境正文段落内容。".repeat(120) + "\n\n";
      const body2 = "LESSON_TWO_BODY\n" + "变量正文段落内容。".repeat(120) + "\n\n";
      const material = head1 + body1 + body2;
      const l1s = head1.length, l1e = l1s + body1.length, l2e = l1e + body2.length;
      const outline = {
        _indexVersion: 2,
        chapters: [
          { title: "第一章 环境", _charStart: 0, _charEnd: material.length, lessons: [
            { id: "o_l1", title: "装环境", _charStart: l1s, _charEnd: l1e, _located: true },
            { id: "o_l2", title: "原理", _charStart: l1e, _charEnd: l2e, _located: true },
          ] },
        ],
        advice: "",
      };
      const book = { id: "bk_click", title: "点原文课程", material, bookKey: "bkkey_click",
        createdAt: "2026-09-10", outline };
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: base, apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", "bk_click");
    }, { base: API_BASE });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.click(".course-head");
    await page.click(".course-source");
    await expect(page.locator("#sourceOverlay")).not.toHaveClass(/hidden/);

    // 从「查看原文」进来不带课时焦点 → 初始不应有课时高亮
    expect(await page.locator("#sourceText .src-lesson").count(),
      "未指定课时时不应凭空高亮").toBe(0);

    // 求出某段文字的屏幕坐标（必要时先把该段滚进可视区），点击仍在测试里显式发出
    async function pointText(text) {
      const pt = await page.evaluate((t) => {
        const box = document.getElementById("sourceText");
        const w = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const i = n.data.indexOf(t);
          if (i < 0) continue;
          const rng = document.createRange();
          rng.setStart(n, i); rng.setEnd(n, i + t.length);
          let b = rng.getBoundingClientRect();
          const c = box.getBoundingClientRect();
          if (b.top < c.top + 20 || b.bottom > c.bottom - 20) {
            box.scrollTop += (b.top - c.top) - 60;
            b = rng.getBoundingClientRect();
          }
          return { x: Math.round(b.left + 6), y: Math.round(b.top + 3) };
        }
        return null;
      }, text);
      expect(pt, "测试前提：原文里应能找到 " + text).not.toBeNull();
      return pt;
    }
    const scrollTop = () => page.evaluate(() => document.getElementById("sourceText").scrollTop);
    // 点击并断言「反查不改变滚动位置」：基线必须取在**点击前一刻**
    // （pointText 为了把目标滚进可视区会主动改 scrollTop，不是应用造成的）
    async function clickAndCheckScroll(text) {
      const pt = await pointText(text);
      const before = await scrollTop();
      await page.mouse.click(pt.x, pt.y);
      const after = await scrollTop();
      const markText = await page.locator("#sourceText .src-lesson").textContent();
      expect(Math.abs(after - before), "点原文反查不应改变滚动位置（" + text + "）").toBeLessThanOrEqual(2);
      return markText;
    }

    let mark = await clickAndCheckScroll("LESSON_ONE_BODY");
    expect(mark, "点第 1 节课的段落应高亮第 1 节").toContain("LESSON_ONE_BODY");
    expect(mark, "不应高亮到第 2 节").not.toContain("LESSON_TWO_BODY");
    expect(await page.locator("#sourceSub").textContent(), "应告知这段属于哪节课")
      .toContain("这段原文属于课时《装环境》");

    mark = await clickAndCheckScroll("LESSON_TWO_BODY");
    expect(mark, "点第 2 节课的段落应改高亮第 2 节").toContain("LESSON_TWO_BODY");
    expect(mark, "不应仍高亮第 1 节").not.toContain("LESSON_ONE_BODY");
    expect(await page.locator("#sourceSub").textContent()).toContain("这段原文属于课时《原理》");
    expect(await page.locator("#sourceText .src-lesson").count(), "同时只应高亮 1 节课").toBe(1);
  });

  test("P. 整书直读也有进度浮层：不确定态进度条 + 实时「已等待」+ 浮层内可停止（B8b）", async ({ page }) => {
    // 背景：整书直读是**最大的一次请求**（输入可达 19.2 万字、输出预算 6.5 万 token），
    // 但原先全程零反馈 —— 只有一句 2.5 秒 toast，之后界面毫无动静（setBusy 仅禁用按钮）。
    // 用户很容易以为卡死而中途强关，表现成"大纲生成不了"；而分块兜底路径反倒有浮层（反馈倒挂）。
    // 另：浮层是 fixed/inset:0/z-index:50，会完全遮住页面里的「⏹ 停止」，
    // 所以停止按钮必须做进浮层，否则"可随时点停止"是句假话。
    let release = null;
    const gate = new Promise((r) => { release = r; });
    await page.route("**/chat/completions", async (route) => {
      await gate; // 把请求挂在半空，好观察「生成期间」的 UI
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({
          chapters: [{ title: "整书第一章", lessons: [{ id: "l1", title: "课时一", focus: "f", keyPoints: ["k"] }] }],
          advice: "",
        }) }, finish_reason: "stop" }] }),
      });
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      localStorage.clear();
      const material = "第一章 绪论\n" + "正文内容。".repeat(50) + "\n";
      const book = {
        id: "bk_wb", title: "整书浮层课程", material, bookKey: "bkkey_wb", createdAt: "2026-09-12",
        outline: { chapters: [{ title: "占位", lessons: [{ id: "z0", title: "占位", focus: "x", keyPoints: ["k"] }] }], advice: "" },
      };
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: "http://127.0.0.1:8198/v1", apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", "bk_wb");
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("整书浮层课程");

    await page.click(".course-head");
    await page.click(".course-regen-outline");

    // 生成期间：浮层可见 + 不确定态 + 有耗时预期和停止出口
    await expect(page.locator("#outlineProgressOverlay"), "整书直读也应有进度浮层").not.toHaveClass(/hidden/);
    await expect(page.locator(".outline-progress-track"), "单步请求应走不确定态，而非永远停在 0%").toHaveClass(/indeterminate/);
    const detail = await page.locator("#outlineProgressDetail").textContent();
    expect(detail, "应说明资料体量").toContain("万字");
    expect(detail, "应给出耗时预期").toContain("分钟");
    expect(detail, "应指向浮层内的停止按钮").toContain("停止生成");
    await expect(page.locator("#outlineProgressStop"), "浮层内的停止按钮必须可见可点").toBeVisible();

    // 「已等待」计时器真的在走（照 config.thinkingPhrases 的思路：数字在动 = 界面没冻结）
    await expect.poll(() => page.locator("#outlineProgressDetail").textContent(), { timeout: 8000 })
      .toContain("已等待");

    release();
    await expect(page.locator(".course-regen-outline")).toBeEnabled({ timeout: 30000 });
    await expect(page.locator("#outlineProgressOverlay"), "生成结束后浮层应收起").toHaveClass(/hidden/);
  });

  test("Q. 片段解析失败时：补一次重试、记为「大纲不完整」并持久提示，而非静默丢章节（B9）", async ({ page }) => {
    // 背景：旧实现里分块循环只对**抛异常**计数（catch 里 failed++），而
    // 「模型返回了、但解析不出课时」既不计数也不留痕迹 —— 那一段书从大纲里静默消失，
    // 大纲却看起来完全正常，用户永远不会去补，那几章也永远教不到。
    // 这条把三件事一起锁住：① 解析失败要补一次重试；② 仍失败要计数；③ 必须**持久**告知。
    const chunkCalls = []; // 记录每个片段被请求的次数（从 user 提示的「第 N/M 段」取）
    await page.route("**/chat/completions", async (route) => {
      let body = "{}";
      try { body = route.request().postData() || "{}"; } catch { /* 忽略 */ }
      const j = JSON.parse(body);
      const user = (j.messages[j.messages.length - 1] || {}).content || "";
      const m = user.match(/全书第 (\d+)\/(\d+) 段/);
      let content;
      if (m) {
        const idx = Number(m[1]);
        chunkCalls.push(idx);
        content = (idx === 3)
          // 第 3 段始终返回非 JSON（模拟模型格式抖动）→ 走「解析失败」这条核心路径
          ? "抱歉，我需要更多信息才能继续。"
          : JSON.stringify({
            chapterTitle: "第" + idx + "章",
            lessons: [{ id: "L" + idx, title: "课时" + idx, focus: "f", keyPoints: ["k"] }],
          });
      } else {
        content = JSON.stringify({ advice: "整体节奏不错" }); // 末尾的全局建议增强
      }
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }),
      });
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(({ bookId, bookKey }) => {
      localStorage.clear();
      const filler = "内容内容内容";
      const fill = (n) => { let s = ""; while (s.length < n) s += filler; return s.slice(0, n); };
      let material = "";
      for (let i = 1; i <= 2; i++) material += "第" + i + "章 章节标题" + i + "\n" + fill(199000) + "\n\n";
      const book = {
        id: bookId, title: "B9 部分失败课程", material, bookKey, createdAt: "2026-09-12",
        outline: { chapters: [{ title: "占位章", lessons: [{ id: "z0", title: "占位", focus: "x", keyPoints: ["k"] }] }], advice: "" },
      };
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: "http://127.0.0.1:8198/v1", apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", bookId);
    }, { bookId: "bk_b9", bookKey: "bkkey_b9" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("B9 部分失败课程");

    await page.click(".course-head");
    await page.click(".course-regen-outline");
    await expect(page.locator(".course-regen-outline")).toBeEnabled({ timeout: 150000 });

    // ① 解析失败必须补一次重试（callAPIRetry 只在抛异常时重试，解析失败得我们自己补）
    expect(chunkCalls.filter((n) => n === 3).length, "解析失败的片段应被重试一次（共 2 次请求）").toBe(2);

    // ② + ③ 持久提示：课程卡上写明大纲不完整，且给出修复入口
    const warn = page.locator("#bookList .course-warn");
    await expect(warn, "课程卡上必须持久显示「大纲不完整」").toBeVisible();
    await expect(warn).toContainText("大纲不完整");
    await expect(warn).toContainText("未提取成功");
    await expect(warn).toContainText("重生成大纲");

    // 当场也要告知（toast 文案在 DOM 里留存，不依赖时序）
    await expect(page.locator("#socratopiaToast")).toContainText("未提取成功");

    // 成功的片段仍要产出可用大纲 —— 一段失败不该整体丢弃（旧行为也是保留，别改坏）
    expect(await page.locator(".cc-ch-title").count(), "成功片段仍应产出章节").toBeGreaterThan(0);
  });

  test("R. 「⏹ 停止生成」真的停：不重试、不续下一段、不产出半成品大纲（B10）", async ({ page }) => {
    // 背景：callAPIRetry 旧实现不看错误类型，把用户点停止产生的 AbortError 也当"失败"重试
    // → 停下来之后反而**又发一个新请求**；分块循环还会继续下一段，用户得点 N 次才真停。
    // 且 generateOutline() 自己吞异常正常返回，调用点紧接着报"大纲已重新生成"——
    // 用户明明点了停止，却被通知"已生成"。这条把三件事一起锁住。
    const chunkReqs = [];
    await page.route("**/chat/completions", async (route) => {
      let body = "{}";
      try { body = route.request().postData() || "{}"; } catch { /* 忽略 */ }
      const user = (JSON.parse(body).messages || []).slice(-1)[0]?.content || "";
      if (/全书第 (\d+)\//.test(user)) {
        chunkReqs.push(user.match(/全书第 (\d+)/)[1]);
        // 把请求挂在半空：模拟"正在研读"的长时间请求，等用户点停止
        await new Promise((r) => setTimeout(r, 10000));
      }
      try {
        await route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }] }),
        });
      } catch (e) { /* 请求已被 abort，fulfill 会失败；这正是被测行为 */ }
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(({ bookId, bookKey }) => {
      localStorage.clear();
      const filler = "内容内容内容";
      const fill = (n) => { let s = ""; while (s.length < n) s += filler; return s.slice(0, n); };
      let material = "";
      for (let i = 1; i <= 2; i++) material += "第" + i + "章 章节标题" + i + "\n" + fill(199000) + "\n\n";
      const book = {
        id: bookId, title: "B10 停止测试课程", material, bookKey, createdAt: "2026-09-12",
        outline: { chapters: [{ title: "占位章", lessons: [{ id: "z0", title: "占位", focus: "x", keyPoints: ["k"] }] }], advice: "" },
      };
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: "http://127.0.0.1:8198/v1", apiKey: "test", model: "mock", temperature: 0.7, role: "sanbingqi" }));
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", bookId);
    }, { bookId: "bk_b10", bookKey: "bkkey_b10" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("B10 停止测试课程");

    await page.click(".course-head");
    await page.click(".course-regen-outline");
    await expect(page.locator("#outlineProgressOverlay")).not.toHaveClass(/hidden/);
    // 等第 1 段的请求真的发出去，再点停止
    await expect.poll(() => chunkReqs.length, { timeout: 15000 }).toBe(1);

    await page.click("#outlineProgressStop");

    // 浮层收起 + 如实说"已停止"（不是"重试中"，更不是"已重新生成"）
    await expect(page.locator("#outlineProgressOverlay"), "停止后浮层应收起").toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator("#socratopiaToast")).toContainText("已停止生成");

    // 必须等过重试延迟（1.5s）再数请求 —— 我们要断言的是"那个**不该发生**的延迟重试没发生"，
    // 立即断言会因重试还没到点而假通过。
    await page.waitForTimeout(2500);
    expect(chunkReqs.length, "停止后不得重试、也不得续发下一段（只应有 1 个请求）").toBe(1);
    expect(await page.locator("#socratopiaToast").textContent(), "不得出现「重试中」").not.toContain("重试中");

    // 不得产出半成品大纲：旧大纲原样保留，且没有「大纲不完整」标记
    await expect(page.locator("#bookList .course-warn"), "取消不应产出残缺大纲").toHaveCount(0);
    expect(await page.locator(".cc-ch-title").textContent(), "旧大纲应原样保留").toContain("占位章");
  });
});
