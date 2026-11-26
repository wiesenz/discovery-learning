/* =====================================================================
 *  Socratopia v0 · 源码残留检查（node js/source-hygiene.test.mjs）
 *  ---------------------------------------------------------------------
 *  作用：给「已下线功能」上一把防回流锁。
 *
 *  为什么需要它：删掉一个 UI 控件往往要同时清理四处 ——
 *  index.html 里的元素、js/dom.js 的 els 映射、app.js 的事件绑定、styles.css 的规则。
 *  漏掉任何一处，单测都不会报错（它们不加载真实 DOM），但运行时会出事：
 *   · 留着 app.js 的 `els.xxx.addEventListener` 却没有对应 HTML → TypeError，整个应用起不来；
 *   · 留着 styles.css 的规则却没有对应 DOM → 静默失效，平时根本发现不了。
 *  这类「单测抓不到、只有运行时才炸（或静默无效）」的残留，只能靠源码扫描兜底。
 *
 *  同类先例：js/role-editor.test.mjs 里对 roleEditType / ROLE_TYPE_OPTIONS 的扫描
 *  （「类型」下拉下线）。新增下线项时，往 CASES 里加一条即可。
 * ===================================================================== */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const countOf = (s, token) => s.split(token).length - 1;

console.log("已下线标识符不得回流");

const CASES = [
  {
    token: "toggleSidebar",
    what: "「☰ 侧栏」按钮（20260914 下线：只把左栏藏起来，无实质教学增益）",
    files: ["index.html", "js/dom.js", "app.js", "styles.css"],
  },
  {
    token: "sidebar-collapsed",
    what: "整栏折叠的样式钩子（20260914 随按钮一并下线）",
    files: ["index.html", "js/dom.js", "app.js", "styles.css"],
  },
  {
    token: "roleEditType",
    what: "角色弹窗的「类型」下拉（20260914 下线）",
    files: ["index.html", "js/dom.js", "app.js", "js/roles.js"],
  },
];

for (const c of CASES) {
  for (const f of c.files) {
    const n = countOf(read(f), c.token);
    ok(f + " 不含 " + c.token + " —— " + c.what, n === 0);
  }
}

// 反向保护：下线「整栏折叠」时不能连带删掉「区块折叠」——后者是有实际用处的
console.log("\n区块级折叠必须仍在（下线整栏折叠时别误伤）");
{
  const html = read("index.html");
  const css = read("styles.css");
  ok("index.html 保留课程区抬头 #courseTopbar", html.includes('id="courseTopbar"'));
  ok("index.html 保留「全部折叠/展开」#courseExpandAll", html.includes('id="courseExpandAll"'));
  ok("styles.css 保留课程区折叠规则", css.includes(".course-library.collapsed"));
  ok("styles.css 保留「踏石留印」折叠规则", css.includes(".memory-panel.collapsed"));
  ok("styles.css 保留「我的收藏」折叠规则", css.includes(".collection-panel.collapsed"));

  // 20260915 修的三个折叠缺陷，逐条留痕 —— 否则下次「顺手简化」又会退回去。
  const app = read("app.js");
  const domjs = read("js/dom.js");
  ok("折叠态有 localStorage 键（LS.folded）", domjs.includes("socratopia_folded_v0"));
  ok("app.js 落盘折叠态（刷新不再全部还原）", app.includes("localStorage.setItem(LS.folded"));
  ok("app.js 启动时还原折叠态", app.includes("applyFolds();"));
  ok("styles.css 折叠后抬头瘦身：隐藏副标题",
    /\.memory-panel\.collapsed \.sh-sub/.test(css) && /\.collection-panel\.collapsed \.sh-sub/.test(css));
  ok("styles.css 折叠后抬头瘦身：印章缩小",
    /\.memory-panel\.collapsed \.seal-mini/.test(css));
  ok("styles.css 折叠课程区时连空状态提示一并收起",
    /\.course-library\.collapsed \.mem-empty/.test(css));
}

// 空状态提示原先写 style.display —— 内联样式优先级高于任何类选择器，
// 会把「区块折叠」的 display:none 压掉，折起来后提示还杵在那里。改走 .hidden 类。
console.log("\n空状态提示不得使用内联 display（会压过折叠规则）");
{
  const app = read("app.js");
  for (const t of ["memoryEmpty.style.display", "collectionEmpty.style.display", "bookEmpty.style.display"]) {
    ok("app.js 不含 " + t, countOf(app, t) === 0);
  }
  ok("app.js 空状态改走 .hidden 类", app.includes('memoryEmpty.classList.toggle("hidden"'));
  ok("app.js 收藏空状态改走 .hidden 类", app.includes('collectionEmpty.classList.toggle("hidden"'));
  ok("app.js 课程空状态改走 .hidden 类", app.includes('bookEmpty.classList.toggle("hidden"'));
}

// 浅色硬编码表面：暗色主题下会变成白块，而其文字色是 var(--ink2)（浅色）→ 浅底浅字不可读。
// 20260915 实测 .mem-item / .col-card-body / 非当前 .course-card 三处中招，已全部收敛到变量。
console.log("\n浅色硬编码表面必须走变量（否则暗色主题出白块）");
{
  const css = read("styles.css");
  for (const c of ["background: #fffdf7", "background: #fff;"]) {
    const n = countOf(css, c);
    ok("styles.css 无字面量 " + JSON.stringify(c) + (n ? "（命中 " + n + " 处）" : ""), n === 0);
  }
  // 20261126：原先断言写死旧国风色值（#fffdf7 等），条纹主题换掉调色板后必红。
  // 改断言「浅色 :root 里这三个表面 token 都有合法色值」—— 这才是本组真正要守的东西
  // （有 token 可覆盖，才不会出现硬编码白块），色值本身属于设计决策，不该由测试钉死。
  const lightRoot = (css.match(/:root\s*\{[\s\S]*?\}/) || [""])[0];
  const hasHex = (name) => new RegExp("--" + name + ":\\s*#[0-9a-fA-F]{3,6}").test(lightRoot);
  ok("浅色 :root 定义了 --card / --card2 / --card-focus",
    hasHex("card") && hasHex("card2") && hasHex("card-focus"));
  ok("暗色主题覆盖了这三个表面变量",
    css.includes("--card: #26262b") && css.includes("--card2: #2a2a30") && css.includes("--card-focus: #303038"));
}

// 暗色的"强调红"必须比亮色更亮，不能照抄亮色那支"更深的红"。
// 亮色 --cinnabar-d 是深红（当文字色压浅底，正确）；暗色若沿用同一支深红，
// 14 处小字全部只有 ~3.1:1，不达 WCAG AA 4.5:1（实测「待复习」徽标 3.08:1）。
console.log("\n暗色主题的红色强调文字必须够亮（小字对比度 ≥ 4.5）");
{
  const css = read("styles.css");
  ok("暗色 --cinnabar-d 已提亮为 #ff8a76", css.includes("--cinnabar-d: #ff8a76"));
  ok("不再残留深红 --cinnabar-d: #c14a36", countOf(css, "--cinnabar-d: #c14a36") === 0);
}

// 顶栏是「主题无关的墨色面」：亮色走 --ink #17171b、暗色硬编码 #141417，两主题下都是深底。
// 所以它的前景色不能绑会翻转的变量 —— --paper 在暗色下会变成页面深底 #1b1b1f。
// 20260916 实测：`.topbar .ghost-btn { color: var(--paper) }` 在暗色下是「深字压深底」，
// 对比度 1.07:1（WCAG AA 要 4.5），三个按钮的字肉眼不可见；
// 只有 emoji 图标是彩色字形、不吃 color，所以现象是「图标在、字没了」。
// 放宽到 #f4efe3 字面量后实测 16.02:1。同上，这条也只能靠源码扫描兜底。
console.log("\n顶栏按钮前景色不得绑随主题翻转的变量（暗色实测 1.07:1）");
{
  const css = read("styles.css");
  // 20261126：改为对「所有 .topbar .ghost-btn 规则」取整体判断，而不是钉死 #f4efe3。
  // 换肤后该按钮在浅色下是深字（#151515 压在浅底上）、暗色下有独立覆盖，两种都合法；
  // 真正要防的仍是那条历史 bug：前景色绑到会随主题翻转的 --paper 上（暗色下变成深字压深底）。
  const rules = css.match(/\.topbar \.ghost-btn[^{]*\{[^}]*\}/g) || [];
  ok("styles.css 存在 .topbar .ghost-btn 规则", rules.length > 0);
  ok("该规则不再写 color: var(--paper)", !rules.some((r) => /color:\s*var\(--paper\)/.test(r)));
  ok("该规则前景为字面色值而非随主题翻转的变量",
    rules.some((r) => /color:\s*#[0-9a-fA-F]{3,6}/.test(r)));
}

// 啊哈时刻已于 20260915 下线：反向保护 —— 任何残留都会让「删干净了」变成假象。
// 注意：这里对 token 取「零出现」口径（含注释）。所以源码里解释下线原因时，
// 不要写出这些标识符本身（用「啊哈时刻」这类中文说法即可），否则本组会红。
console.log("\n啊哈时刻必须已彻底下线（防半删回流）");
{
  const AHA_TOKENS = [
    "ahaList", "ahaEmpty", "ahaModal", "ahaLabel", "ahaSave", "ahaCancel", "closeAha",
    "renderAhaPanel", "loadAhas", "saveAhas", "hasAhasForLesson", "jumpToAha",
    "openAhaModal", "closeAhaModal", "pendingAha", "scrollToMsg", "gotoMessage",
    "aha-panel", "aha-item", "aha-group-title", "aha-del", "aha-flash",
  ];
  const FILES = ["index.html", "app.js", "js/dom.js", "js/store.js", "styles.css"];
  for (const f of FILES) {
    const text = read(f);
    for (const t of AHA_TOKENS) {
      const n = countOf(text, t);
      if (n) ok(f + " 无残留 " + t + "（命中 " + n + " 处）", false);
    }
  }
  ok("五个文件全部无啊哈残留标识符", AHA_TOKENS.every(
    (t) => FILES.every((f) => countOf(read(f), t) === 0)
  ));
  // 关键不可误伤项：删啊哈时最容易顺手删掉的两个「间接依赖」
  ok("app.js 仍保留 hashStr（「☆ 收入卷宗」用它生成稳定 id）", read("app.js").includes("function hashStr"));
  ok("app.js 删除教材时仍清理 aha 历史键", read("app.js").includes('"aha"'));
  ok("app.js 下课仍会重置为报告卡（对话不被误留）", read("app.js").includes("messages = report;"));
}

// 左栏是主干：保留的三块内容挂载点一个都不能少（啊哈时刻已下线，不在其列）
console.log("\n左栏主干挂载点必须仍在");
{
  const html = read("index.html");
  for (const [id, name] of [
    ["bookList", "课程列表"], ["addBook", "上传新课程入口"], ["bookSearch", "课程搜索"],
    ["memoryList", "踏石留印"], ["collectionList", "我的收藏"],
  ]) {
    ok("index.html 保留 " + name + "（#" + id + "）", html.includes('id="' + id + '"'));
  }
}

// ---------------------------------------------------------------------
// 设置弹窗 / 画像弹窗的结构契约（20260915）
// 背景：设置原先是「插在 topbar 与主界面之间、把主界面往下推」的内嵌面板，
// 画像则是它内部最长的一块。本次把设置改成浮层 + 左侧标签导航，画像迁出独立成窗。
// 这四类约束**单测与 e2e 都只能覆盖一部分**，静态扫描是性价比最高的兜底：
//   ① 内嵌面板不得回流（改回去的话，观感问题会原样复活，而功能测试全绿）
//   ② 导航项与内容页必须一一对应（新增页签时漏配 data-pane → 点了没反应，不报错）
//   ③ 画像必须已迁出设置面板且只存在一份（两处都有容器 → 渲染到哪一份都说不清）
//   ④ DOM 层序：设置/画像必须排在 #roleEditModal 之前 —— 同为 z-index:50 时
//      「后出现的盖住先出现的」，顺序一错，「新建角色」就会被设置弹窗压住点不动
// ---------------------------------------------------------------------
console.log("\n设置弹窗 / 画像弹窗的结构契约（20260915）");
{
  const html = read("index.html");
  const css = read("styles.css");
  const appJs = read("app.js");
  const profileJs = read("js/profile-ui.js");

  // ① 内嵌面板不得回流
  ok("index.html 中 #settingsPanel 是浮层（overlay）", /id="settingsPanel" class="overlay hidden"/.test(html));
  ok("index.html 不再有内嵌面板容器（.panel / .panel-grid）",
    !html.includes('class="panel hidden"') && !html.includes("panel-grid"));
  ok("styles.css 已移除内嵌面板与旧折叠分组样式",
    !css.includes(".panel {") && !css.includes(".settings-group"));

  // ② 导航项 ↔ 内容页一一对应（含顺序）
  const navPanes = [...html.matchAll(/class="settings-nav-item[^"]*"\s+data-pane="([^"]+)"/g)].map((m) => m[1]);
  const contentPanes = [...html.matchAll(/class="settings-pane[^"]*"\s+data-pane="([^"]+)"/g)].map((m) => m[1]);
  ok("左侧导航项与内容页一一对应（" + navPanes.join(" / ") + "）",
    navPanes.length > 0 && navPanes.join(",") === contentPanes.join(","));
  ok("app.js 绑定了页签切换逻辑", appJs.includes("settingsNavItems") && appJs.includes("settingsPanes"));

  // ③ 关闭入口：按钮 + JS 绑定（与其它浮层同一套约定）
  ok("index.html 有设置弹窗关闭按钮 #closeSettings", html.includes('id="closeSettings"'));
  ok("app.js 绑定了设置弹窗关闭按钮与点遮罩关闭",
    appJs.includes("els.closeSettings.addEventListener") && appJs.includes("e.target === els.settingsPanel"));
  ok("index.html 有画像弹窗与关闭按钮 #profileModal / #closeProfile",
    html.includes('id="profileModal"') && html.includes('id="closeProfile"'));
  ok("js/profile-ui.js 绑定了画像弹窗的关闭按钮与点遮罩关闭",
    profileJs.includes("closeProfileBtn") && profileJs.includes("closeProfilePanel"));
  ok("画像模块已不再依赖宿主 els（deps 里不传 els）", !/createProfileUI\(\{[\s\S]{0,120}?els:/.test(appJs));

  // ④ 画像已迁出设置面板，且全站只有一份容器
  const iSettings = html.indexOf('id="settingsPanel"');
  const iProfile = html.indexOf('id="profileModal"');
  const iRoleEdit = html.indexOf('id="roleEditModal"');
  ok("画像容器 #profileGroups 全站唯一", countOf(html, 'id="profileGroups"') === 1);
  const settingsSeg = iSettings >= 0 && iProfile > iSettings ? html.slice(iSettings, iProfile) : html;
  ok("设置面板内不再残留画像块",
    !settingsSeg.includes("profileGroups") && !settingsSeg.includes("profileAddInput"));

  // ⑤ DOM 层序：z-index 同为 50 时以出现顺序定胜负
  ok("设置/画像弹窗排在 #roleEditModal 之前（否则「新建角色」会被压住）",
    iSettings > 0 && iProfile > iSettings && iRoleEdit > iProfile);
}

console.log("\n" + (fail === 0 ? "源码残留检查全部通过 ✓" : "源码残留检查失败 ✗")
  + " (" + pass + " 项)");
if (fail) process.exitCode = 1;
