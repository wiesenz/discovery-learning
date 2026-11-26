/* =====================================================================
 *  Socratopia v0 · 教材文档解析（PDF / EPUB / DOCX → 纯文本）
 *  20260902.1 从 app.js 抽出（技术债拆分第一刀）。
 *
 *  本模块零业务依赖：只吃 File 对象、吐字符串，不碰任何 app.js 状态，
 *  也不碰 DOM 元素（除 vendor 全局 pdfjsLib / JSZip / mammoth）。
 *  vendor 库以 classic <script> 方式挂到 window 上，见 index.html。
 * ===================================================================== */

/**
 * 解析 PDF，返回全文纯文本。
 * @param {File} file
 * @returns {Promise<string>}
 */
// 20260913：下面四个函数不再 export —— 它们只被本文件的 extractTextFromFile 分派调用，
// 外部（含测试）零引用。对外只保留两个入口：extractTextFromFile / extractPlainTextFile。
async function extractPdfText(file) {
  if (!window.pdfjsLib) throw new Error("PDF 解析库未加载（vendor/pdf.min.js）。");
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  let out = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map((it) => it.str).join(" ") + "\n";
  }
  return out;
}

/**
 * 相对路径归并（处理 EPUB 内部 OPF / 章节 href 的 ../ 与 ./）。
 * @param {string} baseDir
 * @param {string} href
 * @returns {string}
 */
function resolvePath(baseDir, href) {
  if (!baseDir) return href;
  const parts = (baseDir + "/" + href).split("/");
  const stack = [];
  for (const p of parts) { if (p === "." || p === "") continue; if (p === "..") stack.pop(); else stack.push(p); }
  return stack.join("/");
}

/**
 * 解析 EPUB，按 spine 顺序拼接正文章节纯文本。
 * @param {File} file
 * @returns {Promise<string>}
 */
async function extractEpubText(file) {
  if (!window.JSZip) throw new Error("EPUB 解析库未加载（vendor/jszip.min.js）。");
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  // JSZip 找不到条目时 file() 返回 null（不是抛错）。直接 .async() 会得到
  // "TypeError: Cannot read properties of null" —— 用户看到的是这种毫无行动指引的报错。
  // 20260913 修复。另外按 EPUB 规范 href 是 URI（含空格/中文的路径普遍百分号编码），
  // 而 zip 里的条目名常是解码后的裸名 —— 两种写法都试一次，再找不到才报明确错误。
  const readZipText = async (path, what) => {
    const candidates = [path];
    try {
      const dec = decodeURIComponent(path);
      if (dec !== path) candidates.push(dec);
    } catch (e) { /* 非法百分号序列：忽略，只用原样 */ }
    if (path.startsWith("/")) candidates.push(path.replace(/^\/+/, ""));
    for (const c of candidates) {
      const f = zip.file(c);
      if (f) return f.async("text");
    }
    throw new Error("EPUB 结构异常：压缩包里找不到" + what + "（" + path + "）。这个文件可能不是标准 EPUB，或已损坏。");
  };

  const container = await readZipText("META-INF/container.xml", " container.xml");
  const opfPath = (container.match(/full-path="([^"]+)"/) || [])[1];
  if (!opfPath) throw new Error("EPUB 结构异常：container.xml 里找不到 OPF 路径。");
  const opfDir = opfPath.split("/").slice(0, -1).join("/");
  const opf = await readZipText(opfPath, " OPF 文件");
  const opfDoc = new DOMParser().parseFromString(opf, "application/xml");
  const manifest = {};
  for (const it of opfDoc.getElementsByTagName("item")) {
    const id = it.getAttribute("id"), href = it.getAttribute("href");
    if (id && href) manifest[id] = resolvePath(opfDir, href);
  }
  const spine = [];
  for (const ref of opfDoc.getElementsByTagName("itemref")) {
    const p = manifest[ref.getAttribute("idref")];
    if (p) spine.push(p);
  }
  let out = "";
  const order = spine.length ? spine : Object.values(manifest);
  // 单章读不到就跳过并计数，不让一章的缺失毁掉整本书；最后一章都没读到才算失败。
  let missed = 0;
  for (const path of order) {
    let x = null;
    try { x = await readZipText(path, "该章节"); } catch (e) { missed++; continue; }
    const doc = new DOMParser().parseFromString(x, "text/html");
    out += (doc.body ? doc.body.textContent : x) + "\n\n";
  }
  if (!out.trim()) {
    throw new Error("EPUB 正文提取为空（" + missed + "/" + order.length + " 个章节都读不到）。这个文件可能不是标准 EPUB，或已损坏。");
  }
  return out.trim();
}

/**
 * 解析 DOCX，经 mammoth 转 HTML 后取纯文本。
 * @param {File} file
 * @returns {Promise<string>}
 */
async function extractDocxText(file) {
  if (!window.mammoth) throw new Error("Word 解析库未加载（vendor/mammoth.browser.js）。");
  const buf = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer: buf });
  const doc = new DOMParser().parseFromString(result.value || "", "text/html");
  return (doc.body ? doc.body.textContent : result.value || "").trim();
}

/**
 * 按扩展名分派到对应解析器。
 * @param {File} file
 * @returns {Promise<string>}
 */
export async function extractTextFromFile(file) {
  const name = (file && file.name ? file.name : "").toLowerCase();
  if (name.endsWith(".pdf")) return extractPdfText(file);
  if (name.endsWith(".epub")) return extractEpubText(file);
  if (name.endsWith(".docx")) return extractDocxText(file);
  throw new Error("不支持的文件类型（仅支持 PDF / EPUB / DOCX）。");
}

/**
 * 纯文本文件（.txt / .md 等）的读取。
 * 20260913 从 app.js 迁入（它本来就是"文件 → 文本"的一块，与其余解析器同源）。
 *
 * 关键：不能直接 file.text() —— 那等于【一律按 UTF-8 解码】。中文 Windows 的记事本
 * 默认存 ANSI/GBK，于是整本书被解成满篇"锟斤拷"，而且会原样入库、进提示词，
 * 全程没有任何告警，用户只会以为"这软件读不了中文"。
 * 现在先用严格 UTF-8 试解，失败再退 GBK；两者都不行才退回宽松 UTF-8（含替换字符）。
 *
 * @param {File} file
 * @returns {Promise<string>}
 */
export async function extractPlainTextFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch (e) {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch (e2) {
      return new TextDecoder("utf-8").decode(buf);
    }
  }
}
