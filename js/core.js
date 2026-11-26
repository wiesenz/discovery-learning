/* =====================================================================
 *  Socratopia v0 · 纯函数核心（js/core.js）
 *  ---------------------------------------------------------------------
 *  这里只放「无 DOM 依赖、可独立测试」的纯函数：
 *    - estimateTokens          粗略 token 估算
 *    - truncateMaterialInPrompt 系统提示词内材料段截断（上下文窗口保护）
 *    - parseLessonJson         解析「下课小结」严格 JSON（多策略容错）
 *    - parseOutlineJson        解析「大纲」严格 JSON
 *    - friendlyApiError        统一 API 错误文案（AbortError 给出友好提示）
 *
 *  浏览器里通过 <script> 标签加载，挂在 window.SocratopiaCore 上；
 *  同时兼容 Node（module.exports），方便跑 js/core.test.js 单元测试。
 *  这样 app.js 调用它们时无需关心运行环境。
 * ===================================================================== */
(function (root) {
  "use strict";

  // 粗略 token 估算：中文约 1.6 字/token
  function estimateTokens(str) {
    if (!str) return 0;
    return Math.ceil((str.length || 0) / 1.6);
  }

  // 在系统提示词文本中找到材料段（<<<<<< ... >>>>>>）并截断到目标 token 数以内
  function truncateMaterialInPrompt(promptText, maxTok) {
    const fence = /<<<<<<\n([\s\S]*?)\n>>>>>>/;
    const match = promptText.match(fence);
    if (!match) return promptText; // 没有材料段，无法截断
    const materialPart = match[1];
    const nonMaterialTok = estimateTokens(promptText.replace(fence, ""));
    if (nonMaterialTok >= maxTok) return promptText; // 非材料部分就已经超了，截材料没用
    const budgetTok = maxTok - nonMaterialTok;
    const maxChars = Math.max(500, Math.floor(budgetTok * 1.6)); // token→字 反算
    if (materialPart.length <= maxChars) return promptText; // 材料没超
    const truncated = materialPart.slice(0, maxChars) +
      "\n\n（…材料较长，发送前已自动截断以适配上下文窗口。完整材料会在课时模式下按切片使用。）";
    return promptText.replace(fence, "<<<<\n" + truncated + "\n>>>>>>");
  }

  // 解析「下课小结」JSON（多策略容错，模型偶尔会夹带代码块/尾逗号/注释/截断）
  function parseLessonJson(text) {
    if (!text) return null;
    let t = text.trim();
    // 策略1：提取 markdown 代码块内的 JSON
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) { t = fence[1].trim(); }
    // 策略2：清理常见干扰（BOM、零宽字符、\r）
    t = t.replace(/\ufeff/g, "").replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, "").replace(/\r/g, "");

    // 策略3：尝试匹配最外层完整 { ... }（避免 first { 到 last } 截断不完整）
    function extractBalanced(s) {
      let depth = 0, start = -1;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"') { // 跳过字符串内容
          i++;
          while (i < s.length) {
            if (s[i] === '\\' && i + 1 < s.length) { i += 2; continue; }
            if (s[i] === '"') break;
            i++;
          }
          continue;
        }
        if (ch === '{') { if (depth === 0) start = i; depth++; }
        else if (ch === '}') { depth--; if (depth === 0 && start >= 0) return s.slice(start, i + 1); }
      }
      return null;
    }
    const balanced = extractBalanced(t);
    if (balanced) t = balanced;

    // 策略4：直接解析 + 修复尾逗号
    function tryParse(s) {
      try { return JSON.parse(s); } catch (_) {}
      try { return JSON.parse(s.replace(/,\s*([}\]])/g, "$1")); } catch (_) {}
      return null;
    }
    const parsed = tryParse(t);
    if (parsed && typeof parsed === "object" && ("summary" in parsed)) {
      return parsed;
    }

    // 策略5：正则暴力提取关键字段（即使整体 JSON 无法解析）
    function unescapeJsonString(s) {
      if (s == null) return "";
      return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    function extractField(name) {
      // 在 t 中定位 "name": 后面的 value，并用平衡匹配/字符串转义规则提取
      const keyRe = new RegExp('"' + name + '"\\s*:', "i");
      const m = t.match(keyRe);
      if (!m) return undefined;
      let i = m.index + m[0].length;
      while (i < t.length && /\s/.test(t[i])) i++;
      if (i >= t.length) return undefined;
      const ch = t[i];
      // 字符串
      if (ch === '"') {
        let j = i + 1;
        while (j < t.length) {
          if (t[j] === '\\' && j + 1 < t.length) { j += 2; continue; }
          if (t[j] === '"') break;
          j++;
        }
        const raw = t.slice(i + 1, j);
        return unescapeJsonString(raw);
      }
      // 数组 / 对象：平衡匹配
      if (ch === '[' || ch === '{') {
        const close = ch === '[' ? ']' : '}';
        let depth = 1, j = i + 1;
        while (j < t.length && depth > 0) {
          if (t[j] === '"') {
            j++;
            while (j < t.length) {
              if (t[j] === '\\' && j + 1 < t.length) { j += 2; continue; }
              if (t[j] === '"') break;
              j++;
            }
          }
          if (t[j] === ch) depth++;
          else if (t[j] === close) depth--;
          j++;
        }
        try { return JSON.parse(t.slice(i, j)); } catch (_) { return undefined; }
      }
      // 数字 / 布尔 / null：读到下一个分隔符
      let j = i;
      while (j < t.length && !/[,}\]\s]/.test(t[j])) j++;
      const v = t.slice(i, j).trim();
      if (v === "true") return true;
      if (v === "false") return false;
      if (v === "null") return null;
      if (/^-?\d+(?:\.\d+)?$/.test(v)) return parseFloat(v);
      return undefined;
    }
    const summaryMatch = t.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (summaryMatch || /"summary"\s*:/.test(t)) {
      const out = { summary: summaryMatch ? unescapeJsonString(summaryMatch[1]) : "" };
      const quiz = extractField("quiz");
      if (Array.isArray(quiz)) out.quiz = quiz;
      const memory = extractField("memory");
      if (memory && typeof memory === "object") out.memory = memory;
      const notes = extractField("notes");
      if (notes && typeof notes === "object") out.notes = notes;
      return out;
    }
    return null;
  }

  // 解析「大纲」JSON
  function parseOutlineJson(text) {
    if (!text) return null;
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const s = t.indexOf("{"); const e = t.lastIndexOf("}");
    if (s >= 0 && e > s) t = t.slice(s, e + 1);
    try {
      const o = JSON.parse(t);
      if (o && o.chapters) return o;
    } catch (_) {}
    return null;
  }

  // 解析「角色设定师」输出的严格 JSON（新建角色时「自动补全人设」用）。
  // 成功条件：至少含 persona 或 voice 之一。返回规范化对象
  //   { persona, voice, openingLine, userAlias, thinkingPhrases }
  // 其余字段容错处理（非字符串/数组置空），避免模型偶尔夹带文字 / 代码块 / 尾逗号时失败。
  function parseRoleJson(text) {
    if (!text) return null;
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    t = t.replace(/\ufeff/g, "").replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, "").replace(/\r/g, "");

    // 平衡匹配提取最外层 { ... }（跳过字符串内的转义与括号）
    let depth = 0, start = -1;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === '"') {
        i++;
        while (i < t.length) {
          if (t[i] === '\\' && i + 1 < t.length) { i += 2; continue; }
          if (t[i] === '"') break;
          i++;
        }
        continue;
      }
      if (ch === '{') { if (depth === 0) start = i; depth++; }
      else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { t = t.slice(start, i + 1); break; } }
    }

    let parsed = null;
    try { parsed = JSON.parse(t); } catch (_) {}
    if (!parsed) { try { parsed = JSON.parse(t.replace(/,\s*([}\]])/g, "$1")); } catch (_) {} }
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.persona && !parsed.voice) return null;

    const str = (v) => (typeof v === "string" && v.trim()) ? v.trim() : "";
    const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x == null ? "" : x).trim()).filter(Boolean) : []);
    return {
      persona: str(parsed.persona),
      voice: str(parsed.voice),
      openingLine: str(parsed.openingLine),
      userAlias: str(parsed.userAlias),
      thinkingPhrases: arr(parsed.thinkingPhrases),
    };
  }

  // 统一 API 错误文案：AbortError（点停止 / 超时）给友好提示，其余回退到 message
  function friendlyApiError(e) {
    if (e && e.name === "AbortError") return "已停止（点击了「⏹ 停止」或请求超时）";
    return (e && e.message) ? e.message : String(e);
  }

  // ---- 锚点校验 + 块级锚定传递（零 token，纯前端）----
  // 大纲生成后，indexChapterPositions 仅按章标题在原文里 indexOf 定位；标题匹配不上时退回比例均分，
  // 导致部分课时的材料切片可能根本不含本课知识点（"装错位置"）。
  // 这里用课时自身的 title/focus/keyPoints 作为"锚点短语"，在【所属章的字符区间】内回搜原文，
  // 把课时的 _charStart/_charEnd 重新吸附到知识点真正所在的区段；搜不到则保留 indexChapterPositions 的结果。
  // 返回 outline（原地修改课时/章的 _charStart/_charEnd/_anchored）。
  function findAnchorInRegion(region, phrase) {
    const s = (phrase == null ? "" : String(phrase)).trim();
    if (!s) return -1;
    // 先整串匹配；匹配不上则逐级缩短前缀（中文最小 4 字），越长的匹配越可信，命中即返回。
    let p = region.indexOf(s);
    if (p >= 0) return p;
    for (let len = s.length - 1; len >= 4; len--) {
      const pre = s.slice(0, len);
      p = region.indexOf(pre);
      if (p >= 0) return p;
    }
    return -1;
  }
  function reanchorLessonsByContent(material, outline) {
    if (!material || !outline || !outline.chapters) return outline;
    const mat = material;
    const MARGIN_BEFORE = 600;  // 课时切片前需要的上下文（略少）
    const MARGIN_AFTER = 1400;  // 论证多向后推进，后文上下文略多
    outline.chapters.forEach((ch) => {
      const cs = (typeof ch._charStart === "number") ? ch._charStart : 0;
      const ce = (typeof ch._charEnd === "number") ? ch._charEnd : mat.length;
      const lessons = ch.lessons || [];
      lessons.forEach((ls) => {
        // 已在 indexLessonPositions 中精确定位过的（用「均分先验 + 就近命中」选锚，
        // 抗同一概念重复出现导致的误命中）→ 不再覆盖，reanchor 只做定位失败时的补位，
        // 避免两套定位逻辑互相打架、把已经对准的课时又拉回去。
        if (ls._located === true) return;
        const phrases = [];
        if (ls.title) phrases.push(ls.title);
        if (ls.focus) phrases.push(ls.focus);
        (ls.keyPoints || []).forEach((k) => { if (k) phrases.push(k); });
        const region = mat.slice(cs, ce);
        const offsets = [];
        phrases.forEach((p) => {
          const pos = findAnchorInRegion(region, p);
          if (pos >= 0) offsets.push(cs + pos);
        });
        if (offsets.length) {
          const lo = Math.max(cs, Math.min.apply(null, offsets) - MARGIN_BEFORE);
          const hi = Math.min(ce, Math.max.apply(null, offsets) + MARGIN_AFTER);
          if (hi - lo > 1) {
            ls._charStart = lo;
            ls._charEnd = hi;
            ls._anchored = true;
            ls._located = true; // 与 indexLessonPositions 同一语义：本课时区间已内容定位
          }
        }
      });
      // 章内课时单调化 + 与章边界对齐（保证切片连续无重叠、不越章）
      let prev = cs;
      lessons.forEach((ls) => {
        if (typeof ls._charStart !== "number") ls._charStart = prev;
        if (typeof ls._charEnd !== "number") ls._charEnd = ce;
        if (ls._charStart < prev) ls._charStart = prev;
        if (ls._charEnd <= ls._charStart) ls._charEnd = Math.min(ce, ls._charStart + 1);
        prev = ls._charEnd;
      });
      // 填缝：仅对"被重新吸附"的课时，把其 end 延伸到下一课 start，
      // 避免两课锚点之间的过渡/论证段落落入无人认领的间隙（旧比例均分本是无缝的）。
      // 未被吸附的课时沿用比例均分结果，不在此动它。
      for (let i = 0; i < lessons.length; i++) {
        if (lessons[i]._anchored !== true) continue;
        const nextStart = (i + 1 < lessons.length) ? lessons[i + 1]._charStart : ce;
        if (typeof nextStart === "number" && lessons[i]._charEnd < nextStart) lessons[i]._charEnd = nextStart;
      }
      if (lessons.length) lessons[lessons.length - 1]._charEnd = ce;
    });
    return outline;
  }

  // ---- 知识点短语归一化（交卷时把题目 kp 对齐到本课 keyPoints 原词）----
  // 题目 kp 可能写成 "稀缺心态的三个特征" 而本课 keyPoints 里是 "稀缺心态"，
  // 直接当键会碎成两条 keypointStats。这里模糊归并到最贴近的候选原词。
  function lcsLen(a, b) {
    const m = a.length, n = b.length;
    if (m === 0 || n === 0) return 0;
    const dp = new Array(n + 1).fill(0);
    for (let i = 1; i <= m; i++) {
      let prev = 0;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        if (a[i - 1] === b[j - 1]) dp[j] = prev + 1;
        else dp[j] = Math.max(dp[j], dp[j - 1]);
        prev = tmp;
      }
    }
    return dp[n];
  }
  function normalizeKpToLesson(kp, candidates) {
    const s = (kp == null ? "" : String(kp)).trim();
    if (!s) return s;
    const cands = (candidates || []).map((c) => String(c == null ? "" : c).trim()).filter(Boolean);
    if (!cands.length) return s;
    const exact = cands.find((c) => c === s);
    if (exact) return exact; // 完全相同 → 直接归并
    let best = null, bestScore = 0;
    for (const c of cands) {
      let score = 0;
      if (s.indexOf(c) >= 0) score = 0.6 + 0.4 * (c.length / s.length);       // 候选是 kp 子串 → 归并到更短规范短语
      else if (c.indexOf(s) >= 0) score = 0.6 + 0.4 * (s.length / c.length);   // kp 是候选子串 → 归并到本课 keyPoint
      else {
        const ratio = lcsLen(s, c) / Math.max(s.length, c.length);
        if (ratio >= 0.5) score = ratio; // 部分重叠（无包含关系）按最长公共子串占比
      }
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best || s;
  }

  // ---- 间隔复习校准（纯函数，供单测）----
  // 测验答对率按指数移动平均滚进书级 quizScore：小样本（如 3 题）的抖动被天然阻尼——每次只走一半
  function emaQuizScore(prev, accRate) {
    const r = Number(accRate);
    if (!isFinite(r) || r < 0 || r > 1) return (prev != null && isFinite(prev)) ? prev : null;
    if (prev == null || !isFinite(prev)) return Math.round(r * 100) / 100;
    return Math.round((prev * 0.5 + r * 0.5) * 100) / 100;
  }
  // 融合掌握分：有测验实测（quizScore）时 0.7 实测 + 0.3 老师主观分；无实测时纯主观分（缺失按 0.5 兜底）
  function fusedMasteryScore(teachScore, quizScore) {
    const t = (teachScore != null && isFinite(teachScore)) ? teachScore : 0.5;
    if (quizScore == null || !isFinite(quizScore)) return t;
    return Math.round((quizScore * 0.7 + t * 0.3) * 100) / 100;
  }

  // ---- 随堂测验 answer 归一化（纯函数）----
  // 模型契约是「正确选项索引 0=A..3=D」，但偶发会返回字母 "A" 或 "1"~"4"。
  // 若不归一化，picked[i] !== it.answer 会恒为真 → 整份测验误判错，进而污染掌握度 / 错题本。
  // 这里把 answer 统一钳制成合法整数索引（越界钳到最后一个有效选项）。
  function ensureQuizAnswers(quiz) {
    if (!Array.isArray(quiz)) return [];
    return quiz.map((it) => {
      if (!it || !Array.isArray(it.choices) || !it.choices.length) return it;
      const n = it.choices.length;
      let a = it.answer;
      if (typeof a === "string") {
        const up = a.trim().toUpperCase();
        if (/^[A-Z]$/.test(up)) a = up.charCodeAt(0) - 65;        // "A".."D" → 0..3
        else { const num = parseInt(up, 10); a = isNaN(num) ? 0 : num - 1; } // "1".."4" → 0..3
      }
      a = parseInt(a, 10);
      if (isNaN(a) || a < 0) a = 0;
      if (a >= n) a = n - 1; // 越界钳制到最后一个有效选项
      return Object.assign({}, it, { answer: a });
    });
  }

  // ---- HTML 转义（全站唯一入口，纯函数）----
  // 任何进入 innerHTML 的动态文本都必须先过这里。20260907 从 app.js 的 IIFE 下沉到这里：
  // 一是遵守 README「纯逻辑优先放 core.js，保持可单测」公约；二是让转义行为被单元测试锁死，
  // 防止日后有人为了「更干净」而删掉某个字符的转义，悄悄开出 XSS 口子。
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- max_tokens 降级重试（provider 拒绝过大输出上限时的退路）----
  // 2026-09-10 修 B6：旧实现固定退到 8192 —— 对「整书大纲」这类大输出任务可能仍不够，
  // JSON 依旧会被截断。改为按请求值逐级减半（下限 4096），尽量保住该模型真正支持的
  // 最大输出（如 16K / 32K），而不是一刀切到 8K。
  function maxTokensFallbackChain(requested) {
    const req = Number(requested);
    if (!isFinite(req) || req <= 4096) return [4096];
    const chain = [];
    let v = Math.floor(req / 2);
    while (v > 4096) { chain.push(v); v = Math.floor(v / 2); }
    if (chain[chain.length - 1] !== 4096) chain.push(4096);
    return chain;
  }

  // ---- 单次请求的超时预算（2026-09-12 修 B8）----
  // 生成耗时 ∝ 输出 token 数，而各调用点的输出预算相差 16 倍：
  //   聊天（不传预算 → provider 默认 4096）/ 结构化 JSON 8192 / 大纲 65536。
  // 旧实现全用一个写死的 300s（app.js 的 API_TIMEOUT_MS），只按"整书 prefill 慢"调过一次
  // 180s→300s；但整书直读门槛随后从 8000 字抬到 192,000 字（24 倍），超时再没复核过 ——
  // 与「时长/长度预算都应派生」的约定不符。模型慢时（推理型 10~20 token/s），
  // 65536 token 的产出需要 3000s 以上，会在 5 分钟被 abort，用户看到的是"生成失败"。
  // 这里按「基础开销 + 输出预算 / 保守生成速度」派生，并夹在 [baseMs, capMs] 内。
  // maxTokens 缺省（聊天类未传预算）按 provider 默认 4096 计，避免小输出任务被误配长超时。
  function apiTimeoutMs(maxTokens, cfg) {
    const c = (cfg && typeof cfg === "object") ? cfg : {};
    const num = (v, d) => ((typeof v === "number" && isFinite(v) && v > 0) ? v : d);
    const base = num(c.baseMs, 120000);
    const perTok = num(c.perTokMs, 50);
    const cap = Math.max(base, num(c.capMs, 600000));
    const tok = num(maxTokens, 4096);
    return Math.max(base, Math.min(cap, base + Math.round(tok * perTok)));
  }

  // 从 provider 的 400 报错文本里尝试抠出「该模型支持的最大输出 token」。
  // 命中就直接退到它，省掉逐级试探的多次请求；抠不到返回 null，由调用方用阶梯兜底。
  // 只认「at most / maximum / up to / 最大 / 上限」这类**上限**措辞，
  // 刻意不认裸 "max_tokens" —— 那会命中我们自己请求的那个过大值
  // （如 DeepSeek: "max_tokens is too large: 65536"），退等于没退。
  function extractMaxTokensCap(text) {
    if (!text || typeof text !== "string") return null;
    // 覆盖主流 provider 的措辞：DeepSeek/OpenAI「must be less than or equal to N」
    // 「supports at most N」，以及中文「最大支持 N / 上限 N」。
    const m = text.match(/(?:at most|maximum|up to|no more than|less than or equal to|最大(?:支持)?|上限|≤|<=)[^0-9]{0,16}(\d{3,7})/i);
    if (!m) return null;
    const v = parseInt(m[1], 10);
    return (isFinite(v) && v >= 1024) ? v : null;
  }

  // ---- 原文高亮分段（「查看原文」用：课时区段标记 + 查找命中标记）----
  // 把若干「待高亮区间」铺成一条**不重叠、按序铺满全文**的分段序列，供 UI 逐段
  // 生成 textNode / <mark>。之所以下沉成纯函数：区间会重叠（课时区段里可能又命中查找词）、
  // 会乱序、会越界（旧大纲坐标来自别的算法版本），这些边界情况最容易写错，
  // 而它们又只在真跑时才暴露 —— 放进 core.js 才能被单测钉住。
  //
  // ranges: [{ start, end, kind, priority }]，坐标为相对 text 的偏移。
  // 重叠裁决：priority 大者胜（同 priority 取先传入者）。查找命中(2) 因此在课时标记(1) 之上。
  // 返回:   [{ text, kind }]，kind=null 为普通文本；相邻同 kind 已合并。
  function buildHighlightSegments(text, ranges) {
    const s = (typeof text === "string") ? text : "";
    const len = s.length;
    if (!len) return [];

    const list = [];
    (Array.isArray(ranges) ? ranges : []).forEach((r, i) => {
      if (!r) return;
      const a0 = Math.floor(Number(r.start));
      const b0 = Math.floor(Number(r.end));
      if (!isFinite(a0) || !isFinite(b0)) return;       // 缺失/非数字 → 丢弃，不猜
      const a = Math.max(0, Math.min(len, a0));         // 越界钳制（旧坐标可能超出当前文本）
      const b = Math.max(0, Math.min(len, b0));
      if (b <= a) return;                                // 空区间
      const pr = Number(r.priority);
      list.push({ start: a, end: b, kind: r.kind || "mark", priority: isFinite(pr) ? pr : 0, seq: i });
    });
    if (!list.length) return [{ text: s, kind: null }];

    // 只在区间端点处切分，逐段选「覆盖它的最高优先级区间」，避免为裁决重叠而整体重排。
    const cut = new Set([0, len]);
    list.forEach((r) => { cut.add(r.start); cut.add(r.end); });
    const pts = Array.from(cut).sort((x, y) => x - y);

    const out = [];
    const push = (txt, kind) => {
      if (!txt) return;
      const last = out[out.length - 1];
      if (last && last.kind === kind) last.text += txt;
      else out.push({ text: txt, kind: kind });
    };
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      let best = null;
      for (const r of list) {
        if (r.start <= a && r.end >= b &&
            (!best || r.priority > best.priority || (r.priority === best.priority && r.seq < best.seq))) {
          best = r;
        }
      }
      push(s.slice(a, b), best ? best.kind : null);
    }
    return out;
  }

  // 在 text 中查找 query 的全部出现位置（大小写不敏感），最多 max 条。
  // 上限是必要的：一章可达数十万字，找一个常用字会命中上万次 —— 无上限会生成
  // 上万个 <mark> 把页面拖死。返回 [{ start, end }]，坐标为相对 text 的偏移。
  function findTextMatches(text, query, max) {
    const s = (typeof text === "string") ? text : "";
    const q = (typeof query === "string") ? query : "";
    if (!q || !s) return [];
    const cap = (isFinite(Number(max)) && Number(max) > 0) ? Math.floor(Number(max)) : 500;

    const hay = s.toLowerCase();
    const needle = q.toLowerCase();
    // 大小写折叠可能改变长度（极少数 Unicode 字符，如 'İ'）→ 坐标会错位，
    // 此时退回大小写敏感查找，宁可少匹配也不能标错位置。
    const folded = (hay.length === s.length && needle.length === q.length);
    const H = folded ? hay : s;
    const N = folded ? needle : q;

    const res = [];
    let p = H.indexOf(N);
    while (p >= 0 && res.length < cap) {
      res.push({ start: p, end: p + N.length });
      p = H.indexOf(N, p + N.length);   // 不重叠推进，避免 "aa" 在 "aaa" 里叠出嵌套标记
    }
    return res;
  }

  /* 组装 chat 请求的消息数组（20261126 新增）。
   * ---------------------------------------------------------------------
   * 这是「前缀缓存命中率」唯一能由代码决定的地方，所以单独成纯函数、钉进单测。
   *
   * 背景：OpenAI 兼容接口的缓存都是「从第 0 个 token 起完全相同的前缀」才算命中
   * （DeepSeek / OpenAI / 智谱 / 通义 / 硅基流动皆然），中间或局部相同一律算 miss。
   *
   * 两种布局：
   *   "head"（旧行为 / 兼容模式）
   *     [静态 system][易变 system][历史…]
   *     易变段（教学策略建议等）每轮都变 → 从它往后【历史整段 miss】。
   *
   *   "tail"（默认，缓存最优）
   *     [静态 system][历史…][易变 system][本轮用户消息]
   *     易变段挪到历史之后 → 前缀覆盖「静态段 + 到上一轮为止的全部历史」。
   *
   * 为什么插在「最后一条 user 之前」而不是「整个数组末尾」：
   *   · 末尾追加会形成「尾随 system」，部分服务商（如 GLM 系）会拒收 ——
   *     宁可少缓存最后一条用户消息（百来个 token），也不制造兼容风险；
   *   · 顺带把「本轮教学策略」贴到学习者最新发言旁边，遵循度比埋在一堆 system 里更好。
   *
   * 找不到 user 消息（脏数据）时退化为 head 布局，绝不输出尾随 system。
   *
   * @param {{staticSystem?:string, dynamicSystem?:string, systemNote?:string,
   *          hist?:Array, layout?:string}} opts
   * @returns {{msgs:Array, tailPlaced:boolean}} tailPlaced=false 表示实际走了 head 布局
   */
  function assembleChatMessages(opts) {
    const o = opts || {};
    const stat = o.staticSystem || "";
    const dyn = o.dynamicSystem || "";
    const note = o.systemNote || "";
    const hist = Array.isArray(o.hist) ? o.hist.slice() : [];
    const layout = o.layout === "head" ? "head" : "tail";

    const head = stat ? [{ role: "system", content: stat }] : [];
    // 顺序沿用旧实现：先动态段、后提示注（head 布局下才与旧 payload 逐字节一致）
    const tail = [];
    if (dyn) tail.push({ role: "system", content: dyn });
    if (note) tail.push({ role: "system", content: note });

    if (!tail.length) return { msgs: head.concat(hist), tailPlaced: false };
    if (layout === "head") return { msgs: head.concat(tail, hist), tailPlaced: false };

    let at = -1;
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i] && hist[i].role === "user") { at = i; break; }
    }
    if (at < 0) return { msgs: head.concat(tail, hist), tailPlaced: false };
    return { msgs: head.concat(hist.slice(0, at), tail, hist.slice(at)), tailPlaced: true };
  }

  const SocratopiaCore = {
    estimateTokens: estimateTokens,
    assembleChatMessages: assembleChatMessages,
    truncateMaterialInPrompt: truncateMaterialInPrompt,
    parseLessonJson: parseLessonJson,
    parseOutlineJson: parseOutlineJson,
    parseRoleJson: parseRoleJson,
    friendlyApiError: friendlyApiError,
    reanchorLessonsByContent: reanchorLessonsByContent,
    // 20260913：findAnchorInRegion / lcsLen 不再挂到全局导出面上 —— 它们是
    // reanchorLessonsByContent 与 normalizeKpToLesson 的内部实现细节，从未被外部消费。
    // （核对过：app.js 只解构 17 个名字，不含这两个；js/core.test.js 也不引用。）
    // 函数本身保留在本文件内，去掉的只是"对外的承诺"。核心.js 是 UMD 全局，
    // 挂在 window 上的每个键都会被误读成受支持的 API，所以这里收紧。
    normalizeKpToLesson: normalizeKpToLesson,
    emaQuizScore: emaQuizScore,
    fusedMasteryScore: fusedMasteryScore,
    ensureQuizAnswers: ensureQuizAnswers,
    escapeHtml: escapeHtml,
    maxTokensFallbackChain: maxTokensFallbackChain,
    extractMaxTokensCap: extractMaxTokensCap,
    apiTimeoutMs: apiTimeoutMs,
    buildHighlightSegments: buildHighlightSegments,
    findTextMatches: findTextMatches,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = SocratopiaCore;
  root.SocratopiaCore = SocratopiaCore;
})(typeof window !== "undefined" ? window : globalThis);
