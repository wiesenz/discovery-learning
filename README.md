# 苏格拉底式自学助手 · Socratopia v0

角色引导 · 主动推理 · **不喂答案**。用提问、追问、类比带你把知识自己推理出来，而不是把结论直接丢给你。

你带着教材来，它不讲课，只提问。答偏了它会追问，卡住了它会换类比，直到你自己把那句话说出来。

**[中文文档](#中文文档) · [English](#english)**

---

# 中文文档

## 这是什么

一个纯前端的本地学习工具。你把教材（PDF / Word / TXT / Markdown）丢给它，它按课时拆开，用苏格拉底式提问带你逐课啃下来；每节课后自动生成知识总结卡和四选一测验，还能让几位"老师"群聊点评你的表现。

它本身不含任何模型——所有回答都通过你自己的大模型 API Key 实时生成，直连服务商，不经过中间服务器。

## 需要什么环境

| 依赖 | 是否必需 | 说明 |
|---|---|---|
| **Python 3.6+** | Windows 双击启动必需 | 只用来起一个本地静态服务器，**不需要装任何第三方库**（标准库自带） |
| **现代浏览器** | 必需 | Chrome / Edge / Firefox / Safari 的近期版本 |
| **大模型 API Key** | 必需 | 任意 OpenAI 兼容接口的都行，见下表 |
| **网络** | 调用模型时需要 | 页面本身完全离线运行 |
| **Node.js 18+** | 可选 | 只有想用 Vite 热更新、跑测试或 lint 时才需要 |

**不需要**：数据库、后端服务、Docker、翻墙（只要你能访问所选的模型接口）。

官方支持的接口预设（打开应用后在设置里选，其余手填 Base URL 亦可）：

| 服务商 | Base URL | 模型名示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | 自选 |
| 任意 OpenAI 兼容服务 | 手填 | 手填 |

## 三步跑起来

### 第 1 步：启动

**Windows**：双击 `start.bat`。

会弹出一个黑色窗口，显示 `Socratopia v0 is running` 和网址 `http://127.0.0.1:8199`，约 1 秒后浏览器自动打开。

> 这个窗口就是服务器，**用的时候别关**；关掉它 = 停止服务。下次用再双击一次即可。

**macOS / Linux**：

```bash
cd socratopia-v0
python3 serve.py          # 或 python3 -m http.server 8199 --bind 127.0.0.1
```

然后浏览器打开 `http://127.0.0.1:8199`。

> ⚠️ **不要双击 `index.html` 用 `file://` 打开**。项目用了 ES Module，浏览器对本地文件有 CORS 限制，会白屏或功能失效，必须走 http 服务。

### 第 2 步：填 API Key

打开应用后点右上角 **⚙️ 设置**：

1. 选择「服务商预设」（或直接手填 Base URL）
2. 粘贴 **API Key**
3. 填 **模型名**
4. 点 **🔌 测试连接** —— 出现「✅ 连接正常」就说明通了

Key 只存在你这台浏览器的 localStorage 里，不会上传到任何地方，也不会写进代码。

### 第 3 步：开始学习

1. 左侧「📖 我的课程」→ 点「＋ 新增」，起个课程名
2. 把教材文本粘进资料框，或点上传文件（支持 **PDF / EPUB / TXT / Markdown / Word(.docx)**）
3. 资料会按课时自动拆分，从第一课开始上课
4. 跟着老师的提问回答——**答错不要紧，它就是要你自己推出来**
5. 下课会生成知识总结卡 + 四选一测验，之后可以随时在「记忆 / 收藏」里回看

## 常见问题

**双击 `start.bat` 窗口一闪就没了**
去 https://www.python.org/downloads/ 装 Python 3，安装时**勾选 "Add python.exe to PATH"**。已经装过但还闪退的，在命令行敲 `python --version` 看是否有输出——如果没有，多半是装了 Microsoft Store 版本或没进 PATH。

**提示 `Cannot start on 127.0.0.1:8199`**
已经有一份在跑了。去任务栏找那个黑窗口关掉，或者直接浏览器打开 `http://127.0.0.1:8199` 继续用。

**测试连接报「网络 / CORS 拦截」**
放行浏览器直连该接口，或换一个允许浏览器直连的服务商。用 `http://127.0.0.1:8199` 访问（而不是 `file://`）能避免大部分此类问题。

**测试连接报 HTTP 404**
Base URL 路径不对。多数服务商要求**末尾带 `/v1`**，例如 `https://api.deepseek.com/v1`，少了这一层就会 404。

**换了端口，课程和记录全不见了？**
数据按「协议 + 域名 + 端口」隔离，换了端口等于换了一个存储空间。解决办法：旧端口下 ⚙️ 设置 →「⤓ 导出配置」下载 `.json`，新端口下「⤒ 导入配置」选它恢复。

**数据存哪？会不会被上传？**
全部在浏览器 localStorage（资料、聊天记录、记忆、收藏、角色、API Key）。没有任何服务器、没有埋点、没有账号体系。清除浏览器数据会一并清掉，重要进度请定期「导出配置」备份。

## 换肤与自定义

- **明暗主题**：右上角 🌓 一键切换，偏好存本机。样式全在 `styles.css`，由 CSS 变量驱动。
- **自定义老师**：设置 →「角色」→「＋ 新建角色」，填姓名、称呼、开场白、人设背景、语气；也可以点「✨ 自动补全」让模型一键生成。存本机，随导出配置一起备份。
- **调引导风格**：改 `config.js` 里的引导规则文本，或 `roles/*.js` 里的角色人设，一般不用碰 `app.js`。
- **看用量与缓存命中**：设置 →「💾 数据与备份」→「本次会话用量」，累计所有请求的 token、缓存命中率与输出量（刷新页面清零）。想在末尾看到估算金额，先在 `config.js` 的 `pricing` 里填你所用服务商的单价（默认不填，只显示 token）。
- **缓存布局**：`config.js` 的 `cacheLayout` 决定「每轮都会变的那段提示词」放在哪。默认 `"tail"` 把它排在历史对话之后，于是「静态规则 + 到上一轮为止的全部历史」都能命中前缀缓存；若某家服务商拒收非首位的 system 消息（报 400 且提到 system / role），改成 `"head"` 即可，功能不受影响、只是命中率回落。

## 可选：开发与测试

需要 Node.js 18+。

```bash
npm install          # 首次
npm run dev          # Vite 开发服务器，改样式即时热更新（HMR）
npm test             # 纯逻辑单元测试，无需浏览器
npm run lint         # ESLint
npm run test:e2e     # Playwright 端到端测试（需先装浏览器内核）
```

**改哪里？**

- 引导规则 / 角色注册表 → `config.js`
- 角色人设 → `roles/*.js`（复制一份改改，再在 `app.js` 顶部加一行 `import`）
- 纯逻辑、解析、裁剪 → `js/core.js` 等模块，保持无 DOM 依赖，便于单测
- 样式 → `styles.css`

## 可选：打包成独立 exe

```bash
build.bat
```

会先同步源码到 `_build/webapp/`，再用 PyInstaller 打包出 `Socratopia.exe`（双击运行，端口 8199）。需要 `pip install pyinstaller`。

## 目录结构

```
socratopia-v0/
├── index.html          # 页面骨架（设置面板、侧栏、聊天区、各浮层）
├── styles.css          # 全部样式（条纹主题，CSS 变量驱动，含暗色）
├── serve.py            # 本地静态服务器（start.bat 调用）
├── start.bat           # Windows 一键启动
├── config.js           # 引导规则、模型默认参数、角色注册表（ESM 导出）
├── app.js              # 应用主逻辑入口
├── vite.config.mjs     # Vite 配置（仅开发服务器用；打包走 build.bat）
├── js/
│   ├── core.js         # 纯函数核心（无 DOM 依赖，可单测）
│   ├── api.js          # 模型接口：超时、重试、流式、取消
│   ├── prompt.js       # 提示词拼装
│   ├── outline.js      # 教材拆分与课时规划
│   ├── store.js        # localStorage 读写
│   ├── dom.js          # DOM 引用表 / 存储键名 / 小工具
│   └── *.test.mjs      # 各模块单测
├── roles/              # 角色卡（独立文件，与授课逻辑零耦合）
├── vendor/             # 第三方库（pdf.js / JSZip / mammoth，本地加载，不走 CDN）
├── tests/e2e/          # Playwright 端到端测试
├── _build/             # PyInstaller 打包脚本（launcher.py / Socratopia.spec）
├── build.bat           # 打包成独立 exe
└── package.json
```

## 关于内置角色（重要）

`roles/` 下的两个内置角色是**版权示例种子**，用来演示角色卡的结构。**商用前请删掉，换成原创角色**，或让用户自己在设置里创建。

## 许可

本仓库尚未声明开源许可证。**没有许可证 ≠ 可以自由使用**——按默认版权规则，作者保留全部权利，他人只能查看、不能复制分发。

计划开源的话，请先选定并添加一个 `LICENSE` 文件（如 MIT / Apache-2.0 / AGPL-3.0），再在 README 里写明。注意与上文「内置角色是版权示例种子」一节配合：换掉角色后再定许可证更稳妥。

---

# English

## What this is

A purely front-end, local-first learning tool. You feed it your textbook (PDF / Word / TXT / Markdown); it splits the material into lessons and walks you through them by **asking questions instead of giving answers**. Each lesson ends with a summary card and a four-option quiz, and a panel of "teachers" can review how you did.

The app ships without any model. Every reply is generated live through **your own** LLM API key, sent straight to the provider — no intermediary server.

**[中文文档](#中文文档) · [English](#english)**

## Requirements

| Dependency | Required? | Notes |
|---|---|---|
| **Python 3.6+** | Yes, for the double-click launcher on Windows | Used only to serve static files. **No third-party packages needed** — standard library only. |
| **A modern browser** | Yes | Recent Chrome / Edge / Firefox / Safari |
| **An LLM API key** | Yes | Any OpenAI-compatible endpoint |
| **Network access** | Only when calling the model | The app itself runs fully offline |
| **Node.js 18+** | Optional | Only for Vite HMR, tests, or linting |

**Not needed**: database, backend, Docker, VPN (as long as you can reach your chosen provider).

Built-in provider presets (selectable in Settings; anything OpenAI-compatible works too):

| Provider | Base URL | Example model |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| Qwen (DashScope) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| SiliconFlow | `https://api.siliconflow.cn/v1` | your pick |
| Any OpenAI-compatible | enter manually | enter manually |

## Run it in three steps

### 1. Start the server

**Windows**: double-click `start.bat`.

A console window opens showing `Socratopia v0 is running` and the URL `http://127.0.0.1:8199`; your browser opens about a second later.

> That window **is** the server — keep it open while you use the app. Closing it stops the server. Just double-click again next time.

**macOS / Linux**:

```bash
cd socratopia-v0
python3 serve.py          # or: python3 -m http.server 8199 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8199` in your browser.

> ⚠️ **Do not open `index.html` directly via `file://`.** The project uses ES Modules, and browsers block module loading from local files (CORS). It must be served over HTTP.

### 2. Add your API key

Click the **⚙️ Settings** button in the top-right corner:

1. Pick a **provider preset** (or type the Base URL yourself)
2. Paste your **API key**
3. Enter the **model name**
4. Click **🔌 Test connection** — you should see a success message

The key is stored only in your browser's localStorage. It is never uploaded anywhere and never written into the source code.

### 3. Start learning

1. In **My Courses** on the left, click **+ New** and give the course a name
2. Paste your textbook text, or upload a file (**PDF / EPUB / TXT / Markdown / Word(.docx)**)
3. The material is split into lessons automatically; you start at lesson one
4. Answer the teacher's questions — **getting it wrong is fine, that's the point**
5. When a lesson ends you get a summary card plus a quiz; review them later from the memory/bookmarks panel

## Troubleshooting

**The `start.bat` window flashes and closes**
Install Python 3 from https://www.python.org/downloads/ and **tick "Add python.exe to PATH"** during setup. If Python is already installed, run `python --version` in a terminal — no output usually means a Microsoft Store stub or a missing PATH entry.

**`Cannot start on 127.0.0.1:8199`**
Another instance is already running. Close that console window, or simply open `http://127.0.0.1:8199` and keep using it.

**Test connection reports a network / CORS error**
Allowing direct browser access to that endpoint, or switch to a provider that supports browser-origin requests. Serving the app from `http://127.0.0.1:8199` (rather than `file://`) avoids most of these cases.

**Test connection returns HTTP 404**
Your Base URL path is off. Most providers need a trailing `/v1`, e.g. `https://api.deepseek.com/v1`.

**My courses disappeared after changing the port**
localStorage is scoped per origin, so a different port is a different storage bucket. Fix: on the old port, Settings → **Export config** (downloads a `.json`); on the new port, **Import config** with that file.

**Where is my data? Is anything uploaded?**
Everything lives in browser localStorage — material, chat history, memory, bookmarks, custom roles, API key. No server, no telemetry, no accounts. Clearing browser data wipes it, so export a config backup for anything important.

## Theming and customization

- **Light / dark**: toggle with 🌓 in the top-right; the preference is stored locally. All styling lives in `styles.css`, driven by CSS variables.
- **Custom teachers**: Settings → Roles → **+ New role**. Fill in name, how they address you, opening line, persona, and tone — or use **✨ Auto-generate** to have the model draft it. Stored locally and included in config exports.
- **Tuning the teaching style**: edit the guidance rules in `config.js` or the personas in `roles/*.js`; you generally won't need to touch `app.js`.
- **Token usage and cache hit rate**: Settings → **Data & backup** → **This session** shows cumulative tokens, cache hit rate, and output volume across all requests (cleared on reload). To also see an estimated cost, fill in your provider's per-million prices under `pricing` in `config.js` (left at 0 by default, so only tokens are shown).
- **Cache layout**: `cacheLayout` in `config.js` decides where the per-turn volatile block goes. The default `"tail"` places it after the conversation history, so the static rules plus all history up to the previous turn stay cacheable as a stable prefix. If a provider rejects system messages in non-first position (HTTP 400 mentioning system / role), switch it to `"head"` — behaviour is unchanged, only the hit rate drops.

## Development and tests (optional)

Requires Node.js 18+.

```bash
npm install          # first time
npm run dev          # Vite dev server with HMR
npm test             # pure-logic unit tests, no browser needed
npm run lint         # ESLint
npm run test:e2e     # Playwright end-to-end tests (requires browser binaries)
```

**Where to change things**

- Guidance rules / role registry → `config.js`
- Role personas → `roles/*.js` (copy a file, edit it, add one `import` line in `app.js`)
- Pure logic, parsing, context trimming → `js/core.js` and friends (keep them DOM-free so they stay unit-testable)
- Styling → `styles.css`

## Build a standalone exe (optional)

```bash
build.bat
```

Syncs the source into `_build/webapp/` and packages it with PyInstaller into `Socratopia.exe` (double-click to run, port 8199). Requires `pip install pyinstaller`.

## Project layout

```
socratopia-v0/
├── index.html          # Page skeleton (settings panel, sidebar, chat area, overlays)
├── styles.css          # All styling (striped theme, CSS-variable driven, dark mode included)
├── serve.py            # Local static server (called by start.bat)
├── start.bat           # One-click launcher for Windows
├── config.js           # Guidance rules, model defaults, role registry (ESM exports)
├── app.js              # Main application logic
├── vite.config.mjs     # Vite config (dev server only; packaging goes through build.bat)
├── js/
│   ├── core.js         # Pure-function core (DOM-free, unit-testable)
│   ├── api.js          # Model transport: timeouts, retries, streaming, cancellation
│   ├── prompt.js       # Prompt assembly
│   ├── outline.js      # Material splitting and lesson planning
│   ├── store.js        # localStorage access
│   ├── dom.js          # DOM refs / storage keys / small helpers
│   └── *.test.mjs      # Per-module unit tests
├── roles/              # Role cards (standalone files, decoupled from teaching logic)
├── vendor/             # Third-party libs (pdf.js / JSZip / mammoth, served locally, no CDN)
├── tests/e2e/          # Playwright end-to-end tests
├── _build/             # PyInstaller packaging scripts (launcher.py / Socratopia.spec)
├── build.bat           # Package into a standalone exe
└── package.json
```

## A note on the bundled roles (important)

The two roles shipped in `roles/` are **copyrighted sample seeds** that demonstrate the role-card structure. **Remove them before any commercial use** and replace them with original characters, or let users create their own in Settings.

## License

This repository does not declare an open-source license yet. **No license is not the same as free to use** — under default copyright, the author retains all rights and others may view but not copy or redistribute.

If you intend to open-source it, add a `LICENSE` file first (MIT / Apache-2.0 / AGPL-3.0, etc.) and state it here. Note the interaction with the "bundled roles" section above: replacing the sample characters before choosing a license is the safer order.
