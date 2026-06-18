#!/usr/bin/env python
"""Block D: launcher 自带只读 HTTP API。

绑 127.0.0.1:<config.http_port>(默认 17888),仅 GET,鉴权用 Bearer token。

路由:
  GET /api/status   4 个服务状态(端口是否 LISTEN) + 当前 config(隐藏 token)
  GET /api/config   同上
  GET /api/logs/<server|client|qdrant|llm>?tail=N  各 log 最后 N 行(默认 50,最多 5000)
  GET /              \u7b80\u5355 HTML(\u5d4c\u5165 /api/status \u7684\u8868\u683c + 30s \u8f6e\u8be2)
"""

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from launcher_lib import is_port_listening
from launcher_config import get_config_path


def _tail(path: str, n: int = 50, max_bytes: int = 2_000_000) -> list[str]:
    """读文件最后 n 行(简化:读尾部 max_bytes,然后 splitlines 取后 n)。"""
    if not os.path.exists(path):
        return []
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
            data = f.read().decode("utf-8", errors="replace")
        lines = data.splitlines()
        return lines[-n:]
    except OSError:
        return []


def _resolve_llm_log(repo_root: str | None = None) -> str | None:
    """返回最近的 .llm.jsonl 路径(优先 repo_root/.logs,fallback cwd/.logs)。

    今天没文件时 fallback 到 mtime 最大的(避免 server 还没启动产生新 jsonl)。
    """
    import glob
    roots = [repo_root] if repo_root else []
    roots += [os.getcwd()]
    for root in roots:
        logs_root = os.path.join(root, ".logs")
        if not os.path.isdir(logs_root):
            continue
        cands = glob.glob(os.path.join(logs_root, "*", "*.llm.jsonl"))
        if cands:
            cands.sort(key=os.path.getmtime, reverse=True)
            return cands[0]
    return None



def _parse_query(url: str) -> dict[str, str]:
    if "?" not in url:
        return {}
    return dict(p.split("=", 1) for p in url.split("?", 1)[1].split("&") if "=" in p)


def _json(handler: BaseHTTPRequestHandler, status: int, payload: Any):
    body = json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _html(handler: BaseHTTPRequestHandler, body: str):
    page = ("<!doctype html><html><head><meta charset=\"utf-8\">"
            "<title>AI-Novel Launcher</title>"
            "<style>body{font-family:Consolas,monospace;background:#0d0d15;color:#c8c8d4;padding:20px;}"
            "table{border-collapse:collapse;}td,th{padding:4px 14px;border:1px solid #2a2a3a;}"
            "th{background:#16161e;color:#a0a0b8;}.r{color:#7ec87e;}.s{color:#5a5a6e;}.e{color:#ff6666;}"
            "</style></head><body>" + body + "</body></html>").encode("utf-8")
    handler.send_response(200)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Content-Length", str(len(page)))
    handler.end_headers()
    handler.wfile.write(page)


class _Handler(BaseHTTPRequestHandler):
    # 配置注入
    config: dict[str, Any] = {}
    log_paths: dict[str, str] = {}
    repo_root: str = ""

    def log_message(self, fmt, *args):
        # 静音 stdlib 默认 stderr 日志(launcher 自己会处理)
        pass

    def do_GET(self):
        # 鉴权(除了 / \u4e3a\u4eba\u673a\u9875)
        if self.path != "/" and not self.path.startswith("/?"):
            auth = self.headers.get("Authorization", "")
            expected = "Bearer " + self.config.get("auth_token", "")
            if auth != expected:
                self.send_response(401)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(b"{\"error\":\"unauthorized\"}")
                return

        path = self.path.split("?", 1)[0]
        q = _parse_query(self.path)

        if path == "/":
            return self._render_index()
        if path == "/api/status":
            return _json(self, 200, self._status_payload())
        if path == "/api/config":
            cfg = dict(self.config)
            cfg.pop("auth_token", None)
            return _json(self, 200, cfg)
        if path.startswith("/api/logs/"):
            return self._handle_logs(path, q)
        self.send_response(404)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"{\"error\":\"not found\"}")

    def _status_payload(self):
        cfg = dict(self.config)
        cfg.pop("auth_token", None)
        return {
            "services": {
                "server":  {"port": self.config.get("server_port"),  "listening": is_port_listening(self.config.get("server_port", 0))},
                "client":  {"port": self.config.get("client_port"),  "listening": is_port_listening(self.config.get("client_port", 0))},
                "qdrant":  {"port": self.config.get("qdrant_port"),  "listening": is_port_listening(self.config.get("qdrant_port", 0))},
                "llm_log": {"watching": _resolve_llm_log(self.repo_root) or ""},
            },
            "config": cfg,
            "config_path": str(get_config_path()),
        }

    def _handle_logs(self, path, q):
        name = path[len("/api/logs/"):]
        try:
            n = min(int(q.get("tail", "50")), 5000)
        except ValueError:
            n = 50
        if name == "llm":
            target = _resolve_llm_log(self.repo_root) or ""
        else:
            target = self.log_paths.get(name, "")
        if not target:
            return _json(self, 200, {"name": name, "lines": [], "error": "log not found"})
        return _json(self, 200, {"name": name, "path": target, "lines": _tail(target, n)})

    def _render_index(self):
        body = (
            "<h1>AI-Novel Launcher \u00b7 Remote</h1>"
            "<p>GET /api/status (needs <code>Authorization: Bearer &lt;token&gt;</code>) "
            "\u00b7 <a href=\"/api/status?token=\" id=\"t\">JSON</a></p>"
            "<div id=\"out\">loading...</div>"
            "<script>"
            "const TOKEN = new URLSearchParams(location.search).get('token') || '';"
            "async function refresh(){"
            "  const r = await fetch('/api/status', {headers:{'Authorization':'Bearer '+TOKEN}});"
            "  const j = await r.json();"
            "  let html = '<table><tr><th>service</th><th>port</th><th>listening</th></tr>';"
            "  for (const [k, v] of Object.entries(j.services)) {"
            "    html += '<tr><td>' + k + '</td><td>' + (v.port||'') + '</td><td class=\"' + (v.listening ? 'r' : 's') + '\">' + (v.listening ? 'YES' : 'no') + '</td></tr>';"
            "  }"
            "  html += '</table><pre>' + JSON.stringify(j, null, 2) + '</pre>';"
            "  document.getElementById('out').innerHTML = html;"
            "}"
            "refresh(); setInterval(refresh, 5000);"
            "</script>"
        )
        _html(self, body)


class LauncherApi:
    """在 launcher \u4e3b\u8fdb\u7a0b\u91cc\u8d77 ThreadingHTTPServer(\u540e\u53f0\u7ebf\u7a0b),\u63d0\u4f9b\u53ea\u8bfb REST API\u3002"""

    def __init__(self, config: dict[str, Any], log_paths: dict[str, str], repo_root: str = ""):
        self.config = dict(config)
        self.log_paths = dict(log_paths)
        self.repo_root = repo_root
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self):
        port = int(self.config.get("http_port", 17888))
        # 配 handler class 的共享状态
        _Handler.config = self.config
        _Handler.log_paths = self.log_paths
        _Handler.repo_root = self.repo_root
        self._server = ThreadingHTTPServer(("127.0.0.1", port), _Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return f"http://127.0.0.1:{port}"

    def stop(self):
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None