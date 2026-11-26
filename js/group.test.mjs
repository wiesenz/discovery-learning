/* =====================================================================
 *  Socratopia v0 · 群聊域单元测试（node js/group.test.mjs）
 *  ---------------------------------------------------------------------
 *  只测一个函数：parseGroupLines —— 把模型返回的群聊文本解析成
 *  [{ speaker, text }]。
 *
 *  为什么值得单独测（而注释里那句"纯函数，便于单测"此前一直没有兑现）：
 *  它解析的是【模型输出】—— 本项目里最容易出畸形数据的那类输入。模型会写成
 *  markdown（**名字**：/ - 名字：/ > 名字：）、会用半角冒号、会把一句话断成几行、
 *  偶尔完全不按格式来（整段自然段）。这些分支目前全靠肉眼看，而它们的失败方式是
 *  "群里没声了"或"名字被装饰符污染"，都不报错、只是难看。
 *
 *  注：它是 createGroupChat(deps) 闭包内的函数（兜底分支要读 els.roleSelect.value），
 *  所以这里用最小假 deps 构造实例来调它 —— 顺带也验证了"构造期不碰 DOM"这条边界：
 *  只给一个假的 roleSelect，不给 document，能构造出来就说明构造期确实没有 DOM 依赖。
 * ===================================================================== */
import { createGroupChat } from "./group.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}
function eq(name, a, b) { ok(name + " (得到 " + JSON.stringify(a) + ")", a === b); }

// 最小假 deps：本文件只调 parseGroupLines，其余能力都不会被执行到。
// els.roleSelect.value 只在"整段无格式"的兜底分支里用到。
function makeGroup(roleName) {
  return createGroupChat({
    els: { roleSelect: { value: roleName === undefined ? "三月七" : roleName } },
  });
}

console.log("构造期不依赖 DOM（只给一个假 roleSelect 就能建出实例）");
{
  const g = makeGroup();
  ok("createGroupChat 只用假 els 即可构造", !!g);
  ok("parseGroupLines 是对外接口", typeof g.parseGroupLines === "function");
}

console.log("parseGroupLines —— 正常格式");
{
  const g = makeGroup();
  const r = g.parseGroupLines("三月七：诶，开拓者今天很稳啊～\n星见雅：尚可。这一刀，稳了。");
  eq("解析出两条", r.length, 2);
  eq("第一条说话人", r[0].speaker, "三月七");
  eq("第一条正文", r[0].text, "诶，开拓者今天很稳啊～");
  eq("第二条说话人", r[1].speaker, "星见雅");
  ok("每条都是 {speaker, text} 形状", r.every((x) => typeof x.speaker === "string" && typeof x.text === "string"));
}

console.log("parseGroupLines —— 半角冒号 / CRLF / 空行");
{
  const g = makeGroup();
  eq("半角冒号也认", g.parseGroupLines("三月七: 嗨")[0].speaker, "三月七");
  eq("CRLF 换行", g.parseGroupLines("三月七：嗨\r\n星见雅：嗯")[0].text, "嗨");
  eq("空行被跳过", g.parseGroupLines("\n\n三月七：嗨\n\n").length, 1);
  eq("首尾空白被裁掉", g.parseGroupLines("  三月七：  嗨  ")[0].text, "嗨");
}

console.log("parseGroupLines —— markdown 装饰不能污染角色名");
{
  const g = makeGroup();
  const cases = [
    ["**三月七**：嗨", "加粗"],
    ["- 三月七：嗨", "列表项"],
    ["* 三月七：嗨", "星号列表"],
    ["> 三月七：嗨", "引用"],
    ["# 三月七：嗨", "标题"],
    ["「三月七」：嗨", "书名号"],
    ["\"三月七\"：嗨", "直引号"],
    ["三月七：嗨", "无装饰（对照）"],
  ];
  for (const [input, label] of cases) {
    const r = g.parseGroupLines(input);
    ok(label + " → 角色名干净（" + JSON.stringify(r[0] && r[0].speaker) + "）", r.length === 1 && r[0].speaker === "三月七");
  }
}

console.log("parseGroupLines —— 断行续接（模型把一句话拆成几行）");
{
  const g = makeGroup();
  const r = g.parseGroupLines("三月七：咱觉得这里有个坑，\n你想想是不是这样？\n星见雅：确实。");
  eq("续行不产生新条目", r.length, 2);
  eq("续行接在上一条后面（空格分隔）", r[0].text, "咱觉得这里有个坑， 你想想是不是这样？");
  eq("下一条仍独立", r[1].speaker, "星见雅");
}

console.log("parseGroupLines —— 整段无格式时的兜底（避免群里没声）");
{
  eq("无冒号 → 归为当前角色的发言",
    makeGroup("三月七").parseGroupLines("大家都说得不错，我再补一句。")[0].speaker, "三月七");
  eq("当前角色为空 → 退回「老师」",
    makeGroup("").parseGroupLines("随便一段话")[0].speaker, "老师");
  const merged = makeGroup().parseGroupLines("第一行\n第二行");
  eq("多行自然段合并成一条", merged.length, 1);
  eq("多行合并时以空格相连", merged[0].text, "第一行 第二行");
}

console.log("parseGroupLines —— 边界与畸形输入");
{
  const g = makeGroup();
  eq("空串 → []", g.parseGroupLines("").length, 0);
  eq("null → []", g.parseGroupLines(null).length, 0);
  eq("undefined → []", g.parseGroupLines(undefined).length, 0);
  eq("只有空白 → []", g.parseGroupLines("   \n\t\n  ").length, 0);
  // 「有名字没正文」这一行的实际行为（我最初预期是"丢弃"，实测不是，按真实行为记录）：
  // 空正文不进 out，于是整段落进兜底分支、原文被原样保留成当前角色的一条发言
  // —— 兜底的本意是"别让群里没声"，所以它宁可留一句怪话也不留空。
  const onlyName = g.parseGroupLines("三月七：");
  eq("只有名字没有正文 → 不算一条发言，落到兜底保留原文", onlyName.length, 1);
  eq("兜底保留原文", onlyName[0].text, "三月七：");
  eq("空正文行跟在正常发言后 → 不产生新条目", g.parseGroupLines("三月七：嗨\n星见雅：").length, 1);
  eq("只有冒号 → 落到兜底一条", g.parseGroupLines("：没有名字").length, 1);
  // 角色名长度上限 12：超长的前缀不被当成说话人（避免把正文里的冒号误判成角色名）
  const long = "这是一句很长的前言足足超过十二个字：后面才是正文";
  const r = g.parseGroupLines(long);
  eq("超长前缀不当作角色名（整段走兜底）", r.length, 1);
  eq("兜底条目用的是当前角色名", r[0].speaker, "三月七");
  // 正文里带冒号的短前缀仍会被当成角色名 —— 这是刻意的启发式（说话人 ≤ 12 字）
  eq("短前缀+冒号 → 视为说话人", g.parseGroupLines("老师说：要注意这里")[0].speaker, "老师说");
}

console.log("");
if (fail > 0) { console.error(`group 测试失败：${fail} 项`); process.exit(1); }
console.log(`group 测试全部通过 ✓ (${pass} 项)`);
