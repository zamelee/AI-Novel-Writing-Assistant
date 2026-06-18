#!/usr/bin/env python
# AI-Novel Launcher (Tkinter) - 4 栏服务监控 + LLM tail
# 仿 MuMuAINovel/launcher.py 的体验,适配本项目:Server + Client + Qdrant + LLM
# 用法: python tools/launcher_gui.py

import sys, os, re, subprocess, threading, queue, time, atexit, json, glob
import tkinter as tk
from tkinter import ttk, messagebox

if sys.stdout:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.environ["PYTHONIOENCODING"] = "utf-8"

# ---------- 路径 ----------
def get_base():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

BASE = get_base()
if getattr(sys, "frozen", False):
    REPO_ROOT = BASE
else:
    REPO_ROOT = os.path.abspath(os.path.join(BASE, ".."))

def _resolve_actual_repo_root():
    candidates = []
    if getattr(sys, "frozen", False):
        candidates.append(BASE)
        candidates.append(os.path.dirname(BASE))
    else:
        candidates.append(os.path.dirname(BASE))
        candidates.append(BASE)
    for c in candidates:
        if os.path.isfile(os.path.join(c, "package.json")) and \
           os.path.isdir(os.path.join(c, "server")):
            return c
    return REPO_ROOT

REPO_ROOT = _resolve_actual_repo_root()
TOOLS_DIR = os.path.join(REPO_ROOT, "tools")
QDRANT_EXE = os.path.join(TOOLS_DIR, "qdrant", "qdrant.exe")
QDRANT_CONFIG = os.path.join(TOOLS_DIR, "qdrant", "config.yaml")
LOGS_DIR = os.path.join(REPO_ROOT, ".logs")

SERVER_LOG = os.path.join(TOOLS_DIR, "launcher-server.log")
CLIENT_LOG = os.path.join(TOOLS_DIR, "launcher-client.log")
QDRANT_LOG = os.path.join(TOOLS_DIR, "qdrant.log")

# ---------- 命令 ----------
def make_cmd(*args):
    if sys.platform == "win32":
        return ["cmd.exe", "/c"] + list(args)
    return list(args)

SERVER_CMD = make_cmd("pnpm", "--filter", "@ai-novel/server", "dev")
CLIENT_CMD = make_cmd("pnpm", "--filter", "@ai-novel/client", "dev")
QDRANT_CMD = [QDRANT_EXE, "--config-path", QDRANT_CONFIG]

# ---------- 颜色 ----------
COLORS = {
    "win_bg": "#0f0f14", "toolbar_bg": "#16161e", "sash": "#2a2a3a",
    "panel_bg": "#12121a", "panel_header_bg": "#1a1a28", "panel_header_fg": "#a0a0b8",
    "text_bg": "#0d0d15", "text_fg": "#c8c8d4", "text_cursor": "#ffffff",
    "status_running": "#7ec87e", "status_stopped": "#5a5a6e",
    "btn_bg": "#222233", "btn_fg": "#c8c8d4", "btn_active": "#2a2a40",
}

TAG_COLORS = {
    "ERROR": "#ff6666", "WARN": "#e5a040", "INFO": "#b0b0c0",
    "DEBUG": "#6a6a7a", "SUCCESS": "#66cc88", "VITE": "#a78bfa",
    "SERVER": "#60a5fa", "QDRANT": "#ec4899",
    "TIME": "#4a4a58",
    "LLM": "#38bdf8", "LLM_TOKEN": "#6a6a7a",
}

GUARD_PORTS = [(3000, "Server"), (5173, "Client"), (6333, "Qdrant")]
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


# ---------- LogPanel ----------
class LogPanel(ttk.Frame):
    def __init__(self, parent, title, accent, wrap_mode="word", show_hscroll=False,
                 restart_cmd=None, **kw):
        """LogPanel: 单服务日志面板。

        restart_cmd: callable 或 None — 若非 None,header 加一个 ↻ 按钮调用它。
        """
        super().__init__(parent, **kw)
        self.configure(style="Panel.TFrame")
        header = tk.Frame(self, bg=COLORS["panel_header_bg"], height=28)
        header.pack(fill="x")
        header.pack_propagate(False)
        dot = tk.Label(header, text=" \u25cf", fg=accent, bg=COLORS["panel_header_bg"], font=("Consolas", 10, "bold"))
        dot.pack(side="left", padx=(6, 0))
        tk.Label(header, text=title, fg=COLORS["panel_header_fg"], bg=COLORS["panel_header_bg"],
                font=("Segoe UI", 9, "bold")).pack(side="left", padx=2)
        if restart_cmd is not None:
            self._restart_btn = tk.Button(header, text="⟲", command=restart_cmd,
                bg=COLORS["btn_bg"], fg=COLORS["btn_fg"],
                activebackground=COLORS["btn_active"], activeforeground=COLORS["btn_fg"],
                font=("Segoe UI", 9, "bold"), relief="flat", borderwidth=0,
                padx=8, pady=0, cursor="hand2")
            self._restart_btn.pack(side="left", padx=(6, 0))
        self.wrap_var = tk.BooleanVar(value=(wrap_mode == "word"))
        cb = tk.Checkbutton(header, text="Wrap", variable=self.wrap_var,
                           command=self._toggle_wrap, bg=COLORS["panel_header_bg"],
                           fg=COLORS["panel_header_fg"], selectcolor=COLORS["panel_bg"],
                           font=("Segoe UI", 7), activebackground=COLORS["panel_header_bg"],
                           activeforeground=COLORS["panel_header_fg"])
        cb.pack(side="right", padx=4)
        self.status_label = tk.Label(header, text="\u25cf STOPPED", fg=COLORS["status_stopped"],
                                     bg=COLORS["panel_header_bg"], font=("Consolas", 8))
        self.status_label.pack(side="right", padx=8)
        text_frame = tk.Frame(self, bg=COLORS["text_bg"])
        text_frame.pack(fill="both", expand=True)
        self.text = tk.Text(text_frame, bg=COLORS["text_bg"], fg=COLORS["text_fg"],
                            insertbackground=COLORS["text_cursor"], font=("Consolas", 10),
                            wrap=wrap_mode, state="disabled", relief="flat", borderwidth=0,
                            padx=10, pady=6, selectbackground="#334", maxundo=0)
        self.text.pack(side="left", fill="both", expand=True)
        scrollbar = tk.Scrollbar(text_frame, orient="vertical", command=self.text.yview,
                                 bg="#1a1a28", troughcolor=COLORS["text_bg"], borderwidth=0)
        self.text.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side="right", fill="y")
        if show_hscroll:
            hscroll = tk.Scrollbar(self, orient="horizontal", command=self.text.xview,
                                   bg="#1a1a28", troughcolor=COLORS["text_bg"], borderwidth=0)
            self.text.configure(xscrollcommand=hscroll.set)
            hscroll.pack(side="bottom", fill="x")
        for tag, color in TAG_COLORS.items():
            self.text.tag_config(tag, foreground=color)
        self.max_lines = 5000

    def append(self, line, tag=None):
        self.text.configure(state="normal")
        self.text.insert("end", "[{}] ".format(time.strftime("%H:%M:%S")), "TIME")
        self.text.insert("end", line + "\n", tag if tag else "")
        lines = int(self.text.index("end-1c").split(".")[0])
        if lines > self.max_lines:
            self.text.delete("1.0", "{}.0".format(lines - self.max_lines))
        self.text.configure(state="disabled")
        self.text.see("end")

    def append_many(self, items):
        if not items:
            return
        self.text.configure(state="normal")
        ts = time.strftime("%H:%M:%S")
        for line, tag in items:
            self.text.insert("end", "[{}] ".format(ts), "TIME")
            self.text.insert("end", line + "\n", tag if tag else "")
        total_lines = int(self.text.index("end-1c").split(".")[0])
        if total_lines > self.max_lines:
            self.text.delete("1.0", "{}.0".format(total_lines - self.max_lines))
        self.text.configure(state="disabled")
        self.text.see("end")

    def set_status(self, running):
        c = COLORS["status_running"] if running else COLORS["status_stopped"]
        self.status_label.configure(text="\u25cf RUNNING" if running else "\u25cf STOPPED", fg=c)

    def set_max_lines(self, n):
        if n >= 100:
            self.max_lines = n

    def _toggle_wrap(self):
        mode = "word" if self.wrap_var.get() else "none"
        self.text.configure(wrap=mode)




# App class 已拆到 launcher_app.py(AGENTS.md 700 行硬上限)



def main():
    from launcher_app import LauncherApp
    LauncherApp().run()


if __name__ == "__main__":
    main()
