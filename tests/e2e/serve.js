// 极简静态文件服务器，仅供 Playwright E2E 本地起服务用（不依赖 python 路径）。
// 用法：node tests/e2e/serve.js  （端口可用 PORT 环境变量覆盖）
// 默认 8198：与应用默认端口 8199 错开，避免跑测试时与已启动的应用撞端口。
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", ".."); // tests/e2e -> 项目根
const PORT = process.env.PORT || 8198;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("E2E static server on http://127.0.0.1:" + PORT);
});
