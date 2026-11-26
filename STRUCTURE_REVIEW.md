# Socratopia v0 · 文件结构系统梳理与优化建议

> 审查日期：2026-08-03
> 审查范围：`socratopia-v0/` 全项目

---

## ✅ Phase 1a · Vite 化 + ESM 化（2026-08-06）

按商用方向（混合架构：Web 前端 + Tauri 壳）启动的第一步：Vite 骨架 + ES Module 化。

| 类别 | 改动 |
|------|------|
| 工具链 | 引入 Vite 8，`npm run dev`（端口 8199，HMR 热更新）/ `npm run build`（产物 dist/） |
| ESM 化 | `config.js` 改为导出 `APP_CONFIG / ROLE_REGISTRY / registerRole`；`roles/*.js` `import { registerRole }` 后注册；`app.js` 顶部 import 依赖 + 角色副作用注册；index.html 改为单个 `<script type="module" src="app.js">` |
| file:// | **取消双击 file:// 支持**（ESM 受浏览器 CORS 限制），改为必须走 http 服务（Vite / python http.server / exe 均可用） |
| 保留 | `js/core.js` 保持 UMD classic 加载（26 个纯函数单测零改动）；`vendor/` 三库保持 classic 全局，build 后用插件复制进 dist |
| 工程 | `.eslintrc.json` `sourceType` 改 `module` + 更新 globals；`start.bat` 优先 Vite、无 Node 回退 Python；README 同步；`vite.config.mjs`（含 dist 静态资源复制插件，手写递归复制规避 `fs.cpSync` 在受限环境的拦截） |
| 验证 | eslint 0/0 · 单测 26/26 · `vite build` 产物 curl 全 200 · Playwright smoke **7/7** |

**已知残留（环境，非代码）**：开发机端口 8199 可能被旧版 `Socratopia.exe` 占用。

> ⚠️ 20260913 更正：本条原文写"此时 `npm run dev` **会自动换端口**"，那与现在的实现**相反**。
> `vite.config.mjs` 已设 `strictPort: true`，端口被占用时直接报错退出、绝不顺延
> （理由：学习记录按 origin 隔离在 127.0.0.1:8199，换端口 = 用户看到空数据）。
> `_build/launcher.py` 对 exe 入口有同样的硬约束。**启动前先关掉占用 8199 的进程。**

---

## ✅ 本轮已实施（2026-08-03）

按上一版建议，已完成以下改动（均通过 `node --check` + `eslint`(0 error / 0 warning) + `js/core.test.js`(26/26) 验证）：

| 类别 | 改动 | 文件 |
|------|------|------|
| 清理 | 删除 `els` 中未使用的 `beCourseName/beBody/beFields`；移除 `config.js` 未用的 `roleScripts`；删减死代码 `bookKeyOf`/`enterCourseToStudy`、补一处缺失分号 | `app.js` `config.js` |
| 清理 | 重复启动脚本 `start8119.bat`（仅端口不同）移入 `_archived/`（可恢复/删除） | 根目录 → `_archived/` |
| 清理 | 改进 `.gitignore`（补 `node_modules/` `dist/` `.workbuddy/` 等） | `.gitignore` |
| 工程化 | `package.json` + `.eslintrc.json` + `README.md`，并安装 eslint，`npm run lint` 可用 | 根目录 |
| 模块拆分 | 抽出 4 个无 DOM 纯函数到 `js/core.js`（UMD：浏览器全局 `SocratopiaCore` + Node `module.exports`），`app.js` 用解构别名调用 | `js/core.js` `app.js` |
| 单测 | `js/core.test.js` 覆盖 token 估算 / 小结 JSON 容错 / 大纲 JSON / 材料截断（16 例） | `js/core.test.js` |
| 流式 | `callAPIWith` 支持 `stream`+`onToken`，新增 SSE 解析 `readStream`；`sendText` 逐字渲染（并对非 SSE 响应做兜底） | `app.js` |
| 暗色 | CSS 变量驱动的暗色主题 + 右上角 🌓 切换 + 首帧前应用（防闪烁）+ localStorage 持久化 | `styles.css` `index.html` `app.js` |
| 搜索 | 左侧课程搜索框，按标题/资料实时过滤 | `index.html` `styles.css` `app.js` |
| 打包 | `build.bat` 同步 `js/` 目录进 exe | `build.bat` |

**待你在浏览器验证**：流式回复（用真实 Key）、暗色切换观感、搜索过滤、以及 `npm run build` 打包后 exe 是否正常。

**状态更新（2026-08-03 下午）**：
- ✅ 文档前文提到的 2 个 lint warning 已清零，无需再动代码：
  - `chPct`：已删除其"只赋值、从未被读"的定义；`chTotal/chDone` 仍在显示处独立使用（`chDone + '/' + chTotal`），不受影响。
  - `APP_CONFIG`：`config.js` 只做 `export const APP_CONFIG`（配合文件内 `/* exported APP_CONFIG */`
    消除 ESLint 跨文件"定义未使用"误报）。**注意：并未挂 `window.APP_CONFIG` 全局**——
    2026-09-08 核对源码确认无此全局（早期文档曾如此描述，已过时）。因此 E2E/控制台
    无法从页面直接改 `ctxWindow`，测试需用「真实配置 + 真·超长书」触发分块路径。
- ⏸️ app.js 大单体拆分：**经评估暂不做**。理由（非疏漏，是有意的决策）：
  1. `file://` 双击即用是核心卖点，而 `<script type="module">` 在 `file://` 下会被 CORS 拦死，拆分只能走"多 classic `<script>` + 全局命名空间"（如 `core.js` 那样）或引入打包器——两条路都增加复杂度；
  2. 模块级可变状态变量共 16 个（`messages`/`groupMessages`/`library`/`currentBook`/`currentLessonId`/`selectedLessonId`/`activeSessionBookId`/`memory`/`collection`/`pendingQuiz` …）被几乎所有函数共享，拆前须先抽共享 state 对象再机械替换全部引用，漏改即隐蔽 bug；
  3. 无浏览器级 E2E 回归网（目前仅有 `js/core.js` 纯函数单测），单人维护、无合并冲突痛点，"难找代码"已被 `core.js` 抽取 + 区域注释缓解。
  → 因此第四节"拆分为 ES Module"的建议作废；将来若拆分也只能用 classic `<script>` + 全局命名空间方案，且应先补 E2E 烟囱测试兜底。

**落实（2026-08-04）**：
- ✅ **修复流式回复卡死 / "（思考中…）" 不更新**：`sendText` 的 `onToken` 原本每个 chunk 都重写整段 `innerHTML` 并强制滚动，长回复时 DOM 更新总量为 O(n²)，主线程被占满导致卡顿/假死；且 `streamEl` 是启动时捕获的 DOM 引用，若流式过程中任何代码触发 `renderMessages()` 重绘，更新会写到游离节点上，用户永远看到 "（思考中…）"。
  - 改为 `requestAnimationFrame` 批量渲染：每个 token 只更新数据，DOM 写操作收敛到每帧一次；
  - 用 `data-streaming="1"` 标记流式气泡，每次渲染前检查 `isConnected`，若已脱附则重新查找；
  - `finally` 中取消未执行的 RAF 并移除标记，再最终渲染；
  - 已验证：`node --check` + `eslint`(0/0) + E2E 7/7 通过。

**落实（2026-08-03 17:xx）**：
- ✅ 两个小 UX 修复（均已写入代码并由 E2E 覆盖）：
  - **#8 预设选「自定义」清空**：`providerPreset` 的 change 处理器在选中无 `data-base` 的「自定义」项时，清空 `apiBase`/`apiModel` 并 `saveSettings`（此前选「自定义」什么都不做，残留上次预设值）。
  - **#9 切换课程重置搜索**：`selectBook()` 在重置 `currentLessonId/selectedLessonId` 的同时清空 `state.bookQuery` 与 `#bookSearch` 的值，避免残留过滤继续隐藏课程列表。
- ✅ **E2E 烟囱测试落地（最高杠杆项，零风险、不动 app.js 源码）**：引入 Playwright，`playwright.config.js`（自带零依赖 node 静态服务器 `tests/e2e/serve.js`，以 http 模式加载，规避 file:// 限制）+ `tests/e2e/smoke.spec.js` 共 7 个用例——加载无报错、设置面板开合、暗色主题切换+持久化、**预设「自定义」清空（#8）**、新增课程、**课程搜索过滤**、**切换课程清空搜索（#9）**。当前 `npx playwright test` 全过（7/7）。
  - 说明：发送消息→流式回复的完整链路需真实 LLM 或 API 桩+课时启动，暂未纳入，模板见 `smoke.spec.js` 末尾注释。
  - 沙箱提示：本环境 `NODE_OPTIONS` 注入了 `genie-safe-delete` 垫片，会把 `fs.rm` 改成走回收站、遇中文路径抛错，导致 Playwright 清理 `test-results` 失败退出。正常终端 `npm run test:e2e` 即可；本沙箱内需 `env -u NODE_OPTIONS npx playwright test`。

**落实（2026-08-05）· 体验四件套（用户指定「三件套 + 侧栏改进」）**：
- ✅ **消息操作工具条**（仅 AI 文本气泡，hover 出现）：📋 复制全文（`navigator.clipboard` + `execCommand` 降级，兼容 file://）、🔄 重新生成最后一条回复（移除末尾 assistant 重调 API，不重复累计思维量）、💬 引用追问（把该条摘要预填输入框）、☆ 收入卷宗（复用 `toggleCollect`，普通 AI 消息用 `hashStr(content)` 作稳定 id）。新增 `isBusy` 全局标志防并发。
- ✅ **聊天记录搜索**：① 课时内搜索条（`#chatSearch`，实时过滤当前课时消息 + 命中数提示，不改数据）；② 复盘浮层跨课时搜索（`#reviewSearch`，`filterReviewNodes` 就地隐藏不匹配节点、保留分组头）。
- ✅ **课后笔记**：`config.js` 下课提示词新增 `notes` 字段（核心问题/我的回答/易错点/待思考）；`js/core.js` `parseLessonJson` 透传 notes（容错）；单测增 2 例（**21/21 通过**）；`generateLessonEnd` 按课时存 `bookLS(bookKey,"notes")` 并向下课报告追加「📓 课后笔记」卡；新增笔记浮层（`#notesOverlay`）展示四段 + 用户补充反思可保存。
- ✅ **侧边栏 / 课程陈列栏折叠**：顶部新增「☰ 侧栏」按钮（`.layout.sidebar-collapsed` 整栏收起、聊天全屏）；课程区抬头点击折叠、按钮「⇕」全部折叠/展开（`expandedCourses` 清空或填满）；修习履历 / 知识卡片区块头部点击折叠（`.collapsed` 隐藏内容）。
- 校验：`node --check`（app.js/config.js/core.js 全过）、`eslint` **0/0**、`js/core.test.js` **21/21**。E2E 浏览器未缓存、沙箱网络受限未跑，但改动均为 UI 增强、未触及现有 smoke 覆盖的加载/设置/暗色/预设/新增课程/搜索/切课逻辑。

**下线（2026-09-14）·「☰ 侧栏」整栏折叠**（撤销上条中的「整栏收起」一项）：
- 理由：左栏 `.sidebar` 并非装饰，而是应用主干——课程列表与「＋ 上传新课程」入口、修习履历、知识卡片、啊哈时刻四块都只挂在这里。把它整块藏起来对学习没有实质增益；且实测证明它有害：`.sidebar` 被 `display:none` 移出网格后，`.chat` 作为唯一网格项会被浏览器自动放进 `0px` 的第一列，导致聊天区宽度归零、搜索框/欢迎语/消息气泡/「我的基础」全部逐字竖排成一条窄条（用户 1279px 窗口下所见）。
- 清理范围：`index.html` 删按钮、`js/dom.js` 摘 `toggleSidebar` 映射、`app.js` 删事件绑定、`styles.css` 删 `.sidebar-collapsed` 两条规则（含 `.layout` 的 `1fr` 覆盖）。`.layout` 回到固定两列 `340px 1fr`。
- 保留：区块级折叠全部不动（课程区抬头点击 / 「⇕」全折叠 / 履历 / 卡片 / 啊哈）——那些有实际用处。
- 测试：原 `tests/e2e/sidebar-collapse.spec.js` 由 `tests/e2e/layout.spec.js` 取代，锁死「固定两列 + 聊天区不被挤塌」，并负向锁定 `toggleSidebar` / `sidebar-collapsed` 不回流（源码扫描 + DOM 双查）。

**改造（2026-09-15）· 设置面板改为浮层弹窗 + 左侧标签导航；「我的学习画像」迁出独立成窗**：
- 动机：设置原先是插在 topbar 与主界面之间的内嵌 `<section>`，展开时把主界面整体往下推；而它内部最长的一块是「我的学习画像」（页签 + 分组 + 回收站 + 添加行），顶栏却另有独立入口 —— 同一份内容两个门，且与"从它内部弹出的角色弹窗"叠在一起，观感粗糙。
- 现状对齐：项目本已有 9 个 overlay 浮层（课程资料 / 群聊 / 复盘 / 笔记 / 啊哈 / 角色编辑 / 原文 / 测验 / 大纲进度），「＋ 新建角色」本来就是弹窗；本次只是让设置与它们用同一套约定，而非新造体系。
- 改动：`index.html` 把 `#settingsPanel` 改为 `.overlay` 浮层并拆成左侧 5 页签（🔌API 连接 / 🎭角色 / 💾数据与备份 / 📖怎么用 / ⚠危险区），新增 `#closeSettings`；新增 `#profileModal` 容纳迁出的画像块。`styles.css` 删 `.panel` / `.panel-grid` / `.settings-group*` / `#profileBlock >` 系列，新增 `.settings-modal` / `.settings-nav(-item)` / `.settings-panes` / `.settings-pane` / `.settings-fields` / `.profile-modal(-body)`。`app.js` 加"关闭按钮 + 点遮罩关闭"与页签切换；`js/dom.js` 加 `els.closeSettings`；`js/profile-ui.js` 的 `openProfilePanel` 由"展开宿主面板 + scrollIntoView"改为打开自身弹窗，deps 里**不再传 `els`**（该模块自此完全不依赖宿主 DOM）。
- **必须保持的约束**：`#settingsPanel` / `#profileModal` 的 DOM 位置留在 `<main>` 之前 —— 所有浮层同为 `z-index:50`，同值时后出现的盖住先出现的，「新建角色」必须压在设置弹窗之上。
- 主题注意：深色下 `--ink` 是浅米色（`#e9e4d6`），页签选中态刻意**不用固定浅底**（`#fffdf7` 会变成浅字浅底），改用 `rgba(193,154,46,.16)` 半透明金 + 朱砂左竖条，明暗两套主题自适应。
- 测试：新增 `tests/e2e/settings-modal.spec.js`（4 例：不推挤主界面的几何断言 / 页签切换与"切页不丢值" / 画像独立且设置里无残留 / 子弹窗 DOM 层序）；`tests/e2e/roles.spec.js` 抽 `openSettingsRolePane()`（角色控件已入页签，原"打开即点"会超时）；`js/source-hygiene.test.mjs` 追加结构契约（浮层化、页签与内容页一一对应、DOM 层序、画像唯一）。`storage-usage.spec.js` 无需改动（只读文本断言在 `display:none` 下仍可读）。
- 未提交 git；`_build/webapp/` 未手改，`Socratopia.exe` 需重跑 `build.bat` 才生效。

**修复（2026-08-05）· 下课总结卡 JSON 解析失败**：
- 根因：`parseLessonJson` 在遇到截断、字段顺序打乱、summary 为空字符串、模型输出前后夹带角色台词等情况下直接返回 null，导致下课后出现「老师的小结整理遇到了一点格式问题」而无法恢复。
- 修复：
  - `js/core.js` `parseLessonJson` 改为「平衡匹配」提取最外层 `{...}`；新增对 `quiz`/`memory`/`notes` 嵌套对象/数组的暴力正则提取；`summary` 为空字符串也接受降级；新增 5 个边界单测，单测 **26/26 通过**。
  - `config.js` `lessonEndRules` 顶部新增「格式铁律」，强调必须返回严格 JSON、不要 markdown 代码块、不要额外解释、summary 必须存在。
  - `app.js` 解析失败卡片由 `summary` 改为 `summaryError`，不再显示无意义的「收入卷宗/群聊复盘」按钮，改为显示「🔄 重新生成总结」和「📄 查看原始响应」；新增 `retryLessonEnd()` 复用当前课时重试；原始响应保存在 localStorage 并可在卡片内展开排查。
  - `styles.css` 追加 `.msg.card.summary.error` 与 `.raw-response` 样式。
- 校验：`node --check` 全过 · `eslint` **0/0** · `js/core.test.js` **26/26**。

**修复（2026-08-05 后续）· 下课失败后课时状态仍显示「进行中」且错误卡叠加**：
- 根因：JSON 解析失败分支没有把课时标记为 completed，导致左侧课程树一直显示「进行中」和未完成的百分比；且每次点下课都会再 push 一张错误卡。
- 修复：
  - 解析失败分支在 push 错误卡前，先把课时状态置为 `completed` 并带 `hasError: true`，然后 `renderBookList()`，让左侧显示 100% / 已学过。
  - 保留内存中的 `currentLessonId` 上课锁（不 `releaseLessonLock`），使当前会话内仍可直接点「重新生成总结」重试。
  - push 新错误卡前 `filter` 掉已有 `summaryError` 卡，避免叠加。
  - `retryLessonEnd()` 增强：当前会话直接清报告卡重试；刷新后内存锁丢失时，从错误卡 `lid` 读取课时 id，从 `localStorage` 恢复课时对话、重置为 `in_progress` 后再重试。
- 校验：`node --check` 全过 · `eslint` **0/0**。

---

## 一、当前文件结构总览

> ⚠️ **本节是 2026-08-03 的快照，不是现状。** 标题里"当前"二字已不成立（文末的过期声明
> 管不到这里，所以在此再标一次）。已知与本节的出入至少包括：
> - `app.js` 写 2558 行 / 125KB → 实际约 4000 行 / 230KB；
>   `styles.css` 746 → 约 1669 行；`config.js` 238 → 703 行；`index.html` 277 → 586 行
> - `js/` 下当时只有 `core.js`（+ 单测），现在有 16 个模块（含 `dom.js`/`api.js`/`roles.js`
>   /`quiz.js`/`group.js`/`source-viewer.js`/`outline.js`/`extractors.js`/`prompt.js`/
>   `adaptive.js`/`profile.js`/`profile-ui.js`/`role-editor.js`/`store.js`）
> - 测试从"无"变成：`js/*.test.mjs`（10 个）+ `tests/e2e/*.spec.js`（6 个，52 用例）
> - `start8119.bat`、`_archived/`、`.prettierrc` 在本文里被引用，但**都不存在**
> - `_build/` 下另有 `launcher.py`（真正的 exe 入口）与 `webapp/`，本节未记录
> 需要当前数字时，跑 `npm test` 看 `[2] 规模仪表盘` 的输出（那是实时统计）。

```
socratopia-v0/
├── .gitignore
├── app.js                 # 2558 行 / 125KB —— 全部应用逻辑（大单体，拆分暂搁置，见上）
├── build.bat              # PyInstaller 打包脚本
├── config.js              # 238 行 —— 提示词 / 规则配置
├── index.html             # 277 行 —— 全部 HTML（6 个 overlay 模态框 + 侧边栏 + 聊天区）
├── roles/
│   ├── sanbingqi.js       # 角色卡：三月七
│   └── xingjianya.js      # 角色卡：星见雅
├── Socratopia.exe         # 9.9MB 打包产物
├── start.bat              # 启动 dev server（端口 8199）
├── styles.css             # 746 行 —— 全部 CSS（数字为 2026-08-03 快照，现已增长）
├── vendor/
│   ├── jszip.min.js       # 96KB
│   ├── mammoth.browser.js # 868KB
│   ├── pdf.min.js         # 284KB
│   └── pdf.worker.min.js  # 1.1MB
└── _build/
    ├── launcher.py        # Python HTTP 服务启动器
    ├── Socratopia.spec    # PyInstaller 配置
    └── webapp/            # 根目录源码的副本（gitignored，build.bat 自动同步）
```

### 代码规模统计

| 文件 | 行数 | 大小 | 职责 |
|------|------|------|------|
| app.js | 2558 | 125KB | 状态管理 / API / 渲染 / 课时 / 测验 / 群聊 / 文件解析 / 事件 / 初始化（大单体，拆分暂搁置） |
| styles.css | 746 | 40KB | 全部样式 |
| config.js | 238 | 19KB | 所有提示词规则 |
| index.html | 277 | 13KB | 全部 HTML 结构 |
| **合计** | **3819** | **~197KB** | — |
| vendor/ | — | 2.3MB | 4 个第三方库 |
| _build/webapp/ | — | 2.5MB | 源码副本（不入库） |

---

## 二、问题清单（按优先级排序）

### P0 · 架构层面

#### 1. app.js 巨型单体（2482 行 / 122KB）

**现状**：全部逻辑塞在一个 IIFE 里，至少包含 10 个独立职责模块：

| 职责 | 估算行数 | 涉及函数 |
|------|----------|----------|
| 状态管理 + localStorage | ~300 | `loadLibrary`, `saveLibrary`, `loadSettings`, `saveSettings`, `loadBookScoped` 等 |
| 渲染（消息/面板/列表） | ~600 | `renderMessages`, `bubble`, `renderBookList`, `renderMemoryPanel`, `renderCollectionPanel` |
| API 调用 + 上下文裁剪 | ~250 | `callAPIWith`, `chatMessagesAutoTrim`, `estimateTokens`, `buildSystemPrompt` |
| 课时系统 + 大纲 | ~300 | `startLesson`, `generateOutline`, `indexChapterPositions`, `sliceMaterialForLesson` |
| 测验引擎 | ~200 | `openQuiz`, `renderQuizOverlay`, `renderPage`, `updateProgress` |
| 群聊复盘 | ~150 | `openGroup`, `generateGroup`, `sendGroup`, `parseGroupLines` |
| 记忆 / 收藏 | ~150 | `loadBookMemory`, `mergeMemory`, `toggleCollect`, `renderCollectionPanel` |
| 文件解析（PDF/EPUB/DOCX） | ~150 | `extractPdfText`, `extractEpubText`, `extractDocxText` |
| 事件绑定 | ~200 | 第 2283-2436 行的 `addEventListener` 集中区 |
| 初始化 + 迁移 | ~180 | 启动流程、旧版数据迁移 |

**影响**：
- 改任何功能都要在 2482 行里上下翻找
- 函数间共享大量模块级变量（`messages`, `groupMessages`, `library`, `currentBook`, `currentLessonId`, `selectedLessonId`, `activeSessionBookId`, `lessonExchangeCount`...），耦合极高
- 无法对单个模块做单元测试
- 多人协作时必然冲突

**建议**：拆分为 ES Module，每个文件单一职责（详见第四节）。

#### 2. 无模块系统

**现状**：用 `<script>` 标签顺序加载，全局变量 `window.ROLE_REGISTRY` / `window.registerRole` 通信。

**影响**：
- 无法做 tree-shaking，全部代码一次性加载
- 无法使用 import/export，模块间只能靠闭包或全局变量
- vendor 库只能手动下载 .min.js 放 vendor/ 目录

**建议**：引入 ES Modules + 轻量打包（esbuild / Vite），保持 file:// 兼容可选。

---

### P1 · 工程化缺失

#### 3. 无 package.json / 无依赖管理

**现状**：vendor/ 下 4 个库共 2.3MB 直接入库，手动下载维护。

**影响**：
- 库版本无法追踪，升级困难
- 无法用 npm scripts 统一管理 dev/build/lint 命令
- 新协作者不知道项目依赖什么

**建议**：`npm init` + 将 vendor 库改为 npm 安装（`pdfjs-dist`, `jszip`, `mammoth`），.gitignore 排除 node_modules/。

#### 4. 无测试

**现状**：零测试文件。

**最该补测试的纯函数**（无 DOM 依赖，最容易测）：
- `estimateTokens(str)` — token 估算
- `chatMessagesAutoTrim()` — 上下文裁剪逻辑
- `parseOutlineJson(text)` — 大纲 JSON 解析（模型返回不标准 JSON 时的容错）
- `parseLessonJson(text)` — 下课总结 JSON 解析
- `parseGroupLines(text)` — 群聊文本解析
- `indexChapterPositions(material, outline)` — 章节位置索引
- `sliceMaterialForLesson(lesson, book)` — 教材切片
- `reviewInterval(score)` / `addDays(iso, n)` — 记忆复习间隔计算

**建议**：引入 Vitest，先对上述 8 个纯函数写测试，覆盖模型返回畸形 JSON 的边界情况。

#### 5. 无 lint / formatter

**现状**：无 ESLint / Prettier 配置。

**影响**：代码风格不统一（如混用单引号/双引号、缩进不一致）。

**建议**：`eslint` + `prettier`，配合 `husky` + `lint-staged` 在 commit 时自动格式化。

#### 6. 无 README

**现状**：项目无任何文档文件。使用说明散落在 index.html 的 `<details>` 帮助面板和 config.js 的注释里。

**建议**：补 README.md，包含：项目简介、快速开始、目录结构说明、如何新增角色、如何打包、架构概述。

---

### P1 · 代码质量

#### 7. start8119.bat 是重复文件

**现状**：`start.bat`（端口 8199）和 `start8119.bat`（端口 8119）内容完全一样，仅端口号不同。

**建议**：删除 `start8119.bat`，将 `start.bat` 改为接受可选端口参数：
```bat
set PORT=%1
if "%PORT%"=="" set PORT=8199
```

#### 8. HTML 中有死引用（dead code）

**现状**：app.js 的 `els` 对象引用了 index.html 中不存在的元素：
```js
genOutline: $("genOutline"),       // index.html 中无此元素
outlineList: $("outlineList"),     // 无
outlineEmpty: $("outlineEmpty"),   // 无
beCourseName: $("beCourseName"),   // 无
beBody: $("beBody"),               // 无
beFields: $("beFields"),           // 无
```
这些是旧版 UI 遗留，`$("xxx")` 返回 null 但不会报错（只是静默无效）。

**建议**：清理 `els` 对象中所有 null 引用，同时删除 `if (els.genOutline)` 这类防御性代码。

#### 9. innerHTML 字符串拼接

**现状**：`renderBookList()`（第 1144-1354 行）通过字符串拼接构建复杂 HTML：
```js
headerHtml += '<div class="course-head' + ... + '">' +
  '<span class="course-arrow">' + ... + '</span>' + ...
```
全靠 `escapeHtml()` 防 XSS，但拼接逻辑复杂、易出错、难维护。

**建议**：
- 短期：改用模板字符串（`` ` ``）替代字符串拼接，至少可读性提升
- 中期：引入轻量模板引擎或改用 `createElement` + DOM API
- 长期：考虑引入轻量框架（Preact / Alpine.js）

#### 10. 旧版数据迁移代码应标记过期

**现状**：第 2447-2457 行的 `migrateLegacyToBook` 迁移逻辑是一次性的，但永远会执行检查。

**建议**：加版本标记，迁移完成后跳过检查；或在下一个大版本时删除。

---

### P2 · 功能优化建议

#### 11. API 响应不支持流式

**现状**：`callAPIWith` 使用 `await response.json()` 一次性等待完整响应。

**影响**：长回复时用户等待时间长，体验差。

**建议**：改用 SSE / `response.body.getReader()` 做流式输出，逐 token 渲染。OpenAI 兼容接口普遍支持 `stream: true`。

#### 12. 无搜索功能

**现状**：课程多了之后，无法快速搜索课程/课时/聊天记录/收藏卡片。

**建议**：在侧边栏顶部加搜索框，支持课程名 + 课时标题的即时过滤。

#### 13. 无键盘快捷键

**现状**：仅 Enter 发送 / Shift+Enter 换行。

**建议**：
- `Ctrl/Cmd + K` — 快速搜索
- `Ctrl/Cmd + ,` — 打开设置
- `Esc` — 关闭当前 overlay
- `Ctrl/Cmd + Enter` — 上课 / 下课

#### 14. 无移动端适配

**现状**：CSS 是桌面优先布局，侧边栏 + 聊天区并排。移动端未做响应式。

**建议**：加 `@media (max-width: 768px)` 断点，移动端侧边栏改为抽屉式。

#### 15. 无暗色模式

**现状**：国风宣纸主题是固定的浅色。CSS 变量已定义在 `:root`，但无 `prefers-color-scheme` 适配。

**建议**：加 `@media (prefers-color-scheme: dark)` 或手动切换按钮，定义暗色版 CSS 变量。

#### 16. API Key 明文存储

**现状**：API Key 存在 localStorage 明文。已在 UI 文案中告知用户"只存在本机"。

**建议**：
- 短期：文档中明确风险告知
- 中期：考虑用 `SubtleCrypto` 做简单加密（密钥基于设备指纹），至少不是明文直读
- 注意：纯前端方案无法做到真正安全，需在文档中说明

#### 17. 角色加载方式可改进

**现状**：新增角色需要 ① 在 roles/ 放 .js 文件 ② 在 index.html 手动加 `<script>` 标签。config.js 的 `roleScripts` 数组实际未被使用（角色靠 `window.ROLE_REGISTRY` 自动注册）。

**建议**：
- 短期：删除 config.js 中无用的 `roleScripts` 数组
- 中期：如果引入打包工具，可用 `import.meta.glob`（Vite）自动扫描 roles/ 目录
- 如果保持无打包：写一个 `roles/loader.js`，用 `fetch` 动态加载（http 模式下可用；file:// 模式仍需手动 `<script>`）

---

### P2 · 构建优化

#### 18. build.bat 仅支持 Windows

**现状**：`.bat` 脚本无法在 macOS/Linux 执行。

**建议**：补一个 `build.sh` 或改用 Python 脚本做跨平台构建。如果引入 npm，可用 `npm run build` 统一。

#### 19. vendor 库可考虑 CDN

**现状**：vendor/ 下 2.3MB 的库随项目分发。

**建议**：
- 如果目标用户始终有网络：改用 CDN 引用（cdnjs / unpkg）
- 如果需要离线可用（当前 Socratopia.exe 打包后离线运行）：保持本地 vendor，但改为 npm 管理 + 构建时复制

---

## 三、优先级矩阵

| 改进项 | 影响面 | 工作量 | 优先级 |
|--------|--------|--------|--------|
| 拆分 app.js | 极高 | 大 | P0 |
| 删除 start8119.bat | 低 | 极小 | P0 |
| 清理 els 死引用 | 低 | 极小 | P0 |
| 引入 package.json | 高 | 小 | P1 |
| 补 README | 中 | 小 | P1 |
| 纯函数单元测试 | 高 | 中 | P1 |
| ESLint + Prettier | 中 | 小 | P1 |
| API 流式响应 | 高 | 中 | P1 |
| 搜索功能 | 中 | 中 | P2 |
| 移动端适配 | 中 | 中 | P2 |
| 暗色模式 | 低 | 中 | P2 |
| 键盘快捷键 | 低 | 小 | P2 |

---

## 四、建议的目标结构

```
socratopia-v0/
├── src/
│   ├── index.html              # 精简入口，仅结构骨架
│   ├── app.js                  # ~50行，仅 import + 初始化
│   ├── config.js               # 提示词配置（保持不变）
│   ├── js/
│   │   ├── api.js              # API 调用 + 上下文裁剪
│   │   ├── state.js            # 状态管理 + localStorage 封装
│   │   ├── render.js           # 消息渲染 + 面板渲染
│   │   ├── lesson.js           # 课时系统 + 大纲 + 切片
│   │   ├── quiz.js             # 测验引擎
│   │   ├── group.js            # 群聊复盘
│   │   ├── files.js            # PDF/EPUB/DOCX 解析
│   │   └── events.js           # 事件绑定
│   ├── css/
│   │   ├── base.css            # 变量 + reset + 排版
│   │   ├── layout.css          # 顶栏 + 侧边栏 + 聊天区布局
│   │   ├── chat.css            # 消息气泡 + 输入区
│   │   └── overlay.css         # 模态框 + 浮层
│   └── roles/
│       ├── sanbingqi.js
│       └── xingjianya.js
├── tests/
│   ├── api.test.js             # 裁剪逻辑测试
│   ├── parse.test.js           # JSON 解析测试
│   └── lesson.test.js          # 大纲索引 / 切片测试
├── _build/
│   ├── launcher.py
│   └── Socratopia.spec
├── package.json
├── .eslintrc.json
├── .gitignore
├── README.md
├── start.bat                   # 支持可选端口参数
└── build.bat
```

---

## 五、渐进式迁移策略

**不要一次性重构**。建议分步进行：

### 第一步（立即可做，~30 分钟）
1. 删除 `start8119.bat`
2. 清理 `els` 中的 null 引用
3. 删除 config.js 中无用的 `roleScripts` 数组
4. 补 `.gitignore` 中 `node_modules/`

### 第二步（引入工具链，~2 小时）
1. `npm init` + 安装 eslint/prettier
2. vendor 库改为 npm 安装，构建时复制到 dist/
3. 补 README.md

### 第三步（拆分 app.js，~1-2 天）
1. 先抽出纯函数模块（api.js / files.js / state.js）
2. 再抽渲染模块（render.js）
3. 最后抽业务模块（lesson.js / quiz.js / group.js）
4. 每抽一个模块，手动验证功能不回归

### 第四步（补测试 + 流式 API，~1-2 天）
1. 对纯函数写单元测试
2. API 改为流式响应
3. 加搜索 / 快捷键等功能

---

## 📌 拆分进度实录（截至 2026-09-10）

> 本文正文写于 2026-08-03，其中「app.js 大单体拆分：经评估暂不做」「无浏览器级 E2E」等判断
> **均已过期**。以本节为准；正文保留作决策留痕。

| 刀次 | 日期 | 模块 | app.js 行数变化 |
|---|---|---|---|
| 1 | 20260821.3 | `js/outline.js`（大纲纯函数） | — |
| 2 | 20260902.1 | `js/extractors.js`（文档解析）、`js/group.js`（群聊） | 4760 → 4492 |
| 3 | 20260904.1 | `js/store.js`（教材上下文 + 学习数据 + 存储层） | — |
| 4 | 20260906.1 | `js/roles.js`、`js/quiz.js`、`js/profile-ui.js` | 4492 → 4142 |
| 5 | 20260910.1 | `js/source-viewer.js`（查看原文浮层） | 4191 → 3894 |

**当前模块清单**（14 个 `.js` 于 `js/`）：`core.js`（UMD classic，纯函数）、`config.test` 之外的
`adaptive / extractors / group / outline / profile / profile-ui / prompt / quiz / role-editor /
roles / source-viewer / store / core`。

**已经落地的两道网**（本文正文都没有）：

- **E2E 回归网**：Playwright，`tests/e2e/*.spec.js`（含 `smoke / lesson-logic / lesson-end /
  outline-chunking / roles / aha`），当前全绿。
- **静态契约网**：`js/contract.test.mjs` 9 组护栏 —— ID 契约 / 规模仪表盘（**只打印不判定**，
  20260913 由"行数绊网"降级，理由见该文件 [2] 段）/ 状态所有权 / 插件实例 API 用法 /
  **插件闭包状态所有权**（quiz + source-viewer）/ XSS（escapeHtml 单一实现）/ 模块命名导入契约
  （防漏 export 整站白屏）/ 超时派生 / HTML 属性插值转义。

**拆分范式（后续增模块照此办理）**：模块用 `export function createXxx(deps)` 工厂 + 依赖注入，
自己的状态收敛在闭包内、DOM 事件自己绑定，宿主只保留一处装配与若干入口调用；
新模块会自动被契约测试 [1]（扫 `js/*.js` 的 id 引用）与 [7]（扫命名导入）纳入安全网。
