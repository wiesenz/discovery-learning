const { defineConfig } = require("@playwright/test");

// Playwright E2E 配置：通过本地静态服务器（tests/e2e/serve.js）以 http 模式加载应用。
// 注意：应用主打 file:// 双击即用，但 E2E 必须在 http 下进行（角色 <script> 与 fetch 在 file:// 下受限）。
module.exports = defineConfig({
  testDir: "./tests/e2e",
  // 注意：不要写 testMatch 限定文件名，否则以后新增的 *.spec.js 会被静默排除
  timeout: 30000,
  expect: { timeout: 5000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8198", // 测试专用端口，与应用默认 8199 错开，避免跑测试时撞上已启动的应用
    headless: true,
    launchOptions: {
      // 把一切外部域名解析到本机端口 1（立即 ERR_CONNECTION_REFUSED），127.0.0.1 除外。
      // 原因：index.html 从 fonts.loli.net / fonts.gstatic.com 加载字体；<link> 后面跟着
      // <script>，脚本要等 CSSOM，于是连 domcontentloaded 都被外部字体请求拖住。
      // 外网慢时多等几秒、断网时挂到超时——表现为每轮随机挂不同的用例，重试又能过。
      // 阻断后外部请求瞬间失败，测试与外网状况解耦。测试不校验字体，功能无损失。
      args: ["--host-resolver-rules=MAP * 127.0.0.1:1, EXCLUDE 127.0.0.1"],
    },
    trace: "retain-on-failure",      // 失败时留 trace，便于查现场
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node tests/e2e/serve.js",
    url: "http://127.0.0.1:8198",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
