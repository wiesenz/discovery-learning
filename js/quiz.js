/* =====================================================================
 *  Socratopia v0 · 随堂测验（下课答题浮层）
 *  20260906.1 从 app.js 抽出（技术债拆分第四刀）。
 *
 *  设计：与 group.js / roles.js 同构 —— 本模块不直接读写 app.js 的任何模块级状态。
 *  测验自己的状态（pendingQuiz / quizDone / pendingQuizLessonId）收敛在
 *  createQuiz() 闭包内，宿主只能通过返回的接口访问；对宿主能力的依赖
 *  （知识点归并、错题本、记忆落盘、群聊复盘）一律走 deps 注入。
 *
 *  用法：
 *    const quiz = createQuiz({ els, S, escapeHtml, ... , onFinished });
 *    quiz.setPending(ensureQuizAnswers(data.quiz), lessonId);
 *    if (quiz.hasPending()) quiz.openQuiz();
 * ===================================================================== */

import { deriveMisconceptionsFromWrongQuiz } from "./adaptive.js";

const CHOICE_LABELS = ["A", "B", "C", "D"];

export function createQuiz(deps) {
  const {
    els,                  // { quizOverlay, quizBody }
    // 20260913 收窄：此前是整包 store 状态 `S`，而本模块实际只用到
    // S.memory.topics[currentTopicKey()] 这【一个】键 —— 却因此拿到了
    // library / currentBook / collection 等 6 个无关状态的读写权
    // （store 是裸对象，没有任何读写拦截）。改成窄接口后，测验插件碰不到别的域。
    getTopicMemory,       // () => 当前主题的记忆对象 | null
    escapeHtml,           // (s) => string
    getAllLessons,        // () => Lesson[]，取全书 keyPoints 做 kp 归并候选
    normalizeKpToLesson,  // (kp, candidates) => 规范化知识点短语
    uniqKp,               // (arrays[]) => 去重后的知识点数组
    touchKeypointStats,   // (kp, correct) => void，知识点级掌握追踪
    dissolveUncovered,    // (kp) => void，未覆盖点消解
    pushWrongbook,        // (items) => void，错题滚入书级错题本
    recordMisconceptions, // (texts:string[]) => void，答错即把对应误区写入记忆（P2 事件触发，≈0 token）
    saveQuizWrong,        // (lessonId, wrongIdx) => void
    todayISO,             // () => "YYYY-MM-DD"
    emaQuizScore,         // (prev, accRate) => number
    recalcNextReview,     // (m) => void
    saveBookMemory,       // () => void
    renderMemoryPanel,    // () => void
    onFinished,           // (lessonId) => void，答完后拉起群聊复盘（宿主逻辑）
  } = deps;

  // ---- 测验私有状态（不再散落在 app.js）----
  let pendingQuiz = null;        // 本次下课生成的测验题，供答题浮层读取
  let quizDone = false;          // 本次测验是否已答完（决定关闭时是否拉起群聊）
  let pendingQuizLessonId = null; // 当前随堂测验对应的课时（答题完成后据此写回错题记录）
  // 本次测验是否【已经计过分】（20260913 新增，防重复计分）。
  // 交卷后 pendingQuiz 会保留（为的是让学习者还能回看题目与解析），聊天里的「开始答题」卡
  // 也还在 —— 于是再点一次就会把【同一份实测】再滚一次 EMA、再写一遍错题本与误区。
  // 而掌握度（quizScore / keypointStats / 误区）正是"因材施教"整条记忆链路的输入，
  // 重复计分等于把老师对学生的判断系统性推高。这里只挡住"再计一次分"，其余行为不变。
  let quizScored = false;

  /** 宿主在下课时写入待答测验；lessonId 用于答完后回写错题记录 */
  function setPending(quiz, lessonId) {
    // 20260913：过滤掉模型偶发吐出的畸形题（null / 缺 choices）。此前原样存下，到渲染时
    // `it.answer` 会抛 TypeError（浮层打不开，而该调用在宿主下课流程的 try/catch 之外，
    // 界面零提示），或渲染出 0 个选项让「下一题」永久禁用 —— 卡死且没有任何出路。
    // 过滤后若一条都不剩，hasPending() 为 false，宿主会直接跳过测验，而不是给一个坏浮层。
    pendingQuiz = Array.isArray(quiz)
      ? quiz.filter((it) => it && Array.isArray(it.choices) && it.choices.length)
      : null;
    pendingQuizLessonId = lessonId || null;
    quizScored = false;
  }
  function clearPending() { pendingQuiz = null; }
  function hasPending() { return !!(pendingQuiz && pendingQuiz.length); }

  function openQuiz() {
    if (!pendingQuiz || !pendingQuiz.length) return;
    quizDone = false;
    renderQuizOverlay(pendingQuiz);
    els.quizOverlay.classList.remove("hidden");
  }

  function closeQuizOverlay() {
    els.quizOverlay.classList.add("hidden");
    // 仅当测验已答完（quizDone）才自动拉起群聊复盘；中途关闭（未答完）不打扰，
    // 避免用户想退出却被强行丢进群聊
    if (quizDone) onFinished(pendingQuizLessonId);
  }

  function renderQuizOverlay(quiz) {
    els.quizBody.innerHTML = "";
    let pageIndex = 0;
    const answered = new Array(quiz.length).fill(false); // 每题是否已作答
    const picked = new Array(quiz.length).fill(-1);      // 每题选了哪项
    const labels = CHOICE_LABELS;

    // 头部进度
    const head = document.createElement("div");
    head.className = "quiz-progress";
    head.innerHTML = '<span id="quizProgressText"></span><div class="quiz-track"><span id="quizTrackFill"></span></div>';
    els.quizBody.appendChild(head);

    // 单题舞台（每次只渲染一题）
    const stage = document.createElement("div");
    stage.className = "quiz-stage";
    els.quizBody.appendChild(stage);

    // 底部翻页导航
    const nav = document.createElement("div");
    nav.className = "quiz-nav";
    nav.innerHTML = '<button type="button" class="ghost-btn" id="quizPrevBtn">‹ 上一题</button>' +
      '<button type="button" class="primary-btn" id="quizNextBtn" disabled>下一题 ›</button>';
    els.quizBody.appendChild(nav);

    function updateProgress() {
      const pt = els.quizBody.querySelector("#quizProgressText");
      const fill = els.quizBody.querySelector("#quizTrackFill");
      if (pt) pt.textContent = "第 " + (pageIndex + 1) + " / " + quiz.length + " 题";
      if (fill) fill.style.width = Math.round(answered.filter(Boolean).length / quiz.length * 100) + "%";
      const prev = els.quizBody.querySelector("#quizPrevBtn");
      const next = els.quizBody.querySelector("#quizNextBtn");
      if (prev) prev.style.visibility = pageIndex === 0 ? "hidden" : "visible";
      if (next) {
        // 必须答完当前题才能翻页
        if (pageIndex === quiz.length - 1) {
          next.textContent = "完成，看群聊复盘 ➤";
          next.disabled = !answered[pageIndex];
        } else {
          next.textContent = "下一题 ›";
          next.disabled = !answered[pageIndex];
        }
      }
    }

    function renderPage() {
      const it = quiz[pageIndex];
      const ans = it.answer ?? 0;
      const ci = picked[pageIndex];
      const reasons = it.optionReasons || [];
      const isAnswered = answered[pageIndex];

      let choicesHtml = "";
      (it.choices || []).forEach((ch, i) => {
        let cls = "q-choice";
        if (isAnswered) {
          if (i === ans) cls += " correct";
          else if (i === ci) cls += " wrong";
          cls += " disabled";
        }
        choicesHtml += '<button type="button" class="' + cls + '" data-ci="' + i + '" data-ans="' + ans + '">' +
          '<span class="q-label">' + labels[i] + '</span><span class="q-text">' + escapeHtml(ch) + '</span></button>';
      });

      // 逐选项分析（作答后展开）
      let reasonsHtml = '<div class="q-reasons' + (isAnswered ? "" : " hidden") + '">';
      (it.choices || []).forEach((ch, i) => {
        const isCorrect = i === ans;
        reasonsHtml += '<div class="q-reason ' + (isCorrect ? "ok" : "bad") + '">' +
          '<span class="q-reason-tag">' + labels[i] + (isCorrect ? " ✓" : "") + '</span>' +
          '<span class="q-reason-text">' + escapeHtml(reasons[i] || (isCorrect ? "（正确项）" : "（干扰项）")) + '</span></div>';
      });
      reasonsHtml += '</div>';

      // 答错/答对都显示原因（explanation）
      let fbHtml = "";
      if (isAnswered) {
        if (ci === ans) {
          fbHtml = '<div class="q-feedback correct-fb">✅ 答对了！' + escapeHtml(it.explanation || "") + '</div>';
        } else {
          fbHtml = '<div class="q-feedback wrong-fb">❌ 答错了，正确答案：' + labels[ans] + '。' + escapeHtml(it.explanation || "") + '</div>';
        }
      }

      stage.innerHTML =
        '<div class="q-block' + (isAnswered ? " answered" : "") + '">' +
          '<div class="q-title"><b>第 ' + (pageIndex + 1) + ' 题</b><br>' + escapeHtml(it.q || "") + '</div>' +
          '<div class="q-choices">' + choicesHtml + '</div>' +
          fbHtml +
          reasonsHtml +
        '</div>';

      // 未作答时绑定选项点击
      if (!isAnswered) {
        stage.querySelectorAll(".q-choice").forEach((btn) => {
          btn.addEventListener("click", () => {
            const w = btn.closest(".q-block");
            if (w.classList.contains("answered")) return;
            picked[pageIndex] = parseInt(btn.dataset.ci, 10);
            answered[pageIndex] = true;
            renderPage(); // 重渲染本页（显示高亮 + 原因 + 解锁翻页）
          });
        });
      }
      updateProgress();
    }

    els.quizBody.querySelector("#quizPrevBtn").addEventListener("click", () => {
      if (pageIndex > 0) { pageIndex--; renderPage(); }
    });
    els.quizBody.querySelector("#quizNextBtn").addEventListener("click", () => {
      if (!answered[pageIndex]) return; // 必须答了当前题
      if (pageIndex < quiz.length - 1) { pageIndex++; renderPage(); }
      else {
        // 同一份测验只计一次分：已计过就直接收尾（仍允许回看，见 quizScored 的说明）
        if (quizScored) { quizDone = true; closeQuizOverlay(); return; }
        quizScored = true;
        // 记录本次答错的题，供续学后再下课时让老师「换新题 + 用新角度重温错题」
        const wrongIdx = quiz.map((it, i) => (picked[i] !== it.answer ? i : -1)).filter((i) => i >= 0);
        saveQuizWrong(pendingQuizLessonId, wrongIdx);
        // kp 归一化候选集取【全书 keyPoints】而非仅本课：迁移题的 kp 若属别课概念，也能正确归并、不再碎成多条
        const bookKps = uniqKp(getAllLessons().map((ls) => ls.keyPoints || []));
        const normKpOf = (it) => normalizeKpToLesson(it && it.kp, bookKps);
        // 知识点级追踪：按题目的 kp 字段更新掌握状态（答错→weak；累计答对>答错→mastered）
        const touchedNks = new Set();
        quiz.forEach((it, i) => {
          const nk = normKpOf(it);
          if (nk) { touchKeypointStats(nk, picked[i] === it.answer); touchedNks.add(nk); }
        });
        // 未覆盖点消解：本次被触达的概念，从各课"历史未覆盖"清单中剔除，避免复习清单越攒越陈旧
        touchedNks.forEach((nk) => dissolveUncovered(nk));
        // 跨课错题本：错题（含 kp 与解析）滚入书级错题本，供间隔复习与复习课跨课复用
        pushWrongbook(wrongIdx.map((i) => quiz[i]).filter(Boolean).map((it) => ({ q: it.q, explanation: it.explanation, kp: normKpOf(it), lid: pendingQuizLessonId })));
        // P2 事件触发：答错即把对应误区写入记忆（0 token），让后续 chat（P1）/ 测验（P0）当场受益
        const newMis = deriveMisconceptionsFromWrongQuiz(quiz, picked, normKpOf);
        if (newMis.length) recordMisconceptions(newMis);
        // 间隔校准：随堂测验是比 selfScore（老师主观估计）更硬的掌握信号。
        // 答对率按 EMA 滚进书级 m.quizScore（小样本抖动被天然阻尼），再经 recalcNextReview
        // 与 selfScore 融合（实测 0.7 / 主观 0.3）重定间隔——信号持久化，下一课下课不再冲掉。
        // 只校准已存在的主题记忆：无记忆说明走了 T0/T1 轻路径（无测验闭环），不在此新建。
        if (quiz.length) {
          const accRate = (quiz.length - wrongIdx.length) / quiz.length;
          const m = getTopicMemory();
          if (m) {
            m.quizScore = emaQuizScore(m.quizScore, accRate);
            m.lastStudied = todayISO();
            recalcNextReview(m);
            saveBookMemory();
            renderMemoryPanel();
          }
        }
        quizDone = true; closeQuizOverlay();
      }
    });

    renderPage();
  }

  // 20260913：删掉 getLessonId（宿主从未调用）。pendingQuizLessonId 仍在本模块内部
  // 用于"答完后回调 onFinished(pendingQuizLessonId)"，只是不再对外暴露。
  return {
    setPending,
    clearPending,
    hasPending,
    openQuiz,
    closeQuizOverlay,
  };
}
