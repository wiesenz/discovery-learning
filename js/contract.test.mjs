/* =====================================================================
 *  Socratopia v0 · 契约测试（UI 回归安全网）
 *  目的：拦截"改了 HTML 结构 / 膨胀失控"两类最常见回归。
 *  运行：npm test 自动串联（无第三方框架，纯 Node 断言）。
 * ===================================================================== */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

let failed = 0;
const fail = (msg) => { failed++; console.error("  ✗ " + msg); };
const ok = (msg) => console.log("  ✓ " + msg);

// ---------------------------------------------------------------------
// 1) ID 契约：app.js 里 $("x") / getElementById("x") 引用的 id，
//    必须在 index.html 或 app.js 模板字符串里真实定义过（id="x"）。
//    删/改了某个元素却忘了同步 JS，这里立刻报警。
// ---------------------------------------------------------------------
console.log("[1] ID 契约（HTML 结构 ↔ JS 引用）");

const appJs = readFileSync(join(root, "app.js"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");

// 20260903：原本只扫 app.js。代码分批迁到 js/*.js 后，若仍只扫 app.js，
// 新模块里的 $("xxx") 引用会脱离这张安全网——拆分反而制造了盲区。
// 现在把 js/ 下的模块（core.js 是 classic script，同样要扫）一起纳入。
const jsDir = join(root, "js");
const moduleFiles = readdirSync(jsDir)
  .filter((f) => f.endsWith(".js"))
  .sort();
const modulesJs = moduleFiles.map((f) => readFileSync(join(jsDir, f), "utf8")).join("\n");
const allJs = appJs + "\n" + modulesJs;

// 去掉注释后再扫描。
// 20260913 修：本组此前直接扫原文，于是【注释里写的示例】会被当成真实引用 ——
// js/dom.js 的头注释里举了个 $(...) 的例子做说明，本条护栏立刻报"引用了不存在的 id"。
// 组 [3]/[5]/[8] 早就用"切掉行内注释"回避了这类误判，本组漏了，属于同一把尺子只量了一半。
// 没有做完整词法分析：只在「// 之前的引号成对」时才认作注释（字符串里的 URL 如 "https://…"
// 引号数不成对，会整行保留），这样不会把字符串里的引用误删。
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").map((line) => {
    const i = line.indexOf("//");
    if (i < 0) return line;
    const before = line.slice(0, i);
    const quotes = (before.match(/["'`]/g) || []).length;
    return quotes % 2 === 0 ? before : line;
  }).join("\n");
}

// 引用的 id（来自 app.js + js/*.js 的 $() 与 getElementById）
const refRe = /\$\(\s*"([^"]+)"\s*\)|getElementById\(\s*"([^"]+)"\s*\)/g;
const referenced = new Set();
let m;
// JS 侧一律用"去注释"版本：引用（$()/getElementById）和定义（id="x"）都算。
// 定义侧也去注释是**收紧**：写在注释里的 id="foo" 不再算数，否则它会凭空替一个
// 真实缺失的 id 顶包。index.html 不剥（HTML 是结构事实本身，且里面 // 无关）。
const allJsClean = stripComments(allJs);
while ((m = refRe.exec(allJsClean)) !== null) {
  referenced.add(m[1] || m[2]);
}

// 定义的 id（index.html 静态 + app.js 模板里 id="x" + 动态 .id = "x" 赋值）
const defRe = /id="([^"]+)"/g;
const dynIdRe = /\.id\s*=\s*"([^"]+)"/g;
const defined = new Set();
while ((m = defRe.exec(html)) !== null) defined.add(m[1]);
while ((m = defRe.exec(allJsClean)) !== null) defined.add(m[1]);
while ((m = dynIdRe.exec(allJsClean)) !== null) defined.add(m[1]);

let missing = 0;
for (const id of referenced) {
  if (!defined.has(id)) { missing++; fail(`JS 引用了 id="${id}"，但前端代码里找不到定义`); }
}
if (missing === 0) {
  ok(`全部 ${referenced.size} 个 JS 引用 id 均有定义（app.js + js/ 共 ${moduleFiles.length} 个模块）`);
}

// ---------------------------------------------------------------------
// 2) 规模仪表盘（2026-09-13 由"行数绊网"降级为仪表盘：只打印，不判定）
//
// 为什么把原来那条"app.js 超过 4000 行即失败"的护栏删掉：
//   ① 单位错了。它数总行数，而本文件 18% 是注释（记的是 bug 史：B11、"同族只守一半"、
//      每处修复的日期与理由）。实测它报"只剩 6 行"时，实际代码还剩 807 行 ——
//      也就是说它是按 100% 的严格度去惩罚写解释。这是**唯一一条对文档收税的护栏**。
//   ② 职能已经被别人干了。真正让 app.js 变可读的是 js/store.js（把 61 个模块级变量里的
//      大部分收敛进单一 state）+ 插件工厂模式，不是行数。护栏 [3][4][5][7] 量的才是
//      "状态有没有散出去 / 插件边界有没有破 / 导入有没有漏"，那是会真坏的**性质**。
//   ③ 它可以被绕过：把代码搬进另一个文件就"达标"，什么都没改善 —— 一个能被搬运满足的
//      护栏提供的是虚假保证。
//   ④ 它会把决策引向指标本身。作者就为它算过一次行数预算（决定某段派生逻辑放哪儿时），
//      那次"该做"和"省行数"恰好重合，是运气。
//   → 结论（与本仓库 js/store.js "避免投机设计，需要时再加"同一条原则）：
//     此处只留观测，不留强制。哪天真出现"某个函数膨胀到读不动"，那时再针对**函数长度**
//     加一条（约 10 行）—— 按具体问题加，不按预感的数字加。
// ---------------------------------------------------------------------
console.log("[2] 规模仪表盘（只打印，不判定）");
{
  // 注释/空行剔除后才是真实规模；连注释一起数会得出误导性的结论
  let comment = 0, blank = 0, inBlock = false;
  for (const raw of appJs.split("\n")) {
    const t = raw.trim();
    if (t === "") { blank++; continue; }
    if (inBlock) { comment++; if (t.includes("*/")) inBlock = false; continue; }
    if (t.startsWith("/*")) { comment++; if (!t.includes("*/")) inBlock = true; continue; }
    if (t.startsWith("//")) { comment++; continue; }
  }
  const total = appJs.split("\n").length;
  const moduleLines = moduleFiles.reduce((n, f) => n + readFileSync(join(jsDir, f), "utf8").split("\n").length, 0);
  console.log(`  · app.js ${total} 行（注释 ${comment} / 空行 ${blank} / **实码 ${total - comment - blank}**）`);
  console.log(`  · js/ ${moduleFiles.length} 个模块共 ${moduleLines} 行`);
  console.log(`  · 合计 ${total + moduleLines} 行（不含 tests/ 与 roles/）`);
}

// ---------------------------------------------------------------------
// 3) 状态所有权绊网：20260904.1 把教材上下文/学习数据收敛进 js/store.js 后，
//    app.js 里这些名字只能通过 S.xxx 访问。一旦有人写回裸 currentBook，
//    就等于把刚收敛的状态又散出去——这里立刻报警。
//
//    （no-undef 已于 20260906 全局开启：vendor 全局（pdfjsLib / JSZip / SocratopiaCore）
//    已在 .eslintrc.json 的 globals 里声明，不会刷屏。这里保留针对这 8 个名字的精确检查，
//    因为它能拦住"裸名字恰好是某个全局"这类漏网之鱼。）
// ---------------------------------------------------------------------
console.log("[3] 状态所有权绊网（store 收敛护栏）");
const STORE_OWNED = ["currentBook", "currentLessonId", "selectedLessonId",
  "activeSessionBookId", "library", "memory", "collection"];
const QUOTES = "\"'`";
let strays = 0;
for (const line of appJs.split("\n")) {
  for (const name of STORE_OWNED) {
    const re = new RegExp("(?<![\\w$.])" + name + "(?![\\w$])", "g");
    let m;
    while ((m = re.exec(line)) !== null) {
      const prev = line[m.index - 1] || "";
      const next = line[m.index + name.length] || "";
      const before = line.slice(0, m.index);
      // 这些都不是"裸变量引用"，属于合法残留
      if (QUOTES.includes(prev) || QUOTES.includes(next)) continue; // 字符串字面量
      if (next === ":") continue;                                   // 对象属性名
      if (prev === "-") continue;                                   // kebab-case，如 .course-library
      if (before.includes("//")) continue;                          // 行内注释
      strays++;
      fail(`app.js 出现裸 \`${name}\`（应写 S.${name}）：${line.trim().slice(0, 90)}`);
    }
  }
}
if (strays === 0) ok(`app.js 无裸状态引用（已收敛的 ${STORE_OWNED.length} 个状态均经 S. 访问）`);

// ---------------------------------------------------------------------
// 4) 插件实例 API 用法绊网：20260906 拆出 js/roles.js 时真实踩到——
//    拆分前 ROLES 是普通对象，机械替换后变成工厂返回的函数（roles.getRegistry()），
//    但有几处写成了 roles.getRegistry[name]。函数取下标得到 undefined，不报错、
//    只是静默走 fallback 分支：群聊人设表直接抛 TypeError、保存的角色恢复不了。
//    e2e 只是碰巧覆盖到，单元测试层面必须有硬护栏。
// ---------------------------------------------------------------------
console.log("[4] 插件实例 API 用法绊网（函数不得当对象索引）");
const INSTANCES = ["roles", "group", "store", "quiz", "sourceViewer", "api"];
let misuse = 0;
for (const line of appJs.split("\n")) {
  const before = line.slice(0, line.indexOf("//") >= 0 ? line.indexOf("//") : line.length);
  const re = new RegExp("\\b(" + INSTANCES.join("|") + ")\\.(\\w+)\\s*\\[", "g");
  let mm;
  while ((mm = re.exec(before)) !== null) {
    misuse++;
    fail(`\`${mm[1]}.${mm[2]}[...]\`：${mm[2]} 是函数，须写成 ${mm[1]}.${mm[2]}()[...] → ${before.trim().slice(0, 90)}`);
  }
}
if (misuse === 0) ok(`宿主未把 ${INSTANCES.join(" / ")} 的方法当对象索引使用`);

// ---------------------------------------------------------------------
// 5) 域状态所有权绊网（插件闭包收敛护栏）
//    与 [3] 同理，但对象换成"插件闭包"——测验自己的状态（pendingQuiz /
//    quizDone / pendingQuizLessonId）已收敛进 createQuiz() 闭包，
//    app.js 里再出现裸名字，说明状态又被散了回去。
//    顺带挡住"把注释里的名字误当成实现"这类误判（行内注释已跳过）。
//    20260910：新增原文浮层（js/source-viewer.js），同一把尺子量——
//    查找态 / 高亮态 / 当前章序号必须在 createSourceViewer() 闭包内，
//    否则宿主又会与模块各持一份、互相覆盖。
//    20260912：新增接口传输层（js/api.js）—— 「当前请求的 AbortController」与
//    「上一次调用的 finish_reason」也必须收在 createApi() 闭包内：这两样一旦在宿主
//    留一份裸变量，就会出现「宿主中止的是 A、模块在跑 B」以及「读到上一次的 length
//    而误报截断」，正是 B7/B10 的复发路径。
// ---------------------------------------------------------------------
console.log("[5] 域状态所有权绊网（插件闭包收敛护栏）");
const OWNED_BY = [
  { mod: "js/quiz.js", names: ["pendingQuiz", "quizDone", "pendingQuizLessonId"] },
  { mod: "js/source-viewer.js", names: ["sourceFind", "sourceHighlight", "sourceViewCi"] },
  // 20260913：activeAbortController 更名为按槽位索引的 ctrlBySlot + inFlight（修 B4 的
  // "点 A 停 B"）。护栏本身必须跟着改名走 —— 否则它扫的是一个已不存在的名字，
  // 会静默退化成空转（"护栏还在，但什么都没守住"）。
  { mod: "js/api.js", names: ["ctrlBySlot", "inFlight", "lastFinishReason"] },
];
let quizStrays = 0;
for (const line of appJs.split("\n")) {
  const before = line.slice(0, line.indexOf("//") >= 0 ? line.indexOf("//") : line.length);
  for (const g of OWNED_BY) {
    for (const name of g.names) {
      const re = new RegExp("(?<![\\w$.])" + name + "(?![\\w$])", "g");
      let mm;
      while ((mm = re.exec(before)) !== null) {
        const prev = before[mm.index - 1] || "";
        const next = before[mm.index + name.length] || "";
        if (QUOTES.includes(prev) || QUOTES.includes(next)) continue; // 字符串字面量
        if (next === ":") continue;                                   // 对象属性名
        quizStrays++;
        fail(`app.js 出现裸 \`${name}\`（该状态已归 ${g.mod}，宿主应走实例接口）：${line.trim().slice(0, 90)}`);
      }
    }
  }
}
const ownedTotal = OWNED_BY.reduce((n, g) => n + g.names.length, 0);
if (quizStrays === 0) ok(`app.js 无裸插件状态引用（${ownedTotal} 个状态均已收敛进各自的 js/ 模块）`);

// ---------------------------------------------------------------------
// 6) XSS 护栏（20260907）：escapeHtml 的唯一实现必须在 js/core.js
//    app.js 原先在自己的 IIFE 里定义 escapeHtml（旧 1442 行），不可单测。
//    真正的隐患不是"现在写错了"，而是将来有人在别处再写一个"更简洁的版本"
//    （例如漏掉引号转义）——两份实现各自漂移，某天就被绕过去了。
//    本类坑本项目已踩过一次（思考分支把 m.content 裸插进 innerHTML）。
//    这里锁死"单一实现"：其余文件只能通过 deps 注入的简写属性（escapeHtml,）
//    引用，不得自行声明。
//    注：没有做全站 innerHTML 污点分析——那需要维护一长串"已转义局部变量"
//    白名单（cq / pf / pct / tag …），误报与长期维护成本高于收益。真正的
//    行为护栏放在 js/core.test.js 的 13 条 escapeHtml 用例上。
// ---------------------------------------------------------------------
console.log("[6] XSS 护栏（escapeHtml 单一实现）");
const SCAN_FILES = ["app.js", "js/group.js", "js/quiz.js", "js/profile-ui.js", "js/roles.js"];
const DECL_RE = /(?:^\s*function\s+escapeHtml\b)|(?:\b(?:const|let|var)\s+escapeHtml\s*=)|(?:\bescapeHtml\s*:\s*(?:function\b|[a-zA-Z_$]\s*=>|\())/;
let declViolations = 0;
for (const rel of SCAN_FILES) {
  const abs = join(root, rel);
  const lines = readFileSync(abs, "utf8").split("\n");
  lines.forEach((raw, i) => {
    const before = raw.slice(0, raw.indexOf("//") >= 0 ? raw.indexOf("//") : raw.length);
    if (DECL_RE.test(before)) {
      declViolations++;
      fail(`${rel}:${i + 1} 重复定义了 escapeHtml（唯一实现须在 js/core.js）：${raw.trim().slice(0, 80)}`);
    }
  });
}
if (declViolations === 0) ok(`${SCAN_FILES.length} 个文件均未重复定义 escapeHtml（实现唯一，位于 js/core.js）`);

// 正向控制：core.js 必须真的导出它，否则上面那条"无重复定义"是空转通过
const coreSrc = readFileSync(join(root, "js/core.js"), "utf8");
if (/escapeHtml:\s*escapeHtml/.test(coreSrc)) ok("js/core.js 确实导出 escapeHtml（护栏非空转）");
else fail("js/core.js 未导出 escapeHtml —— [6] 护栏已失效，请检查 core.js 导出清单");

// ---------------------------------------------------------------------
// 7) 模块命名导入契约：import { x } from "./y.js" 的 x 必须在 y.js 里真实导出。
//    漏写 export 的代价极大：浏览器会直接拒绝整个模块
//    （"does not provide an export named 'x'"），表现为整站白屏；
//    而 eslint（未配 import 插件）与 node 单测都不会报，只有真正开浏览器才暴露。
//    2026-09-08 去重 sliceMaterialForLesson 时正踩此坑，故补此静态护栏。
// ---------------------------------------------------------------------
console.log("");
console.log("[7] 模块命名导入契约（防漏 export 导致整站白屏）");

// 目标模块是否导出了该名字（覆盖本仓库实际使用的几种导出写法）
function hasNamedExport(src, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    "export\\s+(?:async\\s+)?function\\s*\\*?\\s*" + esc + "\\b", // export function x
    "export\\s+(?:const|let|var|class)\\s+" + esc + "\\b",       // export const x
    "export\\s*\\{[^}]*\\b" + esc + "\\b[^}]*\\}",               // export { x } / export { x as y }
    "\\b" + esc + "\\s*:\\s*(?:async\\s+)?(?:function\\b|" + esc + "\\b)", // 导出对象：x: x  或 x: function
  ];
  return patterns.some((p) => new RegExp(p, "m").test(src));
}

const IMPORT_FILES = [
  { file: "app.js", src: appJs, dir: root },
  ...moduleFiles.map((f) => ({ file: "js/" + f, src: readFileSync(join(jsDir, f), "utf8"), dir: jsDir })),
];

let importChecks = 0;
let importViolations = 0;
for (const f of IMPORT_FILES) {
  // 每条文件用独立正则，避免 lastIndex 跨文件串味
  const re = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
  let im;
  while ((im = re.exec(f.src)) !== null) {
    const spec = im[2];
    if (!spec.startsWith(".")) continue; // 只查相对路径模块（裸模块名交给打包器/浏览器解析）
    const names = im[1].split(",").map((s) => s.trim()).filter(Boolean)
      .map((s) => s.split(/\s+as\s+/)[0].trim()); // 忽略本地别名，只校验原名
    const targetPath = join(f.dir, spec);
    let targetSrc;
    try { targetSrc = readFileSync(targetPath, "utf8"); }
    catch (e) { importViolations++; fail(`${f.file} 引用的模块不存在：${spec}`); continue; }
    for (const n of names) {
      importChecks++;
      if (!hasNamedExport(targetSrc, n)) {
        importViolations++;
        fail(`${f.file} 从 ${spec} 导入了 "${n}"，但该模块并未导出它（浏览器会整模块加载失败 → 整站白屏）`);
      }
    }
  }
}
if (importViolations === 0 && importChecks > 0) ok(`校验了 ${importChecks} 个命名导入，全部有对应导出`);
if (importChecks === 0) fail("[7] 护栏空转：未校验到任何命名导入，请检查扫描逻辑");

// ---------------------------------------------------------------------
// 8) 超时派生绊网（2026-09-12 修 B8）：
//    B1/B7 的教训是「config 里算了预算 ≠ 调用点真的用了它」——单测全绿也照样翻车。
//    超时同理：只要写成 app.js 里的一个字面量常量，它就再也接不上各调用点相差 16 倍的
//    输出预算（聊天 4096 / 结构化 8192 / 大纲 65536），慢模型下大输出任务会在中途被 abort，
//    而用户看到的是"生成失败"，真因完全不可见。
//    这里静态锁两件事：① 不再出现写死的超时常量；② callAPIWith 真的调了派生函数。
//    注：测试连接那条 `setTimeout(..., 15000)` 是固定的一次性探活（无输出预算可言），
//    不属本护栏范围，故只拦「声明成常量」的写法。
// ---------------------------------------------------------------------
console.log("");
console.log("[8] 超时派生绊网（不得写死请求超时）");
const hardcodedTimeouts = [];
appJs.split("\n").forEach((raw, i) => {
  const before = raw.slice(0, raw.indexOf("//") >= 0 ? raw.indexOf("//") : raw.length);
  if (/\b(?:const|let|var)\s+\w*TIMEOUT_MS\w*\s*=\s*\d/.test(before)) {
    hardcodedTimeouts.push((i + 1) + " 行: " + raw.trim().slice(0, 80));
  }
});
if (hardcodedTimeouts.length === 0) ok("app.js 无写死的超时常量");
else hardcodedTimeouts.forEach((h) => fail(`app.js ${h} → 超时应由 config.apiTimeout + core.apiTimeoutMs 派生`));

// 正向控制：确认真的用了派生函数，否则上面那条"无写死常量"是空转通过
if (/apiTimeoutMs\(/.test(appJs)) ok("app.js 确实调用 apiTimeoutMs() 派生超时（护栏非空转）");
else fail("app.js 未调用 apiTimeoutMs() —— [8] 护栏已失效");
if (/apiTimeoutMs\([^)]*APP_CONFIG\.apiTimeout/.test(appJs)) ok("超时参数取自 config.apiTimeout");
else fail("app.js 调用 apiTimeoutMs 时未传 config.apiTimeout（会退化成内置默认值）");

// ---------------------------------------------------------------------
// 9) HTML 属性插值护栏（2026-09-12 新增，B11）
//    背景：`data-bid="' + bk.id + '"` 这类拼接遍布 app.js。实测同一处的
//    `ls.id` 过了 escapeHtml、`bk.id` 却没过；记忆面板里 personality/habits 过了、
//    observations 没过 —— **「同族只守一半」是本项目反复出现的真实bug形态**。
//    [6] 只锁 escapeHtml 的实现唯一性，锁不住"该调用它的地方没调用"。
//    这里把"属性值插值必须转义"钉死：除白名单（数值下标 / 字面量三元 / 固定常量表 /
//    应用自生成 id）外，一律要求表达式自身出现 escapeHtml(。
//    白名单是**显式**的，加新条目必须在这里写一行并说明为什么安全 —— 强制一次人工判断。
//    注：本条一上线就多扫出 11 处（profile-ui.js 的 e.id ×8、quiz.js 的数值下标 ×2、
//    固定常量表的 d.id ×2 等），说明"只扫 app.js 的手工检查"确实会漏。
// ---------------------------------------------------------------------
console.log("");
console.log("[9] HTML 属性插值护栏（防漏转义）");
const ATTR_SAFE = new Set([
  "idx",                                // 循环下标，纯数字
  "ci",                                 // 章序号，纯数字
  "i",                                  // 选项下标，纯数字（quiz.js）
  "ans",                                // 正确答案下标，纯数字（quiz.js）
  '(st === "completed" ? "1" : "0")',   // 两个字符串字面量构成的三元
  "t.id",                               // 思考占位 id，应用自生成（think_<ts>_<rand>），非外部输入
  "tab",                                // 画像页签 id，固定枚举（user / ai）
  "d.id",                               // 六维画像维度 id，来自 js/profile.js 的 DIMENSIONS 固定常量表
  "cls",                                // js/quiz.js:129 的 class 名：只由内部字面量拼装
                                        // （"q-choice" + " correct"/" wrong"/" disabled"），不含外部输入
]);
// 20260913：正则从 `data-([\w-]+)=` 放宽到【任意属性名】。
// 只扫 data-* 是本条护栏最大的漏洞：B11 那一轮修完之后，同一批里剩下的
// `src=`（js/group.js 的头像）、`value=`（js/profile-ui.js 的 <option>）、
// 以及裸拼的 `m.lastStudied`/`c.collectedAt`（app.js 记忆面板）全都扫不到——
// 它们和已修的 data-id 是**同一类**风险，只是属性名不同。已实际漏网三处。
// 仍然只覆盖「属性值整体由插值构成」的形态（attr="' + expr + '"）；
// 半插值（如 class="foo ' + x + '"）不在此列——那种形态在本仓库只由内部常量拼装，
// 若将来出现，请改成整体插值并转义，或加白名单说明。
const ATTR_RE = /([\w-]+)="'\s*\+\s*(.+?)\s*\+\s*'"/g;
const ATTR_FILES = [
  { file: "app.js", src: appJs },
  ...moduleFiles.map((f) => ({ file: "js/" + f, src: readFileSync(join(jsDir, f), "utf8") })),
];
let attrChecked = 0, attrViolations = 0;
for (const f of ATTR_FILES) {
  const re = new RegExp(ATTR_RE.source, "g");
  let am;
  while ((am = re.exec(f.src)) !== null) {
    const attr = am[1], expr = am[2];
    attrChecked++;
    if (ATTR_SAFE.has(expr) || expr.includes("escapeHtml(")) continue;
    attrViolations++;
    const line = f.src.slice(0, am.index).split("\n").length; // 注意是 am.index —— RegExpExecArray 没有 .start
    fail(`${f.file}:${line} ${attr} 的属性值未转义：${expr.slice(0, 60)}（须包 escapeHtml(...) 或加入 ATTR_SAFE 白名单并说明理由）`);
  }
}
if (attrViolations === 0 && attrChecked > 0) {
  ok(`${attrChecked} 处属性值插值全部已转义或已列入白名单（${ATTR_SAFE.size} 条白名单）`);
}
if (attrChecked === 0) fail("[9] 护栏空转：未扫到任何属性值插值，请检查正则");

// ---------------------------------------------------------------------
console.log("");
if (failed > 0) { console.error(`契约测试失败：${failed} 项`); process.exit(1); }
console.log(`契约测试全部通过 ✓`);
