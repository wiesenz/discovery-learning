import http.server
import socketserver
import webbrowser
import tempfile
import os
import sys
import time
import socket
import threading
import urllib.request
import html
import shutil
import glob
import ctypes

# 调试开关：SOCRATOPIA_TRACE=1 时打印接管/关闭的关键路径（测试用，生产不打印）
TRACE = os.environ.get("SOCRATOPIA_TRACE") == "1"
# 调试开关：SOCRATOPIA_NO_BROWSER=1 时不自动打开浏览器（测试用，隔离"浏览器连接"变量）
NO_BROWSER = os.environ.get("SOCRATOPIA_NO_BROWSER") == "1"


def trace(msg):
    if TRACE:
        print(f"[trace] {msg}", flush=True)


# ---------- 启动日志（console=False 也能量化排查慢/打不开） ----------
def _log_path():
    try:
        d = os.path.join(os.environ.get("LOCALAPPDATA", tempfile.gettempdir()), "Socratopia")
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, "Socratopia.log")
        try:
            if os.path.getsize(p) > 512 * 1024:  # 超过 512KB 截断重写，避免无限增长
                open(p, "w").close()
        except OSError:
            pass
        return p
    except Exception:
        return None


LOG_PATH = _log_path()


def log(msg):
    if not LOG_PATH:
        return
    try:
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (ts, msg))
    except Exception:
        pass


# ---------- 单实例互斥锁（避免双击多次互相抢端口、产废进程） ----------
def acquire_instance_lock():
    """返回 handle=拿到锁；False=已被其他实例持有；None=取锁异常（放行，避免进不来）"""
    try:
        kernel32 = ctypes.windll.kernel32
        mutex = kernel32.CreateMutexW(None, 0, "Global\\Socratopia_SingleInstance")
        if not mutex:
            return None
        if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
            kernel32.CloseHandle(mutex)
            return False
        return mutex
    except Exception as e:
        log("acquire_instance_lock error: %r" % e)
        return None


def activate_existing_instance():
    """已有实例在跑：最多等 20s 让其 HTTP 服务就绪，然后拉起浏览器并退出。"""
    if NO_BROWSER:  # 测试/静默模式：不弹不连，直接退出
        return
    deadline = time.time() + 20
    while time.time() < deadline:
        if port_in_use(PORT) and is_our_app(PORT):
            try:
                webbrowser.open(f"http://127.0.0.1:{PORT}/index.html")
            except Exception:
                pass
            log("activated existing instance")
            return
        time.sleep(0.5)
    log("activate timeout; opening browser anyway")
    try:
        webbrowser.open(f"http://127.0.0.1:{PORT}/index.html")
    except Exception:
        pass


# ---------- 清理上一次异常退出遗留的 _MEI 解压目录 ----------
def cleanup_stale_mei():
    if not getattr(sys, "frozen", False):
        return
    mei = getattr(sys, "_MEIPASS", None)
    td = tempfile.gettempdir()
    for d in glob.glob(os.path.join(td, "_MEI*")):
        try:
            if mei and os.path.abspath(d) == os.path.abspath(mei):
                continue  # 不删自己正在用的目录
            shutil.rmtree(d, ignore_errors=True)
            log("removed stale _MEI: %s" % d)
        except Exception as e:
            log("skip _MEI %s: %r" % (d, e))


# 学习记录绑定端口：浏览器 localStorage 按 origin（协议+主机+端口）隔离，
# 数据都在 127.0.0.1:8199 下。**永远只绑这个端口**，绝不换端口（换端口=看到空数据）。
PORT = 8199
MAX_WAIT_SHUTDOWN = 6  # 秒：等旧实例让出端口
# 每次发版递增：前端据此提示「应用已更新，点击刷新」，避免旧标签页对新版本无感知
VERSION = "20260914.1"

# 服务是否被显式关闭（/__shutdown__ 或 Ctrl+C）。看门狗据此区分"正常退出"与"意外崩溃"。
intentional_shutdown = threading.Event()
MAX_SERVE_RESTARTS = 5


def web_root():
    # 优先实时服务 exe 同目录的项目源码（index.html / js/ / styles.css / roles/ / vendor/）——
    # 改完源码刷新浏览器即最新，无需重打包。build.bat 正是把 exe 拷到项目根，故常态命中这一支。
    # 兜底：exe 被单独拷走（同目录没有源码）时，退回 PyInstaller 冻结进包内的 webapp/，
    # 这样「单文件 exe」与「实时源码」两种用法都成立（spec 仍用 datas 打进 webapp）。
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(sys.executable)
        if os.path.isfile(os.path.join(exe_dir, "index.html")):
            return exe_dir
        bundled = os.path.join(getattr(sys, "_MEIPASS", ""), "webapp")
        if os.path.isfile(os.path.join(bundled, "index.html")):
            return bundled
        return exe_dir  # 两处都没有：交由 main() 的统一报错给出可行动提示
    # 开发态：本文件在 _build/，项目根在其上一级
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=web_root(), **kwargs)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        # 静态资源一律不缓存。
        # 起因：SimpleHTTPRequestHandler 只发 Last-Modified、不发 Cache-Control，
        # 浏览器于是启用「启发式缓存」——自行按「距上次改动时长的约 10%」判定免检期。
        # index.html 改动后隔几小时再打开，免检期可长达一小时，于是出现
        # 「源码明明改了，页面还是旧的」，非 Ctrl+Shift+R 不生效。
        # 本项目 exe 常态直接服务磁盘源码（见 web_root），改了就该立刻可见；
        # 本地读盘成本可忽略，不值得为它冒「看到旧代码」的风险。
        # 附带好处：/__version__ 也逐次取真值，否则前端「已更新，请刷新」的检测
        # 会被缓存架空 —— 它本来就是靠轮询这个端点发现新版本的。
        # 注：此处改的是打包进 exe 的启动器，需重跑 build.bat 才生效。
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        try:
            if self.path == "/__health__":
                # 探活接口：新启动的实例据此确认 8199 上跑的是不是本应用（不触发关闭）
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(b"Socratopia:ok")
                return
            if self.path == "/__version__":
                # 版本接口：前端据此检测「服务已更新，需要刷新」
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(VERSION.encode("utf-8"))
                return
            if self.path == "/__shutdown__":
                intentional_shutdown.set()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(b"Server shutting down.")
                # Shutdown in a separate thread to avoid deadlock
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                # 兜底：0.3s 后强制退出，确保端口一定释放，不留僵尸实例占着 8199
                threading.Thread(target=lambda: (time.sleep(0.3), os._exit(0)), daemon=True).start()
                return
            super().do_GET()
        except Exception as e:
            log("do_GET exception: path=%s err=%r" % (self.path, e))
            try:
                self.send_response(500)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(b"Internal Server Error")
            except Exception:
                pass


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    # 接管旧实例后端口可能处于 TIME_WAIT，允许立即复用，否则新实例绑不上 8199。
    # ⚠️ Windows 上这也意味着 bind 不再能反映"端口是否被别人占用"——见 main() 里
    #    「权威占用判定」那段（用 connect_ex 判占用，不拿 bind 成功当依据）。
    allow_reuse_address = True
    # 每连接一线程：浏览器/探测产生的"连接后立即断开"等异常连接不会卡死整个服务
    daemon_threads = True


def http_get(port, path):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=2) as r:
            body = r.read(200)
            trace(f"GET {path} -> {r.status} {body[:30]!r}")
            return r.status, body
    except Exception as e:
        trace(f"GET {path} -> EXC {e}")
        return None, b""


def port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0


def is_our_app(port):
    # 新版 launcher：/__health__ 返回 "Socratopia:ok"（纯探活，不关闭）
    status, body = http_get(port, "/__health__")
    if status == 200 and body.startswith(b"Socratopia:"):
        return True
    # 旧版 launcher 只有 /__shutdown__：返回 "Server shutting down."，且 GET 即触发关闭
    status, body = http_get(port, "/__shutdown__")
    return status == 200 and body.startswith(b"Server shutting down")


def wait_port_free(port, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if not port_in_use(port):
            trace("wait_port_free: free")
            return True
        time.sleep(0.2)
    trace("wait_port_free: TIMEOUT (still busy)")
    return False


def open_browser(port):
    time.sleep(1.2)
    try:
        webbrowser.open(f"http://127.0.0.1:{port}/index.html")
    except Exception:
        pass


def show_error(title, msg):
    # 测试/静默模式：不弹任何界面（也避免测试期间误报打扰）
    if NO_BROWSER:
        return
    # 优先：Windows 原生错误框（最可靠，不依赖浏览器关联）
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, msg, title, 0x10)  # MB_OK | MB_ICONERROR
        return
    except Exception:
        pass
    # 备用：写临时 HTML 用默认浏览器打开（file:// 有浏览器关联，不弹系统报错）
    try:
        import tempfile
        p = os.path.join(tempfile.gettempdir(), "socratopia_error.html")
        with open(p, "w", encoding="utf-8") as f:
            f.write("<!doctype html><meta charset='utf-8'><body style='font-family:system-ui;"
                    "padding:40px;line-height:1.8'><h2>" + html.escape(title) + "</h2><p>"
                    + html.escape(msg).replace("\n", "<br>") + "</p></body>")
        webbrowser.open("file://" + p.replace("\\", "/"))
    except Exception:
        pass


def main():
    t0 = time.time()
    log("=== launch start (frozen=%s) ===" % getattr(sys, "frozen", False))
    lock = acquire_instance_lock()
    if lock is False:
        # 已有实例在跑：它可能是【旧版本】（代码过期）。与其“只打开浏览器到旧实例就退出”，
        # 不如主动关掉旧实例、本进程接管端口，确保用户双击拿到的是【最新】代码——
        # 否则用户反复双击新 exe，浏览器却一直连着旧实例，表现为“修复不生效 / 功能像坏了”。
        log("another instance detected -> shutdown old & take over")
        if is_our_app(PORT):
            http_get(PORT, "/__shutdown__")
            wait_port_free(PORT, MAX_WAIT_SHUTDOWN)
        else:
            # 端口被非本应用占用：先等其释放；仍占用则下方 bind 会再兜底报错
            wait_port_free(PORT, 10)
        # 旧进程退出后互斥锁会释放，重新尝试拿锁
        lock = acquire_instance_lock()
        if lock is False:
            # 极端情况仍有别的实例（例如第三个），退化为“激活已存在实例”，避免反复弹出
            log("re-acquire failed -> activate + exit")
            activate_existing_instance()
            return
        # 拿到锁，继续往下走 serving 流程（was_running 会在下面做 bind 兜底）
    cleanup_stale_mei()
    root = web_root()
    if not os.path.isfile(os.path.join(root, "index.html")):
        show_error(
            "Socratopia 启动失败",
            "没找到网页文件 index.html。\n\n"
            "Socratopia.exe 需要和项目源码放在同一层目录（index.html、js/、"
            "styles.css、roles/、vendor/ 都在它旁边），或者使用打包了网页的完整版 exe。\n\n"
            "当前查找位置：" + root,
        )
        return

    was_running = port_in_use(PORT)  # 启动前 8199 是否已被占用（= 是否接管旧实例）
    log("port_in_use=%s" % was_running)
    trace("start: port_in_use=%s" % was_running)
    if was_running:
        ours = is_our_app(PORT)
        log("is_our_app=%s" % ours)
        trace("is_our_app=%s" % ours)
        if ours:
            # 8199 被我们自己的旧实例占着：先把它关掉再接管端口。
            # 学习记录存在浏览器侧（:8199 的 localStorage），重启服务不丢数据。
            http_get(PORT, "/__shutdown__")  # 新版走这个显式关闭（旧版在探测时已触发）
            wait_port_free(PORT, MAX_WAIT_SHUTDOWN)
        else:
            # 不是本应用（别的程序 / 无法识别的旧版本）：等它自己释放，最多 10s
            wait_port_free(PORT, 10)

    # 【权威占用判定，勿删】不能拿"bind 成功"当端口空闲的依据。
    # Windows 的 SO_REUSEADDR 语义与 Linux 不同：Server.allow_reuse_address = True 时，
    # 即使 8199 已被【别的程序】监听，本进程 bind 依然会"成功"——两个服务同时监听同一端口，
    # 浏览器实际连到的是先到的那个，表现为"启动成功但页面是别人的/打不开"。
    # （2026-09-13 实测复现：一个 python -m http.server 占着 8199，本启动器仍打印
    #  "bound OK, serving" 并进入 serve_forever，用户侧毫无提示。）
    # connect_ex 是平台无关的真实判定：能连上就说明有人已经在监听。
    # 此处绝不换端口——学习记录在 127.0.0.1:8199 的 localStorage 里，换端口 = 记录"消失"。
    if port_in_use(PORT):
        log("port %d still occupied by a foreign process -> abort (never fallback)" % PORT)
        show_error(
            "端口 8199 被其他程序占用",
            "Socratopia 的学习记录保存在浏览器 127.0.0.1:8199 这个地址下，"
            "换端口会导致记录“看不到”（效果等同清空），因此本程序不会自动改用别的端口。\n\n"
            "请先关闭占用 8199 的其他程序，再重新启动 Socratopia。\n\n"
            "不确定是谁占用时：在「命令提示符」里执行\n"
            "    netstat -ano | findstr :8199\n"
            "记下最后一列的 PID，再到「任务管理器 → 详细信息」按 PID 找到并结束该进程。",
        )
        return

    trace("binding 127.0.0.1:%d ..." % PORT)
    try:
        httpd = Server(("127.0.0.1", PORT), Handler)
    except OSError as e:
        log("bind failed once: %r" % e)
        time.sleep(3)
        try:
            httpd = Server(("127.0.0.1", PORT), Handler)
        except OSError as e2:
            trace("bind OSError: %r" % e2)
            show_error(
                "端口 8199 被其他程序占用",
                "Socratopia 的学习记录保存在浏览器 127.0.0.1:8199 这个地址下，"
                "换端口会导致记录“看不到”（效果等同清空）。\n\n"
                "请先关闭占用 8199 的其他程序，再重新启动 Socratopia。",
            )
            return
    trace("bound OK, serving")
    log("serving on 127.0.0.1:%d (cold start ok, %.1fs)" % (PORT, time.time() - t0))
    # 只有「冷启动」（此前没有本应用在跑）才自动开浏览器；
    # 接管已有实例时不开新标签页（用户通常已有打开的页签，避免反复双击弹出一堆标签页）
    if not NO_BROWSER and not was_running:
        threading.Thread(target=open_browser, args=(PORT,), daemon=True).start()
    restart_count = 0
    try:
        while restart_count <= MAX_SERVE_RESTARTS and not intentional_shutdown.is_set():
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                intentional_shutdown.set()
                break
            except Exception as e:
                restart_count += 1
                log("serve_forever crashed (restart %d/%d): %r" % (restart_count, MAX_SERVE_RESTARTS, e))
                if restart_count > MAX_SERVE_RESTARTS:
                    log("too many serve_forever restarts, giving up")
                    break
                time.sleep(1)
                continue
            # serve_forever returned normally = intentional shutdown
            break
    except Exception as e:
        log("main loop fatal exception: %r" % e)
        raise
    finally:
        try:
            httpd.shutdown()
        except Exception:
            pass
        log("server stopped (restarts=%d, intentional=%s)" % (restart_count, intentional_shutdown.is_set()))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log("uncaught top-level exception: %r" % e)
        raise
