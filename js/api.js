/* =====================================================================
 *  Socratopia v0 · 接口传输层（OpenAI 兼容 /chat/completions）
 *  20260912.1 从 app.js 抽出（技术债拆分第六刀）。
 *
 *  为什么单独成模块：本项目近期的 bug 几乎全住在这里 ——
 *    B1  两条大纲路径都没传 max_tokens → 落 provider 默认 4096 → JSON 被截断
 *    B6  max_tokens 被 provider 拒收时固定退到 8192（大输出任务仍会截断）
 *    B7  结构化 JSON 调用漏传 max_tokens → 下课小结被静默截断
 *    B8  超时写死 300000，不随输出预算派生
 *    B10 callAPIRetry 把 AbortError 当失败重试 → 点「停止」反而又发一个请求
 *  这些逻辑原先埋在 app.js 的 IIFE 里，**一行单测都写不了**（只有 E2E 能碰）。
 *  搬到这里后，配合 js/api.test.mjs 可以直接把「超时怎么算 / 400 怎么退 / 取消算不算失败」
 *  钉成单测 —— 这是本刀真正的收益，不只是省行数。
 *
 *  设计：与 group.js / quiz.js / source-viewer.js 同构 —— 工厂 + 依赖注入。
 *  自己的状态（ctrlBySlot / inFlight / lastFinishReason）收敛在闭包内，
 *  宿主经 api.abort() / api.finishReason() 访问，不再直读裸变量。
 *
 *  用法：
 *    const api = createApi({ els, config: APP_CONFIG, toast, maxTokensFallbackChain,
 *                            extractMaxTokensCap, apiTimeoutMs });
 *    const reply = await api.call(msgs, { maxTokens: 8192 });
 *    const r2 = await api.callWithRetry(msgs, 2, { maxTokens: ... });
 * ===================================================================== */

export function createApi(deps) {
  const {
    els,                     // { apiBase, apiKey, apiModel, apiTemp, stopBtn, testConn }
    config,                  // APP_CONFIG（读 config.apiTimeout）
    toast,                   // (msg, ms?) => void，重试提示
    maxTokensFallbackChain,  // (requested) => number[]，减半阶梯（core.js，有单测）
    extractMaxTokensCap,     // (errText) => number|null，从报错里抠模型声明的上限（core.js）
    apiTimeoutMs,            // (maxTokens, cfg) => ms，按输出预算派生超时（core.js，有单测）
    onUsage,                 // (usage) => void，每次拿到 usage 时回调（设置面板的用量账本用）
  } = deps;

  // 在飞请求的控制器，按【来源槽位】索引（20260913 修 B4）。
  // 原先只有一个 activeAbortController，语义是"中止最新发出的那个"—— 而三个「⏹ 停止」按钮
  // （聊天区 / 群聊浮层 / 大纲进度浮层）共用它，于是并发时会出现"点 A 停 B"：
  // 开一场群聊复盘（长请求）→ 收起浮层 → 回聊天区发一条消息（成为最新的）→ 再点群聊的
  // 「⏹ 停笔」→ 被掐断的却是私聊那条。群聊只禁用 els.groupSend，不碰宿主的发送按钮，
  // 所以这个并发是真实可达的。
  // 槽位：chat（聊天区的一切生成，含开课/复习/下课/开场导读，默认）
  //      / group（群聊复盘）/ outline（大纲生成，浮层里有自己的停止按钮）。
  const ctrlBySlot = new Map(); // slot -> AbortController
  let inFlight = 0;             // 在飞请求数，决定「⏹ 停止」何时收起
  // 上一次调用的 finish_reason（"length" = 被 max_tokens 截断）。
  // 用途：结构化任务（大纲/小结）若因输出截断而 JSON 不完整，能给出「输出被截断」的
  // 明确提示，而不是笼统的「结果无法解析」—— 否则用户只能靠猜。宿主经 finishReason() 读。
  let lastFinishReason = null;

  /* 解析用户填的温度。注意：温度 0 是合法值，必须用 Number.isNaN 判、不能用 `|| 0.7` 吞掉。
   * 暴露给宿主是为了让「保存设置」与「发请求」共用同一处解析 —— 各写一份必然漂移
   * （持久化的是 0.7、发出去的是 0 这种）。 */
  function temperature() {
    const v = parseFloat(els.apiTemp.value);
    return Number.isNaN(v) ? 0.7 : v;
  }

  // 缓存命中验收器：stream / 非 stream 共用，统一打 [Socratopia][usage] 日志。
  // 在浏览器 DevTools Console 看命中率；>0 即说明 provider 的前缀缓存生效、省了 token。
  function logCacheUsage(u) {
    const pt = u.prompt_tokens || 0;
    const hit = (u.prompt_cache_hit_tokens != null) ? u.prompt_cache_hit_tokens
      : ((u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) != null ? u.prompt_tokens_details.cached_tokens
      : (u.cached_tokens != null ? u.cached_tokens : 0));
    const pct = pt ? Math.round((hit / pt) * 100) : 0;
    // 顺带把 completion_tokens 打出来：它是判断「回复为什么被截断」的第一手证据 ——
    // 若某个回复可见正文很短却吃掉了几千 completion_tokens，说明预算被**推理 token**
    // 消耗了（readSSE 不读 delta.reasoning_content，丢的只是显示，额度照样算）。
    const ct = (u.completion_tokens != null) ? u.completion_tokens : null;
    console.log("[Socratopia][usage] prompt_tokens=" + pt + " cache_hit_tokens=" + hit + " (" + pct + "%)" +
      (ct != null ? " completion_tokens=" + ct : ""));
    // 唯一的 usage 汇总出口：stream / 非 stream 都走这里，宿主据此累计「本次会话」用量。
    // 放在 logCacheUsage 里而不是各调用点，是为了不漏掉任何一条请求路径（chat / 大纲 / 群聊）。
    if (typeof onUsage === "function") {
      try { onUsage(u); } catch (e) { /* 统计不能影响主流程 */ }
    }
  }

  // 设置面板「🔌 测试连接」：发一条 max_tokens=1 的最小请求，按状态码给出明确诊断
  async function testConnection() {
    const base = els.apiBase.value.trim().replace(/\/+$/, "");
    const key = els.apiKey.value.trim();
    const model = els.apiModel.value.trim();
    if (!key) { alert("请先在上方填写 API Key，再点测试～"); return; }
    const btn = els.testConn;
    const oldLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "测试中…";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000); // 测试用较短超时
    try {
      const res = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
        body: JSON.stringify({ model: model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
        signal: ctrl.signal,
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const used = data && data.usage;
        alert("✅ 连接正常！模型「" + model + "」可正常响应" + (used && used.total_tokens != null ? "（本次约 " + used.total_tokens + " token）" : "") + "。");
      } else {
        const t = await res.text().catch(() => "");
        if (res.status === 401 || res.status === 403) {
          alert("✗ API Key 无效或额度用尽（HTTP " + res.status + "）。\n请检查 Key 是否复制完整，或到服务商控制台看余额。");
        } else if (res.status === 404) {
          alert("✗ 接口路径不对（HTTP 404）。\n请检查 Base URL：常见正确形式如 https://api.deepseek.com/v1（末尾带 /v1）。");
        } else if (res.status === 429) {
          alert("✗ 请求过于频繁或限流（HTTP 429），稍等片刻再试。");
        } else {
          alert("✗ 服务端返回 " + res.status + "：" + (t ? t.slice(0, 200) : "无详细信息") + "\n常见原因：模型名填错 / 该模型不可用。");
        }
      }
    } catch (e) {
      if (e && e.name === "AbortError") {
        alert("✗ 连接超时（15 秒无响应）。\n常见原因：baseUrl 拼写错误、网络无法访问该接口。");
      } else if (/fetch|Failed to fetch|NetworkError|ERR_/i.test(String((e && e.message) || e))) {
        alert("✗ 网络 / CORS 拦截：浏览器直连该接口被拒。\n建议：运行 start.bat 用本地服务打开 http://127.0.0.1:8199 再试。");
      } else {
        alert("✗ 连接失败：" + ((e && e.message) || e));
      }
    } finally {
      clearTimeout(timer);
      btn.disabled = false;
      btn.textContent = oldLabel;
    }
  }

  // SSE 解析：OpenAI 兼容接口（DeepSeek 等均支持）。逐行读取 data: 事件，累加 delta.content
  // 并通过 onToken 回调实时渲染；末块可能携带 usage（靠 stream_options.include_usage 索取）。
  // 健壮性：忽略非 JSON 控制行与 [DONE]；reader 抛错（含用户点停止的 AbortError）交给调用方 catch。
  async function readSSE(res, onToken, onUsageEvent) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    let sawFinish = false; // 是否见过结束标记（正常流的末块必带；从没见到 = 被中途掐断）
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let json;
        try { json = JSON.parse(data); } catch (e) { continue; }
        const fr = json.choices && json.choices[0] && json.choices[0].finish_reason;
        if (fr) {
          sawFinish = true;
          lastFinishReason = fr;
          if (fr === "length") console.warn("[Socratopia] 流式输出被 max_tokens 截断（finish_reason=length）。");
        }
        if (json.usage) { logCacheUsage(json.usage); if (onUsageEvent) onUsageEvent(json.usage); continue; }
        const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
        if (delta) { full += delta; onToken(delta); }
      }
    }
    /* 「静默半句」的第二种成因：流正常走到 done，却从没见过 finish_reason。
     * 正常结束的流，末块一定带 finish_reason（stop / length / tool_calls，OpenAI 兼容接口皆然）；
     * 一个都没有，说明服务商 / 网关 / 代理把 SSE 从中间掐断了 —— 连接是**正常关闭**的，
     * 既没抛异常、也没有结束标记，所以调用方的 catch 分支永远等不到。
     * 不在这里取证，上层拿到的半句话与完整回复就完全无法区分（chat 曾经就是这样：用户只看到
     * 半句，无从判断是模型、网络还是自己操作有误）。用 "incomplete" 与 "length" 区分：
     * 前者是传输被掐，后者是输出预算用尽 —— 两者的处置建议完全不同。 */
    if (!sawFinish && full) {
      lastFinishReason = "incomplete";
      console.warn("[Socratopia] 流式回复没有收到 finish_reason（疑被网络 / 网关提前掐断），内容可能不完整。");
    }
    return full;
  }

  /* 统一调用入口。
   * 超时预算（2026-09-12 修 B8）：原先写死 `API_TIMEOUT_MS = 300000`，与"所有时长/长度预算
   * 都应派生"的约定不符 —— 它只按"整书 prefill 慢"调过一次（180s→300s），而整书直读门槛
   * 随后从 8000 字抬到 192 000 字，超时再没复核过。现在按**该次请求的输出预算**派生：
   * 输出预算越大、等待越久（聊天 4096 ≈325s / 结构化 8192 ≈530s / 大纲 65536 → 上限 600s）。
   * 参数与推导见 config.js 的 apiTimeout 块，纯函数 apiTimeoutMs 在 js/core.js（有单测）。
   * 用户的「⏹ 停止」仍可随时提前中止，不受此预算影响。
   *
   * max_tokens 的保守退路（2026-09-10 修 B6）：provider 报「超出该模型输出上限」时降级重试。
   * 旧实现固定退到 8192，对整书大纲这种大输出任务仍可能截断；现在优先从报错里抠出
   * 「该模型支持的上限」直接退到它，抠不到再按减半阶梯试探（均在 core.js，有单测）。 */
  async function call(msgs, opts) {
    const base = els.apiBase.value.trim().replace(/\/+$/, "");
    const key = els.apiKey.value.trim();
    const model = els.apiModel.value.trim();
    const temp = temperature();
    if (!key) { alert("先去 ⚙️ 设置 里填 API Key～"); throw new Error("未填 API Key"); }
    lastFinishReason = null; // 每次调用先清空，避免读到上一次的残留
    const url = base + "/chat/completions";
    const slot = (opts && opts.slot) || "chat"; // 见 ctrlBySlot 的说明
    const ctrl = new AbortController();
    ctrlBySlot.set(slot, ctrl);
    inFlight++;
    if (els.stopBtn) els.stopBtn.style.display = "inline-block"; // 请求进行中显示「⏹ 停止」
    const timer = setTimeout(() => ctrl.abort(), apiTimeoutMs(opts && opts.maxTokens, config.apiTimeout));
    try {
      const payload = { model: model, temperature: temp, messages: msgs };
      // 大输出任务（如长书大纲综合要一次性吐整本书章节）显式放宽输出上限，
      // 避免模型 JSON 吐到一半被默认 max_tokens 截断 → 解析失败 → 兜底成“分段草稿”。
      if (opts && opts.maxTokens) payload.max_tokens = opts.maxTokens;
      // 流式：逐 token 返回，首字即现、长回复不再干等；同时请求末块携带 usage 以便缓存命中验收。
      // 端点不支持时自动退回整段解析（见下方 content-type 判断），不会因此失效。
      const wantStream = !!(opts && opts.stream && opts.onToken);
      if (wantStream) { payload.stream = true; payload.stream_options = { include_usage: true }; }
      let res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let t = await res.text().catch(() => "");
        // 降级重试：config.maxOutputTokens 是按「大输出模型」设的，若用户填的模型
        // 输出上限更小（常见 8K/16K），provider 会直接 400。这里按阶梯退到更保守的值重试，
        // 避免「为修截断而抬高输出预算」反而让小模型彻底用不了。
        const isTooLargeErr = () => res.status === 400 && payload.max_tokens &&
          /max_tokens|max output|maximum output|less than or equal|输出|上限/i.test(t);
        if (isTooLargeErr()) {
          // B6：优先直接退到报错里声明的模型上限；否则逐级减半试探。
          const requested = payload.max_tokens;
          const stated = extractMaxTokensCap(t);
          const chain = [];
          if (stated && stated < requested) chain.push(stated);
          for (const cap of maxTokensFallbackChain(requested)) {
            if (cap < (chain.length ? chain[chain.length - 1] : requested)) chain.push(cap);
          }
          for (const cap of chain) {
            console.warn("[Socratopia] max_tokens=" + payload.max_tokens + " 超出该模型能力，降级到 " + cap + " 重试。");
            payload.max_tokens = cap;
            res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
              body: JSON.stringify(payload),
              signal: ctrl.signal,
            });
            if (res.ok) break;
            t = await res.text().catch(() => "");
            if (!isTooLargeErr()) break; // 已不是「输出上限」类错误 → 不再无谓重试
          }
        }
        if (!res.ok) throw new Error("接口返回 " + res.status + (t ? "：" + t.slice(0, 300) : ""));
      }
      // 流式分支：只有 provider 真正返回 SSE（content-type: text/event-stream）才走逐 token 解析；
      // 若端点忽略 stream 标志、回的是普通 JSON，就自动退回整段解析，功能不受影响。
      const isSSE = (res.headers.get("content-type") || "").indexOf("text/event-stream") >= 0;
      if (wantStream && isSSE && res.body) {
        return await readSSE(res, opts.onToken, (opts && opts.onUsage) || null);
      }
      const data = await res.json();
      if (data && data.usage) logCacheUsage(data.usage);
      const ch0 = data.choices && data.choices[0];
      lastFinishReason = (ch0 && ch0.finish_reason) || null;
      if (lastFinishReason === "length") {
        console.warn("[Socratopia] 输出被 max_tokens 截断（finish_reason=length）：结构化任务可能解析失败，请调大 config.maxOutputTokens。");
      }
      return (ch0 && ch0.message && ch0.message.content) || "";
    } finally {
      clearTimeout(timer);
      // 只有当槽位里还是自己时才清（否则会把同槽位后来者的控制器抹掉）
      if (ctrlBySlot.get(slot) === ctrl) ctrlBySlot.delete(slot);
      inFlight = Math.max(0, inFlight - 1);
      // 只有【所有】请求都结束才收起按钮。原先是无条件 "none" —— 先返回的请求会把仍在跑的
      // 那个请求的停止按钮藏掉，用户就再也停不下那次生成。
      if (els.stopBtn && inFlight === 0) els.stopBtn.style.display = "none";
    }
  }

  // 带重试的调用：长书分块生成大纲时会串行发几十个请求，API 偶发限流/网络抖动不应直接让
  // 整本大纲失败。tries 次内任意一次成功即返回；全部失败才抛出最后一次的错误（文案由调用方 toast）。
  async function callWithRetry(msgs, tries, opts) {
    tries = tries || 2;
    let lastErr;
    for (let k = 0; k < tries; k++) {
      try { return await call(msgs, opts); }
      catch (e) {
        // B10（2026-09-12）：用户主动中止（⏹ 停止 → abort）**不得**当作"失败"重试。
        // 旧实现不看错误类型，于是"停止"反而触发一次新请求（还弹「重试中」）——
        // 用户点了停止、界面却继续打 API，是彻头彻尾的言行不一。直接抛出，由调用方按"已取消"处理。
        if (e && e.name === "AbortError") throw e;
        lastErr = e;
        if (k < tries - 1) {
          toast("大纲分块请求重试中（" + (k + 1) + "/" + (tries - 1) + "）…", 1500);
          await new Promise((r) => setTimeout(r, 1500 * (k + 1)));
        }
      }
    }
    throw lastErr;
  }

  /** 「⏹ 停止」的统一出口：中止正在进行的请求（会话中的请求随即抛 AbortError） */
  function abort(slot) {
    let c = slot ? ctrlBySlot.get(slot) : null;
    // 指定来源没有在飞请求时【退化为中止最新的那个】—— 三个停止按钮的可见性看的是
    // "有没有任意请求在飞"，若此处直接返回，就会出现"按钮在、点了没反应"的死按钮。
    if (!c && ctrlBySlot.size) c = Array.from(ctrlBySlot.values()).pop();
    if (c) c.abort();
  }

  // 20260913：不再对外导出 logCacheUsage（函数本身保留，仍在 call 内部被调用）。
  return { call, callWithRetry, testConnection, abort, temperature, finishReason: () => lastFinishReason };
}
