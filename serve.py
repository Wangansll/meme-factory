#!/usr/bin/env python3
"""静态开发服务器（gzip 版），替掉 `python -m http.server`。

用法：  python serve.py            # 默认 8770
        python serve.py 8771       # 换端口

和 http.server 的区别：
  1. 文本资源按 Accept-Encoding 做 gzip（three.module.min.js 655KB → ~160KB）；
  2. 补上 .glb / .gltf / .wasm 的 MIME；
  3. html 走 no-cache，改完刷新生效，不用记版本号。
仍然只是开发用，别拿去上生产。
"""
import gzip
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

GZIP_EXTS = {".js", ".mjs", ".css", ".html", ".htm", ".json", ".svg", ".map", ".txt", ".md", ".webmanifest"}
EXTRA_TYPES = {
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".wasm": "application/wasm",
    ".webp": "image/webp",
    ".avif": "image/avif",
}


class Handler(SimpleHTTPRequestHandler):
    def guess_type(self, path):
        ext = os.path.splitext(str(path))[1].lower()
        if ext in EXTRA_TYPES:
            return EXTRA_TYPES[ext]
        ctype = super().guess_type(path)
        if ctype.startswith("text/") and "charset" not in ctype:
            ctype += "; charset=utf-8"
        return ctype

    def do_GET(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            index = os.path.join(path, "index.html")
            if not os.path.exists(index):
                return self.send_error(404, "Directory listing disabled")
            path = index
        if not os.path.exists(path):
            return self.send_error(404, "File not found")

        with open(path, "rb") as f:
            body = f.read()

        ext = os.path.splitext(path)[1].lower()
        gz = None
        wants = "gzip" in self.headers.get("Accept-Encoding", "").lower()
        if wants and ext in GZIP_EXTS and len(body) > 1024:
            gz = gzip.compress(body, 6)

        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(path))
        if gz is not None:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
            body = gz
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache" if ext in {".html", ".htm"} else "public, max-age=60")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_HEAD(self):
        self.do_GET()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
    handler = partial(Handler, directory=os.getcwd())
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving {os.getcwd()} on http://127.0.0.1:{port}/  (gzip on)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
