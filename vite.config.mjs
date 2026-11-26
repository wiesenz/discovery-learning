import { defineConfig } from "vite";

/* =====================================================================
 *  Socratopia v0 · Vite 配置（.mjs，避免 Vite 8 原生 config loader 告警）
 *  ---------------------------------------------------------------------
 *  用途只有一个：dev server（HMR 热更新，改样式/布局即时生效，端口 8199）。
 *  `start.bat` 优先走它，没有 Node 时回退 python -m http.server。
 *
 *  ⚠️ 20260913 删掉了原来的 build 分支（约 25 行：copyStaticAssets 插件 + outDir 配置），
 *     因为**它没有任何消费者**：
 *       · `build.bat`（唯一的打包流水线）不调用 vite build —— 它用 robocopy 把原始源码
 *         同步进 _build/webapp/ 再交给 PyInstaller。exe 里跑的是【未打包的源码】。
 *       · 全库 grep "vite build" 只命中 package.json 的脚本定义和本文件的注释。
 *       · 它还把 Vite 的产物目录设成 dist/ —— 与 PyInstaller 的输出目录**是同一个**，
 *         于是 build.bat 末尾的 `rmdir dist` 会因目录非空而静默失败（错误被 >nul 吞掉），
 *         "项目里只保留一个 exe"的保证并不成立。
 *     按本仓库自己的原则（js/store.js 开头：避免投机设计，需要时再加）：
 *     等真的出现 Web 部署这类消费者，再把 build 配置加回来（git 历史里有）。
 *
 *  说明：vendor/ 下 3 个库（pdf/jszip/mammoth）与 js/core.js 都是 classic <script> 全局加载，
 *  不进 bundle —— 这也是当初 build 需要一个复制插件的原因。dev 模式下 Vite 直接按原路径
 *  服务这些文件，不需要任何插件。
 * ===================================================================== */

export default defineConfig({
  server: {
    port: 8199,
    host: "127.0.0.1",
    open: true, // npm run dev 自动打开浏览器
    // 端口被占用时直接报错退出，绝不自动顺延到 8200/8201。
    // 理由：学习记录存在浏览器 localStorage，按 origin（协议+主机+端口）隔离——
    // 换端口 = 用户看到空数据，效果等同"记录被清空"。宁可启动失败，也不能悄悄换。
    // （_build/launcher.py 对 exe 入口有同样的硬约束；python -m http.server 亦然。）
    strictPort: true,
  },
  // 没有 build 段：本配置只服务 dev server。
  // （留空而不是写 outDir: "dist" —— 那会和 PyInstaller 的输出目录撞车，见文件头说明。）
});
