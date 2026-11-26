"""Local static server for Socratopia v0.

Run by start.bat. Serves this folder on 127.0.0.1:8199 and opens the
default browser once the socket is listening.

Why a separate file instead of one long .bat:
  - .bat has to stay pure ASCII/CRLF to survive Windows codepage quirks;
  - "port already in use" and "python missing" are readable here.
"""
import http.server
import os
import socketserver
import sys
import threading
import webbrowser

PORT = 8199
HOST = "127.0.0.1"


def main() -> int:
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    class Handler(http.server.SimpleHTTPRequestHandler):
        def end_headers(self):
            # 开发期禁用缓存，改完刷新就能看到
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

    try:
        socketserver.TCPServer.allow_reuse_address = True
        httpd = socketserver.TCPServer((HOST, PORT), Handler)
    except OSError as exc:
        print()
        print("[ERROR] Cannot start on %s:%d -> %s" % (HOST, PORT, exc))
        print("Another copy may already be running. Close it, then retry.")
        return 1

    url = "http://%s:%d/" % (HOST, PORT)
    print("=" * 44)
    print(" Socratopia v0 is running")
    print(" " + url)
    print(" Close this window to stop the server.")
    print("=" * 44)
    print()

    # 测试/无头环境可用 SOCRA_NO_BROWSER=1 跳过自动开浏览器
    if os.environ.get("SOCRA_NO_BROWSER") != "1":
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
