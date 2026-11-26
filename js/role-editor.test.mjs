/* Socratopia v0 · 角色编辑表单校验 + AI 联网提示拼接（纯函数单测）
 * 运行：node js/role-editor.test.mjs
 * 目的：
 *   1. 校验合规化改造（20260827）后的字段必填规则；
 *   2. 保证"AI 4 字段强校验"不放过任何漏生成；
 *   3. 20260914：类型字段下线后，buildAutoFillHints 改为「按出处自行判断是否联网」，
 *      这里锁定它的两条分支（有出处 / 无出处）与合规用语不被回退。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as roleEditor from "./role-editor.js";
import { validateRoleEditor, buildAutoFillHints } from "./role-editor.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
function t(label, cond) {
  if (cond) { pass++; console.log("  PASS", label); }
  else { fail++; console.log("  FAIL ***", label); }
}
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  t(label, a === b);
}

const baseInput = {
  name: "墨秋",
  series: "原创·未名山",
  userAlias: "同学",
  openingLine: "你好，今天想学点什么？",
  persona: "你是一位……",
  voice: "说话慢条斯理，常用'唔'……",
  thinkingPhrases: "正在斟酌…\n让我想想\n\n   \n好呢",
};

// ============ 1. 类型字段已下线（回归锁定） ============
t("role-editor.js 不再导出 ROLE_TYPE_OPTIONS（类型下拉已移除）", !("ROLE_TYPE_OPTIONS" in roleEditor));
// 残留的 DOM 引用会在运行时静默变成 null.value 崩溃，这里直接扫源码兜底
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
for (const rel of ["index.html", "js/dom.js", "js/roles.js"]) {
  const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
  t(`${rel} 中不再引用 roleEditType`, !src.includes("roleEditType"));
}

// ============ 2. 必填校验 ============
t("缺 name → ok=false field=name", !validateRoleEditor({ ...baseInput, name: "" }).ok && validateRoleEditor({ ...baseInput, name: "" }).field === "name");
t("缺 name(空白) → ok=false", !validateRoleEditor({ ...baseInput, name: "   " }).ok);
t("缺 series → ok=false field=series", !validateRoleEditor({ ...baseInput, series: "" }).ok && validateRoleEditor({ ...baseInput, series: "" }).field === "series");
t("缺 series(空白) → ok=false", !validateRoleEditor({ ...baseInput, series: " \t\n" }).ok);

// ============ 3. AI 4 字段强校验（合规关键） ============
t("persona+voice 都空 → ok=false field=autoFill",
  !validateRoleEditor({ ...baseInput, persona: "", voice: "" }).ok
  && validateRoleEditor({ ...baseInput, persona: "", voice: "" }).field === "autoFill");
t("persona+voice 都为空白字符 → ok=false",
  !validateRoleEditor({ ...baseInput, persona: "   ", voice: "\n\t" }).ok);
t("persona 单独非空即通过", validateRoleEditor({ ...baseInput, voice: "" }).ok);
t("voice 单独非空即通过", validateRoleEditor({ ...baseInput, persona: "" }).ok);

// ============ 4. 正常路径：role 字段规范化 ============
const ok = validateRoleEditor(baseInput);
t("正常输入 → ok=true", ok.ok);
t("name 已 trim", ok.role && ok.role.name === "墨秋");
t("series 已 trim", ok.role && ok.role.series === "原创·未名山");
t("userAlias 已 trim", ok.role && ok.role.userAlias === "同学");
t("产物不含 type 字段（老数据的 type 是残留，不再写回）", ok.role && !("type" in ok.role));
t("thinkingPhrases 多行拆分", JSON.stringify(ok.role && ok.role.thinkingPhrases) === JSON.stringify(["正在斟酌…", "让我想想", "好呢"]));
t("thinkingPhrases 空行被过滤", ok.role && ok.role.thinkingPhrases.length === 3);
eq("thinkingPhrases 全 trim", ok.role && ok.role.thinkingPhrases, ["正在斟酌…", "让我想想", "好呢"]);

// ============ 5. thinkingPhrases 极端输入 ============
t("thinkingPhrases 仅空白 → 数组空",
  validateRoleEditor({ ...baseInput, thinkingPhrases: "  \n\n  \n" }).ok
  && validateRoleEditor({ ...baseInput, thinkingPhrases: "  \n\n  \n" }).role.thinkingPhrases.length === 0);
t("thinkingPhrases 完全缺省 → 数组空",
  validateRoleEditor({ ...baseInput, thinkingPhrases: undefined }).ok
  && validateRoleEditor({ ...baseInput, thinkingPhrases: undefined }).role.thinkingPhrases.length === 0);
t("thinkingPhrases 字符串未传 → 数组空",
  validateRoleEditor({ ...baseInput, thinkingPhrases: "" }).ok);

// ============ 6. 旧数据回归 ============
// 早期自定义角色：带 type 字段（"游戏"）、只有 openingLine 的老数据
t("带 type 的老角色：type 不再必填，但缺人设仍校验失败",
  !validateRoleEditor({ name: "老角色", series: "旧版", type: "游戏", openingLine: "你好", thinkingPhrases: "" }).ok);
t("带 type 的老角色：补齐人设后通过，且产物里 type 被摘掉",
  (() => { const r = validateRoleEditor({ name: "老角色", series: "旧版", type: "游戏", persona: "P", thinkingPhrases: "" }); return r.ok && !("type" in r.role); })());
// 重置按钮都没点过 → 必须报错引导用户点 AI 自动补全
t("新建模式完全空白 → 校验失败（fail 链首位=name）",
  !validateRoleEditor({}).ok
  && validateRoleEditor({}).field === "name");

// ============ 7. buildAutoFillHints：角色线索拼接 ============
const h1 = buildAutoFillHints({ name: "墨秋", series: "原创·未名山", userAlias: "同学" });
t("hint 含 角色名/出处/称呼", h1.hint.includes("角色名：墨秋") && h1.hint.includes("出处：原创·未名山") && h1.hint.includes("称呼：同学"));
t("hint 不含「类型：」段（类型字段已下线）", !h1.hint.includes("类型："));
t("hint 以角色名开头（不再被类型占位）", h1.hint.startsWith("角色名："));

// ============ 8. buildAutoFillHints：联网判定改为「按出处」 ============
t("有出处 → onlineHint 含「联网检索」", h1.onlineHint.includes("联网检索"));
t("有出处 → onlineHint 含「不引用原话」（合规不许回退）", h1.onlineHint.includes("不引用原话"));
t("有出处 → onlineHint 含「原创」分流说明", h1.onlineHint.includes("原创"));
t("有出处 → onlineHint 含「不要声称与原作」", h1.onlineHint.includes("不要声称与原作"));
t("有出处 → onlineHint 把用户填的出处带进去", h1.onlineHint.includes("原创·未名山"));

// ============ 9. buildAutoFillHints：空字段容忍 ============
const empty = buildAutoFillHints({ name: "无名", series: "" });
t("空 series → hint 不含「出处：」段", !empty.hint.includes("出处："));
t("空 series → hint 仍含角色名", empty.hint.includes("角色名：无名"));
t("空 series → onlineHint 走兜底分支且仍是合规措辞",
  empty.onlineHint.includes("联网检索") && empty.onlineHint.includes("不引用原话"));
const noAlias = buildAutoFillHints({ name: "无名", series: "未名山" });
t("缺 userAlias → hint 不含「称呼：」段", !noAlias.hint.includes("称呼："));
t("全空入参不抛异常", (() => { try { buildAutoFillHints({}); return true; } catch (e) { return false; } })());

// ============ 10. 字段顺序校验：name → series → AI 字段 ============
// 当 name 与 series 都缺时，应先报 name（首位优先）
const both = validateRoleEditor({ series: "" });
t("name+series 都缺 → 优先报 name", !both.ok && both.field === "name");
// 当 name 已填、series 缺时应报 series
const noS = validateRoleEditor({ name: "X", series: "", persona: "", voice: "" });
t("name 已填 → 优先报 series", !noS.ok && noS.field === "series");
// 当 name+series 都填、AI 字段都缺时应报 autoFill（旧版这里会先报 type，已随类型字段下线）
const noA = validateRoleEditor({ name: "X", series: "Y", persona: "", voice: "" });
t("name+series 都填 → 直接报 autoFill（不再有 type 这一环）", !noA.ok && noA.field === "autoFill");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
