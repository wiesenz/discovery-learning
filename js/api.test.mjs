/* =====================================================================
 *  js/api.test.mjs —— 接口传输层单测（createApi）
 *  ---------------------------------------------------------------------
 *  这是本刀（第六刀）真正的收益：B1/B6/B7/B8/B10 这一族 bug 全住在传输层，
 *  而它们原先埋在 app.js 的 IIFE 里**一行单测都写不了**（只有 E2E 能碰）。
 *  抽成模块后，靠替换 globalThis.fetch 就能把「超时怎么算 / 400 怎么退 /
 *  取消算不算失败 / finish_reason 记不记得住」钉死，不必开浏览器。
 *
 *  覆盖：
 *    · 未填 Key → 直接抛错，不发出请求
 *    · 正常非流式：返回 content、记录 finish_reason、写 usage 日志
 *    · finish_reason 每次调用前清空（读到上一次的残留会让 B7 的截断提示误报）
 *    · B8 超时按**本次请求的输出预算**派生（apiTimeoutMs 收到 maxTokens）
 *    · B6 400「超出模型输出上限」：优先退到报错里声明的上限并重试成功
 *    · B6 无声明上限：走减半阶梯（不写死 8192）
 *    · 400 但不属于「输出上限」类错误：不重试，直接抛
 *    · B10 AbortError **不得**当失败重试（否则点「停止」反而又发一个请求）
 *    · 非 AbortError 仍照常重试
 *    · 流式 SSE：逐块累加 delta、末块 usage 也记
 *    · 声称流式但端点回普通 JSON → 自动退回整段解析（功能不受影响）
 *
 *  运行：node js/api.test.mjs（已并入 npm test）
 * ===================================================================== */

import { createApi } from "./api.js";

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail ? "  → " + detail : "")); }
}

const realFetch = globalThis.fetch;
const realAlert = globalThis.alert;
const realLog = console.log;
const realWarn = console.warn;

function makeEls(overrides = {}) {
  return {
    apiBase: { value: "https://api.example.com/v1" },
    apiKey: { value: "sk-test" },
    apiModel: { value: "test-model" },
    apiTemp: { value: "0.7" },
    stopBtn: { style: {} },
    testConn: { textContent: "测试", disabled: false },
    ...overrides,
  };
}

// 造一个够用的 Response 替身（只实现传输层实际用到的部分）
function jsonRes(obj, { status = 200, contentType = "application/json" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? contentType : null) },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}
function errRes(text, status) {
  return {
    ok: false, status,
    headers: { get: () => "application/json" },
    json: async () => ({ error: { message: text } }),
    text: async () => text,
  };
}
// 造 SSE 响应：chunks 为若干段原始文本
function sseRes(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true, status: 200,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }),
      }),
    },
    json: async () => { throw new Error("不应走 JSON 分支"); },
    text: async () => "",
  };
}

// 一次调用的完整脚手架：返回 { api, calls, logs, alerts }
// ⚠️ 只**截获**被测模块自己的 [Socratopia] 日志/warn，其余照常转发到 stdout ——
// 否则本文件里的 ok() 输出会被一起吞掉，测试通过也看不见明细（第一版就踩了这个坑）。
function harness({ responses = [], maxTokensSeen = null } = {}) {
  const calls = [];
  const logs = [];
  const alerts = [];
  // 20261126：usage 汇总回调（宿主用它累计「本次会话用量」），每个用例都顺带验证不漏不重
  const usages = [];
  let idx = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = responses[Math.min(idx, responses.length - 1)];
    idx++;
    if (typeof r === "function") return r();
    return r;
  };
  globalThis.alert = (m) => alerts.push(String(m));
  console.log = (...a) => {
    const s = a.join(" ");
    if (s.includes("[Socratopia]")) { logs.push(s); return; }
    realLog(...a);
  };
  console.warn = (...a) => { const s = a.join(" "); if (s.includes("[Socratopia]")) logs.push(s); else realWarn(...a); };
  const api = createApi({
    els: makeEls(),
    config: { apiTimeout: { baseMs: 1000, perTokMs: 1, capMs: 999999 } },
    toast: () => {},
    maxTokensFallbackChain: (n) => {
      // 与 core.js 同语义的减半阶梯（下限 4096），这里内联一份避免依赖 core 的实现细节
      const out = [];
      let v = Math.floor(n / 2);
      while (v >= 4096) { out.push(v); v = Math.floor(v / 2); }
      return out;
    },
    extractMaxTokensCap: (text) => {
      const m = /less than or equal to\s*(\d+)/i.exec(text || "");
      return m ? parseInt(m[1], 10) : null;
    },
    apiTimeoutMs: (maxTokens, cfg) => {
      if (maxTokensSeen) maxTokensSeen.push(maxTokens);
      return 999999999; // 足够大：测试期间不会真的触发超时中止
    },
    onUsage: (u) => usages.push(u),
  });
  return { api, calls, logs, alerts, usages };
}
function restore() {
  globalThis.fetch = realFetch;
  globalThis.alert = realAlert;
  console.log = realLog;
  console.warn = realWarn;
}
function abortErr() { const e = new Error("aborted"); e.name = "AbortError"; return e; }

// ---------------------------------------------------------------------
console.log("[1] 基础：未填 Key / 正常返回 / finish_reason 记账");

{
  // Key 为空：必须在发出请求之前就抛错（否则会打到一个无鉴权的接口）
  let fetchCount = 0;
  globalThis.fetch = async () => { fetchCount++; return jsonRes({ choices: [] }); };
  globalThis.alert = () => {};
  const api = createApi({
    els: makeEls({ apiKey: { value: "   " } }),
    config: { apiTimeout: {} }, toast: () => {},
    maxTokensFallbackChain: () => [], extractMaxTokensCap: () => null, apiTimeoutMs: () => 999999999,
  });
  let threw = null;
  try { await api.call([{ role: "user", content: "hi" }]); } catch (e) { threw = e; }
  ok("未填 Key → 抛错且不发出请求", !!threw && fetchCount === 0, threw ? threw.message : "没有抛错");
  restore();
}

{
  const { api, calls, logs } = harness({
    responses: [jsonRes({ choices: [{ message: { role: "assistant", content: "你好" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 40 } })],
  });
  const reply = await api.call([{ role: "user", content: "hi" }]);
  ok("正常非流式：返回 content", reply === "你好", "实际 " + JSON.stringify(reply));
  ok("请求体带 model / messages", calls[0].body.model === "test-model" && Array.isArray(calls[0].body.messages));
  ok("未传 maxTokens 时请求体不含 max_tokens", !("max_tokens" in calls[0].body), JSON.stringify(calls[0].body).slice(0, 80));
  ok("记录 finish_reason", api.finishReason() === "stop", "实际 " + api.finishReason());
  ok("写 usage 缓存命中日志", logs.some((l) => l.includes("[Socratopia][usage]") && l.includes("cache_hit_tokens=40")), logs.slice(-1)[0]);
  restore();
}

{
  // finish_reason 必须每次调用前清空：否则上一次的 "length" 会被下一次读到 → B7 的截断提示误报
  const { api } = harness({
    responses: [
      jsonRes({ choices: [{ message: { content: "前半" }, finish_reason: "length" }] }),
      jsonRes({ choices: [{ message: { content: "完整" }, finish_reason: "stop" }] }),
    ],
  });
  await api.call([{ role: "user", content: "1" }]);
  ok("截断调用后 finish_reason = length", api.finishReason() === "length");
  await api.call([{ role: "user", content: "2" }]);
  ok("下一次调用前已清空（不残留上一次的 length）", api.finishReason() === "stop", "实际 " + api.finishReason());
  restore();
}

// ---------------------------------------------------------------------
console.log("[2] B8：超时按本次请求的输出预算派生");

{
  const seen = [];
  const { api } = harness({ responses: [jsonRes({ choices: [{ message: { content: "ok" } }] })], maxTokensSeen: seen });
  await api.call([{ role: "user", content: "hi" }]);
  await api.call([{ role: "user", content: "hi" }], { maxTokens: 65536 });
  ok("apiTimeoutMs 收到本次请求的 maxTokens（无 → undefined，有 → 原值）",
    seen.length === 2 && seen[0] === undefined && seen[1] === 65536, JSON.stringify(seen));
  restore();
}

// ---------------------------------------------------------------------
console.log("[3] B6：400「超出模型输出上限」的降级重试");

{
  const { api, calls } = harness({
    responses: [
      errRes("max_tokens must be less than or equal to 8192", 400),
      jsonRes({ choices: [{ message: { content: "退到 8192 后成功" } }] }),
    ],
  });
  const r = await api.call([{ role: "user", content: "hi" }], { maxTokens: 65536 });
  ok("优先退到报错里声明的模型上限（8192）", calls.length === 2 && calls[1].body.max_tokens === 8192,
    calls.map((c) => c.body.max_tokens).join(" → "));
  ok("重试成功后返回内容", r === "退到 8192 后成功", r);
  restore();
}

{
  const { api, calls } = harness({
    responses: [
      errRes("max_tokens is too large for this model", 400), // 没有声明具体上限
      jsonRes({ choices: [{ message: { content: "阶梯成功" } }] }),
    ],
  });
  await api.call([{ role: "user", content: "hi" }], { maxTokens: 65536 });
  ok("无声明上限 → 走减半阶梯（首个退值 32768，而不是写死的 8192）",
    calls.length === 2 && calls[1].body.max_tokens === 32768, calls.map((c) => c.body.max_tokens).join(" → "));
  restore();
}

{
  const { api, calls } = harness({ responses: [errRes("invalid api key", 400)] });
  let threw = null;
  try { await api.call([{ role: "user", content: "hi" }], { maxTokens: 65536 }); } catch (e) { threw = e; }
  ok("400 但不是「输出上限」类错误 → 不重试、直接抛", !!threw && calls.length === 1, "请求数 " + calls.length);
  restore();
}

{
  // 重试期间又有别的错误：isTooLargeErr 变 false → 停止阶梯，不无谓重试
  const { api, calls } = harness({
    responses: [
      errRes("max_tokens too large", 400),
      errRes("rate limited", 429),
    ],
  });
  let threw = null;
  try { await api.call([{ role: "user", content: "hi" }], { maxTokens: 65536 }); } catch (e) { threw = e; }
  ok("阶梯途中换成非「输出上限」错误 → 立即停止重试", !!threw && calls.length === 2, "请求数 " + calls.length);
  restore();
}

// ---------------------------------------------------------------------
console.log("[4] B10：取消不是失败");

{
  globalThis.fetch = async () => { throw abortErr(); };
  const api = createApi({
    els: makeEls(), config: { apiTimeout: {} }, toast: () => {},
    maxTokensFallbackChain: () => [], extractMaxTokensCap: () => null, apiTimeoutMs: () => 999999999,
  });
  let threw = null;
  try { await api.callWithRetry([{ role: "user", content: "hi" }], 2); } catch (e) { threw = e; }
  ok("AbortError 直接抛出、不当失败重试", !!threw && threw.name === "AbortError", threw ? threw.name : "没有抛错");
  restore();
}

{
  let n = 0;
  const toasts = [];
  globalThis.fetch = async () => { n++; throw new Error("网络抖动"); };
  const api = createApi({
    els: makeEls(), config: { apiTimeout: {} }, toast: (m) => toasts.push(m),
    maxTokensFallbackChain: () => [], extractMaxTokensCap: () => null, apiTimeoutMs: () => 999999999,
  });
  let threw = null;
  try { await api.callWithRetry([{ role: "user", content: "hi" }], 3); } catch (e) { threw = e; }
  ok("非中止错误仍照常重试（tries 次）", n === 3, "请求数 " + n);
  ok("重试有可见提示（不是静默重试）", toasts.some((t) => t.includes("重试中")), toasts.join(" | "));
  restore();
}

// ---------------------------------------------------------------------
console.log("[5] 流式：SSE 累加 / 端点不支持时退回整段");

{
  const { api, logs } = harness({
    responses: [sseRes([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n',
      'data: {"usage":{"prompt_tokens":50,"prompt_cache_hit_tokens":10}}\n',
      'data: {"choices":[{"finish_reason":"length"}]}\n',
      "data: [DONE]\n",
    ])],
  });
  const out = await api.call([{ role: "user", content: "hi" }], { stream: true, onToken: () => {} });
  ok("SSE 逐块累加 delta", out === "你好", JSON.stringify(out));
  ok("流式也记 finish_reason（截断可被上层看见）", api.finishReason() === "length", "实际 " + api.finishReason());
  ok("流式也写 usage 日志", logs.some((l) => l.includes("[Socratopia][usage]")), "");
  restore();
}

{
  // 【静默半句 · 成因一】流走到 done 却从没出现 finish_reason = 被网络/网关从中间掐断。
  // 这种结束方式**不抛异常**，调用方的 catch 永远等不到 —— 若不在这里取证，上层拿到的
  // 半句话与完整回复完全无法区分（真实故障：气泡停在「你说完这两句，咱就」，没有任何提示）。
  const { api, logs } = harness({
    responses: [sseRes([
      'data: {"choices":[{"delta":{"content":"你说完这两句，咱就"}}]}\n',
      "data: [DONE]\n",
    ])],
  });
  const out = await api.call([{ role: "user", content: "hi" }], { stream: true, onToken: () => {} });
  ok("流被掐断：内容照常返回（不吞已生成的部分）", out === "你说完这两句，咱就", JSON.stringify(out));
  ok("流被掐断：finish_reason 记为 incomplete（与 length 区分开）",
    api.finishReason() === "incomplete", "实际 " + api.finishReason());
  ok("流被掐断：留下 console 痕迹便于排查",
    logs.some((l) => l.includes("finish_reason")), logs.join(" | "));
  restore();
}

{
  // 反向用例（防误报）：带 finish_reason 的正常流**不得**被判成 incomplete，
  // 否则每条正常回复后面都会挂一句"流可能被掐断"的假警报。
  const { api } = harness({
    responses: [sseRes([
      'data: {"choices":[{"delta":{"content":"完整回复"}}]}\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n',
      "data: [DONE]\n",
    ])],
  });
  await api.call([{ role: "user", content: "hi" }], { stream: true, onToken: () => {} });
  ok("正常结束（带 finish_reason=stop）不会被误判为 incomplete",
    api.finishReason() === "stop", "实际 " + api.finishReason());
  restore();
}

{
  // 反向用例：空流（没内容、也没 finish_reason）不该标 incomplete ——
  // 它由 chat 已有的「模型没返回内容」兜底文案负责，标成 incomplete 会给出错误的归因。
  const { api } = harness({ responses: [sseRes(["data: [DONE]\n"])] });
  const out = await api.call([{ role: "user", content: "hi" }], { stream: true, onToken: () => {} });
  ok("空流：返回空串且不标 incomplete（归因交给上层兜底文案）",
    out === "" && api.finishReason() === null, JSON.stringify(out) + " / " + api.finishReason());
  restore();
}

{
  // completion_tokens 必须进 usage 日志：它是「可见正文很短却仍被截断」的第一手证据
  // —— 那种情形说明预算被**推理 token** 吃掉了（readSSE 不读 reasoning_content，只丢显示，不丢额度）。
  const { api, logs } = harness({
    responses: [sseRes([
      'data: {"choices":[{"delta":{"content":"短"}}]}\n',
      'data: {"usage":{"prompt_tokens":50,"completion_tokens":4096}}\n',
      "data: [DONE]\n",
    ])],
  });
  await api.call([{ role: "user", content: "hi" }], { stream: true, onToken: () => {} });
  ok("usage 日志带上 completion_tokens",
    logs.some((l) => l.includes("[Socratopia][usage]") && l.includes("completion_tokens=4096")), logs.join(" | "));
  restore();
}

{
  // 声称流式、端点却回普通 JSON → 必须自动退回整段解析，不能报错
  const { api } = harness({
    responses: [jsonRes({ choices: [{ message: { content: "整段回复" }, finish_reason: "stop" }] })],
  });
  const out = await api.call([{ role: "user", content: "hi" }], { stream: true, onToken: () => {} });
  ok("端点不支持 SSE → 退回整段解析", out === "整段回复", JSON.stringify(out));
  restore();
}

// ---------------------------------------------------------------------
console.log("[6] 温度解析：0 是合法值，不能被 || 吞掉");

{
  // 宿主「保存设置」与「发请求」共用这一处解析，所以它必须自己站得住
  const mk = (v) => createApi({
    els: makeEls({ apiTemp: { value: v } }), config: { apiTimeout: {} }, toast: () => {},
    maxTokensFallbackChain: () => [], extractMaxTokensCap: () => null, apiTimeoutMs: () => 999999999,
  });
  ok("temperature=0 保持 0（不能回落 0.7）", mk("0").temperature() === 0, "实际 " + mk("0").temperature());
  ok("temperature=0.3 原样", mk("0.3").temperature() === 0.3, "实际 " + mk("0.3").temperature());
  ok("temperature=2 原样（上界交给 provider 判）", mk("2").temperature() === 2, "实际 " + mk("2").temperature());
  ok("temperature 空串 → 回落 0.7", mk("").temperature() === 0.7, "实际 " + mk("").temperature());
  ok("temperature 乱码 → 回落 0.7", mk("abc").temperature() === 0.7, "实际 " + mk("abc").temperature());
}

// ---------------------------------------------------------------------
console.log("[7] 收尾：请求进行中显示「⏹ 停止」，结束后收起");

{
  const els = makeEls();
  const calls = [];
  globalThis.fetch = async () => { calls.push(els.stopBtn.style.display); return jsonRes({ choices: [{ message: { content: "x" } }] }); };
  const api = createApi({
    els, config: { apiTimeout: {} }, toast: () => {},
    maxTokensFallbackChain: () => [], extractMaxTokensCap: () => null, apiTimeoutMs: () => 999999999,
  });
  await api.call([{ role: "user", content: "hi" }]);
  ok("请求期间 stopBtn 显示 inline-block", calls[0] === "inline-block", "实际 " + calls[0]);
  ok("请求结束后 stopBtn 收起", els.stopBtn.style.display === "none", "实际 " + els.stopBtn.style.display);
  restore();
}

// ---------------------------------------------------------------------
console.log("[8] B4：按来源槽位中止（并发时不再「点 A 停 B」）");

{
  // 两个"挂住不返回"的请求，各自只响应自己的 AbortSignal
  globalThis.fetch = (url, init) => new Promise((_, reject) => {
    const sig = init && init.signal;
    if (sig) sig.addEventListener("abort", () => reject(abortErr()));
  });
  const api = createApi({
    els: makeEls(), config: { apiTimeout: {} }, toast: () => {},
    maxTokensFallbackChain: () => [], extractMaxTokensCap: () => null,
    // 短超时：既足够做断言，又保证最后那个挂住的请求会自己收尾 —— 否则它的定时器留在
    // 事件循环里，Node 不会退出，npm test 会一直挂着。
    apiTimeoutMs: () => 400,
  });

  // ⚠️ 顺序是关键：群聊【先】发、聊天【后】发。
  // 修复前 abort() 只认"最新发出的那个"，所以点群聊的「⏹ 停笔」会掐断后发的聊天那条 ——
  // 这正是线上会遇到的时序（开群聊复盘 → 收起浮层 → 去聊天区发消息 → 回来点停笔）。
  // 若把两条请求的顺序写反，这个用例在修复前后【都会通过】，等于什么都没锁住。
  const pGroup = api.call([{ role: "user", content: "群聊" }], { slot: "group" });
  const pChat = api.call([{ role: "user", content: "聊天" }], { slot: "chat" });
  let chatRejected = false;
  pChat.catch(() => { chatRejected = true; });

  api.abort("group");
  let groupErr = null;
  try { await pGroup; } catch (e) { groupErr = e && e.name; }
  await new Promise((r) => setTimeout(r, 20)); // 给聊天那条一个 reject 的机会
  ok("abort('group') 中止的是群聊那次（而不是后发的聊天）", groupErr === "AbortError", "实际 " + groupErr);
  ok("abort('group') 没有误伤同时在飞的聊天请求", !chatRejected);

  // 指定槽位空闲时（此时 outline 为空、chat 正忙）→ 退化为"中止最新的"。
  // 三个停止按钮的可见性看的是"有没有任意请求在飞"，若此处直接返回就会变成点了没反应的死按钮。
  api.abort("outline");
  let chatErr = null;
  try { await pChat; } catch (e) { chatErr = e && e.name; }
  ok("指定槽位空闲时退化为中止最新的（不留死按钮）", chatErr === "AbortError", "实际 " + chatErr);

  restore();
}

console.log("[N] usage 汇总回调（设置面板「本次会话用量」依赖它）");
{
  // 非流式：末块 usage 必须原样交给宿主，且只交一次（漏了面板不显示，重了金额翻倍）
  const u1 = { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60 };
  const h = harness({ responses: [jsonRes({ choices: [{ message: { content: "啊" }, finish_reason: "stop" }], usage: u1 })] });
  await h.api.call([{ role: "user", content: "x" }], { maxTokens: 4096 });
  ok("非流式：onUsage 恰好被调用一次", h.usages.length === 1, "实际 " + h.usages.length);
  ok("非流式：拿到的是同一个 usage 对象", h.usages[0] === u1);
  restore();

  // 流式：readSSE 里的末块 usage 也必须汇总（否则用流式聊天的人面板永远是 0）
  const u2 = { prompt_tokens: 200, completion_tokens: 30, prompt_cache_hit_tokens: 150 };
  const h2 = harness({ responses: [sseRes([
    'data: {"choices":[{"delta":{"content":"你"}}]}\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n',
    'data: ' + JSON.stringify({ choices: [], usage: u2 }) + "\n",
    "data: [DONE]\n",
  ])] });
  await h2.api.call([{ role: "user", content: "x" }], { maxTokens: 4096, stream: true, onToken: () => {} });
  ok("流式：onUsage 恰好被调用一次", h2.usages.length === 1, "实际 " + h2.usages.length);
  // 流式的 usage 是从 SSE 文本里 JSON.parse 出来的新对象，只能比值不能比引用
  ok("流式：usage 字段完整传到宿主",
    h2.usages[0] && h2.usages[0].prompt_tokens === 200 && h2.usages[0].prompt_cache_hit_tokens === 150,
    "实际 " + JSON.stringify(h2.usages[0]));
  restore();

  // 回调自身抛错绝不能影响主流程（统计是附属功能，不该让对话失败）
  // 复用 harness 装好的 fake fetch，只把 onUsage 换成会抛错的实现
  harness({ responses: [jsonRes({ choices: [{ message: { content: "好" } }], usage: { prompt_tokens: 1 } })] });
  const api3 = createApi({
    els: makeEls(), config: { apiTimeout: { baseMs: 1000, perTokMs: 1, capMs: 999999 } },
    toast: () => {}, maxTokensFallbackChain: () => [], extractMaxTokensCap: () => null,
    apiTimeoutMs: () => 999999999,
    onUsage: () => { throw new Error("统计炸了"); },
  });
  let survived = "";
  try { survived = await api3.call([{ role: "user", content: "x" }], { maxTokens: 4096 }); }
  catch (e) { survived = "THREW:" + e.message; }
  ok("onUsage 抛错不牵连主流程", survived === "好", "实际 " + survived);
  restore();
}

console.log("\n" + (fail === 0 ? `api 测试全部通过 ✓ (${pass} 项)` : `api 测试有失败 ✗ (${pass} 通过 / ${fail} 失败)`));
if (fail > 0) process.exitCode = 1;
