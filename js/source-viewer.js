/* =====================================================================
 *  Socratopia v0 · 查看原文浮层（只读浏览，零 token）
 *  20260910.1 从 app.js 抽出（技术债拆分第五刀，app.js 逼近 4300 行红线）。
 *
 *  设计：与 group.js / quiz.js 同构 —— 本模块不直接读写 app.js 的模块级状态。
 *  浮层自己的状态（查找词 / 命中集 / 当前高亮课时 / 当前章序号）收敛在
 *  createSourceViewer() 闭包内，宿主能力（教材库、落盘、章位置索引、
 *  高亮分段与文本检索纯函数）一律走 deps 注入。
 *
 *  粒度说明：章边界是原文里真实存在的标题（定位得到），所以按章切片是忠实于原文的；
 *  而课时边界在大纲里只是知识点的划分，原文中未必有对应小标题，硬切会切在半句中间。
 *  因此**切片仍按章**；课时坐标（indexLessonPositions 已算好）只用于「在本章里
 *  高亮该课时的区段并滚动过去」——既不让用户自己翻半天，也不会切出半句话。
 *
 *  用法：
 *    const sourceViewer = createSourceViewer({ els, S, saveLibrary, ... });
 *    sourceViewer.open(bookId);          // 点课程卡「📄」
 *    sourceViewer.open(bookId, lessonId); // 点课时「📄」→ 打开并高亮该节
 * ===================================================================== */

export function createSourceViewer(deps) {
  const {
    els,                    // { sourceOverlay, sourceTitle, sourceSub, sourceLessonSelect,
                            //   sourceText, closeSource, sourceFindInput, sourceFindCount,
                            //   sourceFindPrev, sourceFindNext, sourceFindClear }
    // 20260913 收窄：此前整包交 store 状态 `S`，而本模块只读三样东西。
    // 整包授权意味着"查看原文"这个纯只读浮层也能写 classroom 的全部状态
    // （store 是裸对象、无读写拦截），与"只读浏览"的定位不符。
    getLibrary,             // () => 教材库数组（只读遍历）
    getActiveSessionBookId, // () => 正在上课的课程 id | null
    getCurrentLessonId,     // () => 正在上的课时 id | null
    saveLibrary,            // () => void，索引现算后持久化
    indexChapterPositions,  // (material, outline) => void，纯函数，零 token
    needsReindex,           // (outline) => boolean，算法版本落后 / 坐标缺失
    buildHighlightSegments, // (text, ranges) => [{text, kind}]，分段渲染纯函数（core.js）
    findTextMatches,        // (text, query, max) => [{start, end}]，检索纯函数（core.js）
  } = deps;

  const SOURCE_FIND_MAX = 300; // 整章可达数十万字，命中上限防止生成上万个 <mark>
  const sourceFind = { query: "", index: 0, total: 0, hits: [] };
  // 高亮哪一节课：lid=课时 id；from 记录来源（open=点课时📄 / click=点原文反查 / select=切章）
  const sourceHighlight = { lid: null, title: "", from: "", miss: false };
  let sourceViewCi = -1; // 当前视图对应的章序号（-1 = 全文/退化视图）

  function findBook(bid) { return (getLibrary() || []).find((b) => b.id === bid); }

  function chapterIndexOfLesson(outline, lid) {
    const chapters = (outline && Array.isArray(outline.chapters)) ? outline.chapters : [];
    if (!lid) return -1;
    for (let i = 0; i < chapters.length; i++) {
      const lessons = chapters[i] && Array.isArray(chapters[i].lessons) ? chapters[i].lessons : [];
      for (const ls of lessons) { if (ls && ls.id === lid) return i; }
    }
    return -1;
  }
  // 某课时在「本章切片」内的相对区间（仅用于高亮，不用于切片）。
  // 课时坐标是原文绝对偏移，减去章起点换成相对偏移；缺失/越界一律返回 null（宁可不标也不标错）。
  function lessonRangeInSlice(ch, lid, sliceLen) {
    if (!ch || !lid || typeof lid !== "string" || lid.indexOf("ch:") === 0) return null;
    const lessons = Array.isArray(ch.lessons) ? ch.lessons : [];
    const ls = lessons.find((x) => x && x.id === lid);
    if (!ls) return null;
    const cs = ch._charStart, s0 = ls._charStart, s1 = ls._charEnd;
    if (typeof cs !== "number" || typeof s0 !== "number" || typeof s1 !== "number") return null;
    const a = Math.max(0, Math.min(sliceLen, s0 - cs));
    const b = Math.max(0, Math.min(sliceLen, s1 - cs));
    return (b > a) ? { start: a, end: b } : null;
  }
  // 本章所有「可高亮课时」的区间（点原文反查用：任意位置该归到哪节课）
  function lessonRangesInSlice(ch, sliceLen) {
    const lessons = (ch && Array.isArray(ch.lessons)) ? ch.lessons : [];
    const out = [];
    lessons.forEach((ls) => {
      const r = lessonRangeInSlice(ch, ls && ls.id, sliceLen);
      if (r) out.push({ id: ls.id, title: ls.title || "", start: r.start, end: r.end });
    });
    return out;
  }
  // 解析「第 ci 章」这个视图到底展示什么。**渲染与查找共用它**——
  // 否则「切片规则」和「检索规则」各写一份必然漂移，出现"搜到 3 处却只看到 1 处"。
  // fallback=true 表示该章退化成了整书全文（坐标缺失/切片过短），
  // 查找时不能把它当独立章节累计，否则同一份全文会被多章重复计数。
  function sourceViewFor(book, ci) {
    const material = (book.material || "").trim();
    const outline = book.outline;
    const chapters = (outline && Array.isArray(outline.chapters)) ? outline.chapters : [];
    const fullView = (note) => ({
      ci: -1, ch: null, fallback: true,
      text: material || "（该课程还没有上传资料）",
      label: material ? "全文" : "无学习资料",
      note: note,
    });
    if (ci < 0 || ci >= chapters.length) {
      return fullView(material ? "该课程尚未拆分大纲，已显示全文" : "该课程还没有上传学习资料");
    }
    const ch = chapters[ci];
    if (!ch) return fullView(material ? "该章数据异常，已改为显示全文" : "该课程还没有上传学习资料");
    // 缺位置索引、或索引算法版本落后（旧大纲）时现算一次并持久化
    // ——纯函数、零 token，老教材不必重生成大纲也能用上新定位逻辑
    if (material && outline && needsReindex(outline)) {
      indexChapterPositions(material, outline);
      saveLibrary();
    }
    const hasRange = typeof ch._charStart === "number" && typeof ch._charEnd === "number" && ch._charEnd > ch._charStart;
    const slice = hasRange ? material.slice(ch._charStart, ch._charEnd) : "";
    if (slice && slice.trim().length >= 10) {
      const n = Array.isArray(ch.lessons) ? ch.lessons.length : 0;
      let label = "第 " + (ci + 1) + " 章 · " + (ch.title || ("第 " + (ci + 1) + " 章"));
      if (n) label += "（" + n + " 课时 · 约 " + slice.length + " 字）";
      return { ci: ci, ch: ch, text: slice, label: label, note: "", fallback: false };
    }
    // 退化：仍停在用户选的那一章（下拉不跳），但内容换成全文，并说明原因
    const v = fullView(material
      ? (hasRange ? "本章切出的正文过短，已改为显示全文" : "本章章名未在原文中定位到，已改为显示全文")
      : "该课程还没有上传学习资料");
    v.ch = ch;
    return v;
  }
  // 全书查找：章级视图下跨章累计（④）；全文/退化视图下只搜当前这份文本（避免重复计数）。
  function collectSourceHits(book) {
    const q = sourceFind.query;
    if (!q) return [];
    const outline = book.outline;
    const chapters = (outline && Array.isArray(outline.chapters)) ? outline.chapters : [];
    const curView = sourceViewFor(book, sourceViewCi);
    const views = [];
    if (!chapters.length || curView.fallback) {
      views.push(curView);
    } else {
      for (let i = 0; i < chapters.length; i++) {
        const v = sourceViewFor(book, i);
        if (!v.fallback) views.push(v);
      }
    }
    const out = [];
    for (const v of views) {
      if (out.length >= SOURCE_FIND_MAX) break;
      const ms = findTextMatches(v.text, q, SOURCE_FIND_MAX - out.length);
      for (const m of ms) out.push({ ci: v.ci, start: m.start, end: m.end });
    }
    return out;
  }
  // 点击位置 → 容器内字符偏移（反向定位用）。跨浏览器：Chrome 用 caretRangeFromPoint，
  // Firefox 用 caretPositionFromPoint。用 Range.toString().length 量偏移，
  // 因为容器内容是「文本节点 + <mark>」混排，不能靠单节点索引直接数。
  function caretOffsetFromPoint(x, y) {
    let node = null, off = 0;
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (!r) return -1;
      node = r.startContainer; off = r.startOffset;
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p) return -1;
      node = p.offsetNode; off = p.offset;
    } else {
      return -1;
    }
    if (!node || !els.sourceText.contains(node)) return -1;
    const rng = document.createRange();
    rng.selectNodeContents(els.sourceText);
    try { rng.setEnd(node, off); } catch (e) { return -1; }
    return rng.toString().length;
  }
  // 用分段 DOM 渲染（不用 innerHTML 拼字符串）：原文是用户内容，必须走 textNode，
  // 标记文本也只用 textContent —— 天然免疫 XSS。
  function paintSourceText(text, marks) {
    const frag = document.createDocumentFragment();
    buildHighlightSegments(text, marks).forEach((sg) => {
      if (!sg.kind) { frag.appendChild(document.createTextNode(sg.text)); return; }
      const el = document.createElement("mark");
      el.className = "src-mark src-" + sg.kind;
      el.textContent = sg.text;
      frag.appendChild(el);
    });
    els.sourceText.innerHTML = "";
    els.sourceText.appendChild(frag);
  }
  function scrollSourceTo(selector) {
    const el = els.sourceText.querySelector(selector);
    if (!el) return;
    // 用 rect 差值而非 offsetTop：不依赖 offsetParent 是否定位过
    const r = el.getBoundingClientRect();
    const c = els.sourceText.getBoundingClientRect();
    els.sourceText.scrollTop += (r.top - c.top) - 16;
  }
  function renderSourceText(book, key, precomputedHits) {
    // key 支持两种：「ch:<章序号>」（章级选择）或课时 id（点课时 📄 时传入 → 回落到所属章）
    let ci = -1;
    if (typeof key === "string" && key.indexOf("ch:") === 0) ci = parseInt(key.slice(3), 10);
    else if (key) ci = chapterIndexOfLesson(book.outline, key);
    sourceViewCi = ci;

    const view = sourceViewFor(book, ci);
    const text = view.text;
    // 点原文反查时**保持滚动位置**（内容没变，跳走会很突兀）；其他来源才自动定位
    const keepScroll = (sourceHighlight.from === "click") ? els.sourceText.scrollTop : null;

    // 本书全部命中（章级视图下跨章累计）→ ① 计数是全书口径 ② 下一个可自动跨章
    // 调用方已算过就复用（避免一次按键把全书扫两遍）
    const allHits = precomputedHits || collectSourceHits(book);
    sourceFind.hits = allHits;
    sourceFind.total = allHits.length;
    if (sourceFind.index >= allHits.length) sourceFind.index = allHits.length ? allHits.length - 1 : 0;
    const curHit = allHits[sourceFind.index] || null;
    const hereHits = allHits.filter((h) => h.ci === view.ci);

    // 课时高亮：点课时📄/点原文指定的那节；必须属于当前章且坐标可靠
    const focus = sourceHighlight.lid ? lessonRangeInSlice(view.ch, sourceHighlight.lid, text.length) : null;

    const marks = [];
    if (focus) marks.push({ start: focus.start, end: focus.end, kind: "lesson", priority: 1 });
    hereHits.forEach((h) => {
      marks.push({ start: h.start, end: h.end, kind: (h === curHit ? "hit-cur" : "hit"), priority: 2 });
    });

    paintSourceText(text, marks);

    if (keepScroll !== null) els.sourceText.scrollTop = keepScroll;
    else if (curHit && curHit.ci === view.ci) scrollSourceTo(".src-hit-cur");
    else if (focus) scrollSourceTo(".src-lesson");
    else els.sourceText.scrollTop = 0;

    els.sourceFindCount.textContent = sourceFind.query
      ? (allHits.length
        ? (sourceFind.index + 1) + "/" + allHits.length + (allHits.length >= SOURCE_FIND_MAX ? "+" : "")
        : "无匹配")
      : "";

    // 副标题：退化原因 + 课时定位反馈（点原文反查时告诉用户"这段归哪节课"）
    let note = view.note;
    if (sourceHighlight.from === "click") {
      if (focus) note = "这段原文属于课时《" + (sourceHighlight.title || "") + "》";
      else if (!sourceHighlight.miss) note = "";
      else note = "这段原文未落在任何已定位的课时区间内";
      if (view.note) note = note ? (view.note + " · " + note) : view.note;
    } else if (sourceHighlight.lid && !focus && view.ch) {
      note = [view.note, "本课在该章内未取得可靠位置，未能高亮"].filter(Boolean).join(" · ");
    }
    els.sourceSub.textContent = "当前查看：" + view.label + " · 仅浏览，不消耗 token" + (note ? " · " + note : "");
  }
  function open(bid, lid) {
    const bk = findBook(bid);
    if (!bk) return;
    els.sourceTitle.textContent = (bk.title || "未命名课程") + " · 原文";
    els.sourceLessonSelect.innerHTML = "";
    const outline = bk.outline;
    const chapters = (outline && Array.isArray(outline.chapters)) ? outline.chapters : [];
    // 默认选中：指定课时所属章 > 正在上的课时所属章 > 第一章；无大纲则只有一个"全文"项
    let defaultCi = chapterIndexOfLesson(outline, lid);
    if (defaultCi < 0 && getActiveSessionBookId() === bk.id) defaultCi = chapterIndexOfLesson(outline, getCurrentLessonId());
    if (chapters.length) {
      chapters.forEach((ch, ci) => {
        const opt = document.createElement("option");
        opt.value = "ch:" + ci;
        opt.textContent = "第 " + (ci + 1) + " 章 · " + (ch.title || ("第 " + (ci + 1) + " 章"));
        els.sourceLessonSelect.appendChild(opt);
      });
      if (defaultCi < 0) defaultCi = 0;
    } else {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "全文（尚未拆分大纲）";
      els.sourceLessonSelect.appendChild(opt);
    }
    if (defaultCi >= 0) els.sourceLessonSelect.value = "ch:" + defaultCi;
    els.sourceLessonSelect.dataset.bid = bk.id;
    // 每次打开重置查找（避免上一次的检索词串到另一本书上）
    sourceFind.query = "";
    sourceFind.index = 0;
    sourceFind.total = 0;
    sourceFind.hits = [];
    els.sourceFindInput.value = "";
    els.sourceFindCount.textContent = "";
    // 高亮目标：点课时 📄 进来的课件 → 高亮那一节；否则不高亮
    sourceHighlight.lid = (lid && defaultCi >= 0 && chapterIndexOfLesson(outline, lid) === defaultCi) ? lid : null;
    sourceHighlight.title = "";
    sourceHighlight.from = "open";
    sourceHighlight.miss = false;
    // 必须先显示再渲染：display:none 的元素没有布局，getBoundingClientRect() 全为 0，
    // 「滚动到课时位置 / 当前命中」会静默失效（renderSourceText 内部依赖真实布局）。
    els.sourceOverlay.classList.remove("hidden");
    renderSourceText(bk, defaultCi >= 0 ? ("ch:" + defaultCi) : "");
  }
  function close() { els.sourceOverlay.classList.add("hidden"); }

  // 按当前下拉选中的章重渲染（切章 / 翻命中 / 改检索词都走它）
  function renderBySelect(precomputedHits) {
    const bk = findBook(els.sourceLessonSelect.dataset.bid);
    if (bk) renderSourceText(bk, els.sourceLessonSelect.value, precomputedHits);
  }
  function stepFind(delta) {
    if (!sourceFind.total) return;
    // 取模保证首尾循环（-1 → 末条）；命中落在别的章时自动切过去（跨章连续，④）
    sourceFind.index = ((sourceFind.index + delta) % sourceFind.total + sourceFind.total) % sourceFind.total;
    const h = sourceFind.hits[sourceFind.index];
    // ci<0 表示命中来自「全文/退化视图」，不是真实章节序号 → 不能拿它去设下拉
    if (h && h.ci >= 0 && h.ci !== sourceViewCi) {
      els.sourceLessonSelect.value = "ch:" + h.ci;
      sourceHighlight.lid = null;
      sourceHighlight.from = "find";
    }
    renderBySelect();
  }

  // ---- DOM 事件绑定：浮层自己的交互自己管（状态都在本闭包内，宿主不再插手）----
  function bind() {
    els.closeSource.addEventListener("click", close);
    els.sourceOverlay.addEventListener("click", (e) => { if (e.target === els.sourceOverlay) close(); });
    els.sourceLessonSelect.addEventListener("change", () => {
      // 切章：纯本地重新切片展示，不调用任何 API、不消耗 token
      // 查找词保留（便于跨章继续找同一个词）；序号重锚到「本章第一个命中」，无命中则保持原序号
      sourceHighlight.lid = null;
      sourceHighlight.title = "";
      sourceHighlight.from = "select";
      sourceHighlight.miss = false;
      const ci = parseInt(String(els.sourceLessonSelect.value).slice(3), 10);
      const first = sourceFind.hits.findIndex((h) => h.ci === ci);
      sourceFind.index = first >= 0 ? first : 0;
      renderBySelect();
    });
    // 原文查找（③④）：纯本地字符串检索 + 高亮，同样零 token
    els.sourceFindInput.addEventListener("input", () => {
      sourceFind.query = els.sourceFindInput.value.trim();
      sourceFind.index = 0;
      // 检索新词时从「当前章」往后找（找不到再回到开头），比永远跳回第一章更符合直觉
      const bk = findBook(els.sourceLessonSelect.dataset.bid);
      let hits = null;
      if (bk && sourceFind.query) {
        hits = collectSourceHits(bk);
        const pos = hits.findIndex((h) => h.ci >= 0 && h.ci >= sourceViewCi);
        sourceFind.index = pos >= 0 ? pos : 0;
        const h = hits[sourceFind.index];
        if (h && h.ci >= 0 && h.ci !== sourceViewCi) {
          els.sourceLessonSelect.value = "ch:" + h.ci;
          sourceHighlight.lid = null;
          sourceHighlight.from = "find";
        }
      }
      renderBySelect(hits);
    });
    els.sourceFindInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      stepFind(e.shiftKey ? -1 : 1);
    });
    els.sourceFindPrev.addEventListener("click", () => stepFind(-1));
    els.sourceFindNext.addEventListener("click", () => stepFind(1));
    els.sourceFindClear.addEventListener("click", () => {
      els.sourceFindInput.value = "";
      sourceFind.query = "";
      sourceFind.index = 0;
      els.sourceFindInput.focus();
      renderBySelect();
    });
    // 点原文任意位置 → 反查「这段属于哪一节课」（⑤）。只读，不影响上课/进度。
    els.sourceText.addEventListener("click", (e) => {
      const off = caretOffsetFromPoint(e.clientX, e.clientY);
      if (off < 0) return;
      const bk = findBook(els.sourceLessonSelect.dataset.bid);
      if (!bk) return;
      const view = sourceViewFor(bk, sourceViewCi);
      const hit = view.ch
        ? lessonRangesInSlice(view.ch, view.text.length).find((r) => off >= r.start && off < r.end)
        : null;
      sourceHighlight.lid = hit ? hit.id : null;
      sourceHighlight.title = hit ? hit.title : "";
      sourceHighlight.from = "click";
      sourceHighlight.miss = !hit;
      renderSourceText(bk, els.sourceLessonSelect.value);
    });
  }

  bind();

  // 20260913：不再对外导出 close（关浮层的两条路径都在模块内自己绑好了：
  // els.closeSource 的点击与遮罩点击）。宿主只调 open()。
  return { open };
}
