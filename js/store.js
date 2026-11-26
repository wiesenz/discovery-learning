/* =====================================================================
 *  Socratopia v0 · 应用状态中心（store）
 *  20260904.1 建立 —— 收敛"教材上下文 + 学习数据"这块全局单例。
 *
 *  背景：拆分前 app.js 有 61 个模块级 let 散落各处，其中 currentBook 被
 *  128 处直读、library 37 处、memory 29 处……域与域之间没有边界，任何
 *  一个功能改动都可能牵动全局（"牵一发动全身"的真正来源）。
 *
 *  这个模块解决的是"所有权"问题，不是"响应式"问题：
 *    状态有唯一归属，插件通过注入 store 访问它，而不是伸手进宿主的 61 个 let。
 *    js/contract.test.mjs [3] 会拦住任何写回裸 currentBook 的新代码。
 *
 *  刻意没做的事（避免投机设计，需要时再加）：
 *    - 不做 get/set/subscribe/pub-sub：当前零订阅者，加了就是死代码。
 *      等第一个真实订阅者出现，再加回 set + subscribe（约 10 行）。
 *    - 不做统一的 JSON 读写封装：app.js 里 18 处 JSON.parse(localStorage…)、
 *      21 处 JSON.stringify 写法不统一（有的包 cleanChatMessages 转换），
 *      强行抽象反而更绕，留给专门的一刀处理。
 *
 *  不接管：
 *    - messages / isBusy（聊天会话域，将来随消息渲染一起重构）；
 *    - 纯 UI 瞬时态（如 modal 展开与否）。
 *
 *  用法：
 *    const store = createStore();
 *    const S = store.state;   // S.currentBook / S.library / S.memory …
 * ===================================================================== */

const LS_PREFIX = "socratopia_";

/**
 * 按教材隔离的 localStorage 键工厂。
 * 放在这里而不是 app.js，是因为键名由"当前教材"派生，归属应与状态同源。
 * @param {string} bookKey 教材唯一 key
 * @param {string} kind 数据种类，如 chat / group / memory / collection
 */
export function bookLS(bookKey, kind) {
  return LS_PREFIX + kind + "_" + bookKey;
}

/**
 * 把任意对象浅拷贝成【无原型】的映射表，用作 `memory.topics`。
 *
 * 为什么必须无原型：`topics` 的键是**课程标题**（见 app.js 的 currentTopicKey），
 * 而读取写的是 `topics[key] || {...}`。普通对象 `{}` 会沿着原型链取值，于是课程名
 * 一旦叫 `toString` / `constructor` / `valueOf`，取到的就是 Object.prototype 上的
 * 方法（真值）而不是"没有记忆"——记忆被写到那个共享函数对象上，JSON.stringify 丢弃
 * 函数值 → 刷新后记忆归零；叫 `__proto__` 更糟：写入会落到 Object.prototype 上，
 * 之后**每一门课**的提示词都会注入这份串档的记忆。
 *
 * 用 Object.create(null) 后，`topics[任意名字]` 只可能是自己的键，原型链消失；
 * 而 Object.keys / JSON.stringify 对无原型对象照常工作，localStorage 读写不受影响。
 * 注意 JSON.parse 出来的又是普通对象，所以每次载入后都要再过一遍本函数
 * （app.js 的 normalizeMemory 就是这个唯一入口）。
 *
 * @param {object} [src] 源对象（非对象/null 视为空）
 * @returns {object} 无原型的浅拷贝（只含 src 的自有可枚举键）
 */
export function safeTopicMap(src) {
  const out = Object.create(null);
  if (src && typeof src === "object") {
    Object.keys(src).forEach((k) => { out[k] = src[k]; });
  }
  return out;
}

/**
 * 创建应用状态中心。用工厂而非单例导出，是为了与 createGroupChat(deps)
 * 保持同一套"工厂 + 注入"模式，也便于单测拿到互不干扰的实例。
 * @param {object} [initial] 初始状态覆盖（便于单测）
 */
export function createStore(initial) {
  return {
    state: Object.assign(
      {
        // ---- 教材上下文（原 app.js 模块级 let）----
        library: [],          // 教材库
        currentBook: null,    // 当前教材对象 {id,title,material,bookKey,createdAt}
        currentLessonId: null,     // 正在上的课时 ID，如 "ch1_L2"
        selectedLessonId: null,    // 选中准备浏览/上课的课时 ID
        activeSessionBookId: null, // 正在上课（未下课）的课程 id，用于"同时只能上一门课"约束

        // ---- 学习数据（按教材隔离，切换教材时由宿主重新载入）----
        memory: { topics: safeTopicMap() }, // 长期记忆：{ topics: { 主题: {mastered,weak,…} } }
        collection: [],            // 收藏卡片 [{id, topic, text, collectedAt}]
        // 啊哈时刻（ahas）已于 20260915 下线，字段一并移除（历史本地数据由删除教材时的 bookLS 清理）
      },
      initial || {}
    ),

    bookLS,
  };
}
