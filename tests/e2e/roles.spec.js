const { test, expect } = require("@playwright/test");

// 自定义角色（客户自行定制角色）端到端测试
// 覆盖：
//  1) 新建角色：填表 → 出现在角色下拉 → 选中 → 持久化到 localStorage → 编辑/删除按钮启用
//  2) 编辑角色：预填原值 → 改人设 → 保存 → 持久化
//  3) 删除角色：确认 → 从下拉与 localStorage 移除，选中回落到内置角色
//  4) 自定义角色的人设进入「课时开始」系统提示词（mock API，无需真实 Key）

test.describe.configure({ timeout: 60000 });

const API_BASE = "http://127.0.0.1:8198/v1";

test.beforeEach(async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#bookList")).toContainText("我的第一门课程");
});

const CUSTOM_ROLE = {
  name: "白泽老师",
  series: "原创",
  userAlias: "同学",
  openingLine: "同学，今天想琢磨点什么？",
  persona: "你是一位温厚的白泽老师，爱用生活比喻，从不说教，耐心引导学生自己推出来。",
  voice: "语气温和沉稳，多用「咱们一起看看」这类句式。",
  thinkingPhrases: ["让我想想…", "稍等一下…"],
};

// 人设/语气/开场白/口头禅四个输入框是 readonly，只能由「✨ AI 自动补全」回填
// （index.html 里 placeholder 即「点上方按钮生成」）。因此新建/编辑角色要走 mock
// 的自动补全链路，不能直接 fill。这里把该链路抽成公共步骤。
async function mockRoleGen(page, fields) {
  await page.route("**/chat/completions", async (route) => {
    let body = "{}";
    try { body = route.request().postData() || "{}"; } catch {}
    const sys = JSON.parse(body).messages.find((m) => m.role === "system")?.content || "";
    const content = sys.includes("设定师") ? JSON.stringify(fields) : "（通用回复）";
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }) });
  });
}

// 20260915：设置面板改为「浮层 + 左侧标签导航」后，角色相关控件不再一打开就可见，
// 而落在「角色」页签里（弹窗默认停在「API 连接」页）。这里把"打开设置 → 填 Key → 切到角色页"
// 抽成公共步骤 —— 它同时也是对页签导航的一层覆盖（点不动就说明导航坏了）。
async function openSettingsRolePane(page, apiKey) {
  await page.click("#toggleSettings");
  if (apiKey !== undefined) await page.fill("#apiKey", apiKey);
  await page.click('.settings-nav-item[data-pane="role"]');
}

test.describe("自定义角色 · 增删改", () => {
  test("新建角色：出现在下拉并持久化，编辑/删除按钮启用", async ({ page }) => {
    // 自动补全需要 API Key，且人设等字段为 readonly（只能由自动补全回填）
    await mockRoleGen(page, {
      persona: CUSTOM_ROLE.persona,
      voice: CUSTOM_ROLE.voice,
      openingLine: CUSTOM_ROLE.openingLine,
      userAlias: CUSTOM_ROLE.userAlias,
      thinkingPhrases: CUSTOM_ROLE.thinkingPhrases,
    });
    await openSettingsRolePane(page, "test-key");
    await page.click("#roleNew");
    await expect(page.locator("#roleEditModal")).not.toHaveClass(/hidden/);
    await expect(page.locator("#roleEditTitle")).toContainText("新建角色");

    await page.fill("#roleEditName", CUSTOM_ROLE.name);
    await page.fill("#roleEditSeries", CUSTOM_ROLE.series);
    await page.click("#roleGenToggle"); // 生成细节区默认收起，先展开才能点自动补全
    await page.click("#roleAutoFill");
    await expect(page.locator("#roleEditPersona")).toHaveValue(/白泽/, { timeout: 10000 });
    await page.click("#roleEditSave");

    await expect(page.locator("#roleEditModal")).toHaveClass(/hidden/);
    // 选中刚保存的角色
    await expect(page.locator("#roleSelect")).toHaveValue(CUSTOM_ROLE.name);
    const opts = await page.locator("#roleSelect option").allTextContents();
    expect(opts.some((t) => t.includes(CUSTOM_ROLE.name))).toBe(true);
    // 持久化
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("socratopia_custom_roles_v0") || "[]"));
    expect(stored.length).toBe(1);
    expect(stored[0].name).toBe(CUSTOM_ROLE.name);
    expect(stored[0].persona).toContain("白泽");
    expect(Array.isArray(stored[0].thinkingPhrases)).toBe(true);
    expect(stored[0].thinkingPhrases.length).toBe(2);
    // 编辑/删除按钮已启用（当前选中自定义角色）
    await expect(page.locator("#roleEdit")).toBeEnabled();
    await expect(page.locator("#roleDel")).toBeEnabled();
  });

  test("编辑角色：预填原值、改人设并持久化", async ({ page }) => {
    await page.evaluate((role) => {
      localStorage.setItem("socratopia_custom_roles_v0", JSON.stringify([role]));
    }, CUSTOM_ROLE);
    await page.reload({ waitUntil: "domcontentloaded" });
    // 人设为 readonly，改用自动补全改人设（mock 返回新内容）
    await mockRoleGen(page, {
      persona: "新人设：更活泼一些，多用口诀。",
      voice: CUSTOM_ROLE.voice,
      openingLine: CUSTOM_ROLE.openingLine,
      userAlias: CUSTOM_ROLE.userAlias,
      thinkingPhrases: CUSTOM_ROLE.thinkingPhrases,
    });
    await openSettingsRolePane(page, "test-key");
    await page.selectOption("#roleSelect", CUSTOM_ROLE.name);
    await page.click("#roleEdit");
    await expect(page.locator("#roleEditModal")).not.toHaveClass(/hidden/);
    await expect(page.locator("#roleEditName")).toHaveValue(CUSTOM_ROLE.name);
    await expect(page.locator("#roleEditPersona")).toHaveValue(CUSTOM_ROLE.persona); // 预填原值

    await page.click("#roleGenToggle"); // 生成细节区默认收起，先展开才能点自动补全
    await page.click("#roleAutoFill");
    await expect(page.locator("#roleEditPersona")).toHaveValue(/新人设/, { timeout: 10000 });
    await page.click("#roleEditSave");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("socratopia_custom_roles_v0") || "[]"));
    expect(stored.length).toBe(1);
    expect(stored[0].persona).toBe("新人设：更活泼一些，多用口诀。");
  });

  test("删除角色：从下拉与存储移除，选中回落到内置角色", async ({ page }) => {
    await page.evaluate(({ role, base }) => {
      localStorage.setItem("socratopia_custom_roles_v0", JSON.stringify([role]));
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: base, apiKey: "test", model: "mock", temperature: 0.7, role: role.name }));
    }, { role: CUSTOM_ROLE, base: API_BASE });
    await page.reload({ waitUntil: "domcontentloaded" });
    await openSettingsRolePane(page);
    await expect(page.locator("#roleSelect")).toHaveValue(CUSTOM_ROLE.name);

    page.on("dialog", (d) => d.accept()); // 确认删除弹窗
    await page.click("#roleDel");

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("socratopia_custom_roles_v0") || "[]"));
    expect(stored.length).toBe(0);
    const opts = await page.locator("#roleSelect option").allTextContents();
    expect(opts.some((t) => t.includes(CUSTOM_ROLE.name))).toBe(false);
    await expect(page.locator("#roleSelect")).not.toHaveValue(CUSTOM_ROLE.name);
  });
});

test.describe("自定义角色 · 人设进入提示词（mock API）", () => {
  test("自定义角色的 persona 出现在「课时开始」系统提示词", async ({ page }) => {
    const captured = [];
    await page.route("**/chat/completions", async (route) => {
      let body = "{}";
      try { body = route.request().postData() || "{}"; } catch {}
      const j = JSON.parse(body);
      const sys = (j.messages || []).find((m) => m.role === "system")?.content || "";
      if (sys.includes("你即将开始教授")) captured.push(sys); // lessonStartRules 特征句
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "好的，我们开始。" } }] }),
      });
    });

    await page.evaluate(({ role, base }) => {
      localStorage.clear();
      const book = {
        id: "bk_role", title: "角色课程", material: "测试材料，讲变量作用域。", bookKey: "bkkey_role", createdAt: "2026-08-14",
        outline: { chapters: [{ title: "第一章", lessons: [{ id: "ls1", title: "变量作用域", focus: "作用域", keyPoints: ["变量作用域"], materialHint: "第一段" }] }], advice: "加油" },
      };
      localStorage.setItem("socratopia_settings_v0", JSON.stringify({ baseUrl: base, apiKey: "test", model: "mock", temperature: 0.7, role: role.name }));
      localStorage.setItem("socratopia_custom_roles_v0", JSON.stringify([role]));
      localStorage.setItem("socratopia_library_v0", JSON.stringify([book]));
      localStorage.setItem("socratopia_current_book_v0", book.id);
    }, { role: CUSTOM_ROLE, base: API_BASE });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#bookList")).toContainText("角色课程");

    await page.click(".course-head");
    await page.click('.cc-ch-title[data-chidx="0"]');
    await page.click('.cc-lesson[data-lid="ls1"]');
    await page.click("#startLessonBtn");

    await expect.poll(() => captured.length, { timeout: 10000 }).toBeGreaterThan(0);
    expect(captured[0]).toContain("温厚的白泽老师"); // persona 进入提示词
    expect(captured[0]).toContain("咱们一起看看");     // voice（语气表达）也进入提示词
  });
});

test.describe("自定义角色 · 自动补全（mock API）", () => {
  test("自动补全人设与语气：回填表单 → 保存后 persona/voice 持久化", async ({ page }) => {
    let autoFillBody = null; // B7：捕获「角色补全」请求体，校验它带足了输出预算
    await page.route("**/chat/completions", async (route) => {
      let body = "{}";
      try { body = route.request().postData() || "{}"; } catch {}
      const sys = JSON.parse(body).messages.find((m) => m.role === "system")?.content || "";
      if (sys.includes("设定师")) autoFillBody = body;
      const content = sys.includes("设定师")
        ? JSON.stringify({
            persona: "李白，字太白，唐代诗人。",
            voice: "豪放洒脱，爱用「君不见」句式。",
            openingLine: "同学，且随我一起看这诗中的天地。",
            userAlias: "同学",
            thinkingPhrases: ["让我沉吟片刻…", "且待我斟酌…"],
          })
        : "（通用回复）";
      await route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }) });
    });

    await openSettingsRolePane(page, "test-key"); // 自动补全需要 API Key
    await page.click("#roleNew");
    await page.fill("#roleEditName", "李白");
    await page.fill("#roleEditSeries", "唐诗三百首"); // 作品出处为必填，缺它 autoFillRole 会在发请求前 return
    await page.click("#roleGenToggle"); // 生成细节区默认收起，先展开才能点自动补全
    await page.click("#roleAutoFill");

    // 模型返回的 JSON 回填到各输入框
    await expect(page.locator("#roleEditPersona")).toHaveValue(/唐代诗人/, { timeout: 10000 });
    // B7（2026-09-10）：结构化 JSON 调用必须显式带足 max_tokens，不得落 provider 默认 4096
    // （config 里算了预算 ≠ 调用点传了 —— B1 大纲截断正是栽在"两条路径都没传"上）
    expect(autoFillBody, "角色补全请求已发出").toBeTruthy();
    expect(JSON.parse(autoFillBody).max_tokens).toBeGreaterThan(4096);
    await expect(page.locator("#roleEditVoice")).toHaveValue(/豪放洒脱/);
    await expect(page.locator("#roleEditOpening")).toHaveValue(/诗中的天地/);
    await expect(page.locator("#roleEditThinking")).toHaveValue(/沉吟片刻/);

    await page.click("#roleEditSave");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("socratopia_custom_roles_v0") || "[]"));
    expect(stored.length).toBe(1);
    expect(stored[0].name).toBe("李白");
    expect(stored[0].persona).toContain("唐代诗人");
    expect(stored[0].voice).toContain("豪放洒脱");
  });
});
