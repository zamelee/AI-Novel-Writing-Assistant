#!/usr/bin/env python
# AI-Novel Launcher (Tkinter) - 4 栏服务监控 + LLM tail
# 仿 MuMuAINovel/launcher.py 的体验,适配本项目:Server + Client + Qdrant + LLM
# 用法: python tools/launcher_gui.py

import sys, os, re, subprocess, threading, queue, time, atexit, json, glob
import tkinter as tk
from tkinter import ttk, messagebox
import psutil

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


# ---------- 端口守护 ----------
def _find_pids_on_port(port):
    pids = set()
    try:
        for conn in psutil.net_connections(kind="inet"):
            if conn.status == "LISTEN" and conn.laddr.port == port and conn.pid:
                pids.add(conn.pid)
    except Exception:
        pass
    return pids


def _kill_pids_psutil(pids, timeout=5):
    survivors = set()
    for pid in pids:
        try:
            proc = psutil.Process(pid)
            for child in proc.children(recursive=True):
                try:
                    child.kill()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            proc.kill()
            proc.wait(timeout=timeout)
        except psutil.NoSuchProcess:
            pass
        except (psutil.TimeoutExpired, psutil.AccessDenied):
            survivors.add(pid)
        except Exception:
            survivors.add(pid)
    return survivors


def _kill_pids_force(panel, port, pids):
    panel.append("Port {} occupied (PID:{}) - killing".format(port, ",".join(map(str, pids))), "WARN")
    survivors = _kill_pids_psutil(pids)
    if survivors:
        for pid in list(survivors):
            try:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                              capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=8)
            except Exception:
                pass
        time.sleep(2)
        still_alive = {pid for pid in pids if psutil.pid_exists(pid)}
        if still_alive:
            panel.append("FAILED: cannot kill {} - try admin mode".format(",".join(map(str, still_alive))), "ERROR")
            return False
    panel.append("Port {} freed".format(port), "SUCCESS")
    return True


# ---------- LogPanel ----------
class LogPanel(ttk.Frame):
    def __init__(self, parent, title, accent, wrap_mode="word", show_hscroll=False, **kw):
        super().__init__(parent, **kw)
        self.configure(style="Panel.TFrame")
        header = tk.Frame(self, bg=COLORS["panel_header_bg"], height=28)
        header.pack(fill="x")
        header.pack_propagate(False)
        dot = tk.Label(header, text=" \u25cf", fg=accent, bg=COLORS["panel_header_bg"], font=("Consolas", 10, "bold"))
        dot.pack(side="left", padx=(6, 0))
        tk.Label(header, text=title, fg=COLORS["panel_header_fg"], bg=COLORS["panel_header_bg"],
                font=("Segoe UI", 9, "bold")).pack(side="left", padx=2)
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


# ---------- LauncherApp ----------
class LauncherApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("AI-Novel Launcher")
        try:
            self.root.iconbitmap(os.path.join(REPO_ROOT, "client", "public", "favicon.ico"))
        except Exception:
            pass
        self.root.configure(bg=COLORS["win_bg"])
        self.root.geometry("1280x820")
        self.root.minsize(900, 500)

        style = ttk.Style()
        style.theme_use("clam")
        style.configure(".", background=COLORS["win_bg"])
        style.configure("Toolbar.TFrame", background=COLORS["toolbar_bg"])
        style.configure("Panel.TFrame", background=COLORS["panel_bg"])
        style.configure("TButton", background=COLORS["btn_bg"], foreground=COLORS["btn_fg"],
                        borderwidth=0, focusthickness=0, padding=(10, 4), font=("Segoe UI", 9))
        style.map("TButton", background=[("active", COLORS["btn_active"])])

        # Toolbar
        toolbar = ttk.Frame(self.root, style="Toolbar.TFrame")
        toolbar.pack(fill="x", padx=6, pady=(6, 3))

        self.btn_start_all = ttk.Button(toolbar, text="Start All", command=self.start_all)
        self.btn_start_all.pack(side="left", padx=(2, 4))
        self.btn_stop_all = ttk.Button(toolbar, text="Stop All", command=self.stop_all, state="disabled")
        self.btn_stop_all.pack(side="left", padx=(0, 4))
        ttk.Separator(toolbar, orient="vertical").pack(side="left", fill="y", padx=8, pady=3)
        ttk.Button(toolbar, text="Server", command=self.start_server).pack(side="left", padx=2)
        ttk.Button(toolbar, text="Client", command=self.start_client).pack(side="left", padx=2)
        ttk.Button(toolbar, text="Qdrant", command=self.start_qdrant).pack(side="left", padx=2)
        ttk.Separator(toolbar, orient="vertical").pack(side="left", fill="y", padx=8, pady=3)
        ttk.Button(toolbar, text="Open Browser", command=self.open_browser).pack(side="left", padx=2)
        ttk.Button(toolbar, text="Kill Orphans", command=self._cleanup_orphans).pack(side="left", padx=2)
        ttk.Button(toolbar, text="Clear", command=self.clear_logs).pack(side="left", padx=2)

        tk.Label(toolbar, text="Max lines:", fg="#8a8a9e",
                bg=COLORS["toolbar_bg"], font=("Segoe UI", 8)).pack(side="right", padx=(12, 2))
        self.max_lines_var = tk.StringVar(value="5000")
        max_entry = tk.Entry(toolbar, textvariable=self.max_lines_var, width=5,
                            bg=COLORS["btn_bg"], fg=COLORS["btn_fg"], insertbackground=COLORS["text_cursor"],
                            font=("Consolas", 9), relief="flat", borderwidth=0, justify="center")
        max_entry.pack(side="right", padx=(0, 8))
        max_entry.bind("<Return>", lambda e: self._apply_max_lines())
        max_entry.bind("<FocusOut>", lambda e: self._apply_max_lines())

        self.llm_monitor_var = tk.BooleanVar(value=True)
        mon_cb = tk.Checkbutton(toolbar, text="Mon LLM", variable=self.llm_monitor_var,
                               command=self._toggle_llm_monitor, bg=COLORS["toolbar_bg"],
                               fg=COLORS["btn_fg"], selectcolor=COLORS["btn_bg"],
                               font=("Segoe UI", 8), activebackground=COLORS["toolbar_bg"],
                               activeforeground=COLORS["btn_fg"])
        mon_cb.pack(side="right", padx=(0, 8))

        tk.Label(toolbar, text="Server:3000 | Client:5173 | Qdrant:6333 | LLM: .logs/", fg="#5a5a6e",
                bg=COLORS["toolbar_bg"], font=("Consolas", 8)).pack(side="right", padx=10)

        # 4 panes
        self.paned = tk.PanedWindow(self.root, orient="vertical", bg=COLORS["sash"],
                                    sashwidth=5, sashrelief="flat")
        self.paned.pack(fill="both", expand=True, padx=6, pady=(3, 6))
        self.server_panel = LogPanel(self.paned, "Server \u00b7 Express", "#60a5fa")
        self.client_panel = LogPanel(self.paned, "Client \u00b7 Vite", "#a78bfa")
        self.qdrant_panel = LogPanel(self.paned, "Qdrant \u00b7 Vector DB", "#ec4899")
        self.llm_panel = LogPanel(self.paned, "LLM \u00b7 AI \u901a\u4fe1", "#38bdf8", wrap_mode="none", show_hscroll=True)
        self.paned.add(self.server_panel, stretch="always", minsize=80)
        self.paned.add(self.client_panel, stretch="always", minsize=80)
        self.paned.add(self.qdrant_panel, stretch="always", minsize=80)
        self.paned.add(self.llm_panel, stretch="always", minsize=80)

        self.server_proc = None
        self.client_proc = None
        self.qdrant_proc = None
        self.running = False
        self.llm_tail_running = False
        self.llm_file = None
        self.llm_offset = 0
        self.log_queue = queue.Queue()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        atexit.register(self._force_cleanup)
        self.root.after(100, self._poll)
        self.root.after(500, self._auto_start)

    def _apply_max_lines(self):
        try:
            n = int(self.max_lines_var.get())
            for panel in [self.server_panel, self.client_panel, self.qdrant_panel, self.llm_panel]:
                panel.set_max_lines(n)
        except ValueError:
            pass

    def _toggle_llm_monitor(self):
        if self.llm_monitor_var.get():
            if self.running:
                self._start_llm_tail()
        else:
            self._stop_llm_tail()

    def _auto_start(self):
        self._cleanup_orphans()
        self.root.after(1500, self.start_all)

    def _cleanup_orphans(self):
        self.server_panel.append("Scanning for orphan processes...", "INFO")
        any_found = False
        for port, name in GUARD_PORTS:
            pids = _find_pids_on_port(port)
            if pids:
                any_found = True
                _kill_pids_force(self.server_panel, port, pids)
        if not any_found:
            self.server_panel.append("No orphans found", "SUCCESS")

    def _poll(self):
        batches = {}
        try:
            while True:
                panel, line, tag = self.log_queue.get_nowait()
                batches.setdefault(panel, []).append((line, tag))
        except queue.Empty:
            pass
        for panel, items in batches.items():
            panel.append_many(items)
        self.root.after(50, self._poll)

    def _tag(self, line, prefix):
        u = line.upper()
        if "ERROR" in u or "FAIL" in u or "TRACEBACK" in u:
            return "ERROR"
        if "WARNING" in u or "WARN" in u:
            return "WARN"
        if "SUCCESS" in u or "READY" in u or "[OK]" in u:
            return "SUCCESS"
        if "DEBUG" in u:
            return "DEBUG"
        if prefix == "client" and "VITE" in u:
            return "VITE"
        if prefix == "server" and (
            "EXPRESS" in u or "PRISMA" in u
            or re.search(r'[\w.]+:\d+\s+-\s+"(GET|POST|PUT|DELETE|PATCH|OPTIONS)', line)
        ):
            return "SERVER"
        if prefix == "qdrant" and ("QDRANT" in u or "ACTIX" in u or "TONIC" in u):
            return "QDRANT"
        return "INFO"

    def _check_and_free_port(self, port):
        pids = _find_pids_on_port(port)
        if not pids:
            return True
        return _kill_pids_force(self.server_panel, port, pids)

    def _start_proc(self, name, cmd, cwd, panel, port, log_file, prefix):
        proc_attr = prefix + "_proc"
        existing = getattr(self, proc_attr, None)
        if existing and existing.poll() is None:
            panel.append("{} already running".format(name), "WARN")
            return
        if port:
            self._check_and_free_port(port)
            time.sleep(0.3)
        tag = prefix.upper() if prefix in ("server", "client", "qdrant") else "INFO"
        panel.append("\u2500" * 40, tag)
        panel.append("Starting {} ...".format(name), tag)
        try:
            os.makedirs(os.path.dirname(log_file), exist_ok=True)
            log_fh = open(log_file, "ab", buffering=0)
            env = os.environ.copy()
            env["PYTHONIOENCODING"] = "utf-8"
            proc = subprocess.Popen(
                cmd, cwd=cwd, env=env,
                stdout=log_fh, stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            setattr(self, proc_attr, proc)
            panel.set_status(True)
            self._update_btns()
        except Exception as e:
            panel.append("Start failed: {}".format(e), "ERROR")
            return
        threading.Thread(target=self._file_reader, args=(log_file, panel, prefix), daemon=True).start()

    def _file_reader(self, path, panel, prefix):
        try:
            offset = os.path.getsize(path) if os.path.exists(path) else 0
        except OSError:
            offset = 0
        time.sleep(0.5)
        proc_attr = prefix + "_proc" if prefix in ("server", "client", "qdrant") else None
        while True:
            try:
                if os.path.exists(path):
                    size = os.path.getsize(path)
                    if size < offset:
                        offset = 0
                    if size > offset:
                        with open(path, "r", encoding="utf-8", errors="replace") as f:
                            f.seek(offset)
                            for raw in f:
                                line = ANSI_RE.sub("", raw.rstrip())
                                if line:
                                    self.log_queue.put((panel, line, self._tag(line, prefix)))
                            offset = f.tell()
            except (OSError, ValueError):
                return
            time.sleep(0.4)
            if proc_attr:
                p = getattr(self, proc_attr, None)
                if p and p.poll() is not None:
                    time.sleep(1.0)
                    try:
                        if os.path.exists(path):
                            size = os.path.getsize(path)
                            if size > offset:
                                with open(path, "r", encoding="utf-8", errors="replace") as f:
                                    f.seek(offset)
                                    for raw in f:
                                        line = ANSI_RE.sub("", raw.rstrip())
                                        if line:
                                            self.log_queue.put((panel, line, self._tag(line, prefix)))
                    except OSError:
                        pass
                    panel.set_status(False)
                    panel.append("[reader] process exited, log tail stopped", "WARN")
                    return

    def start_qdrant(self):
        if not os.path.exists(QDRANT_EXE):
            self.qdrant_panel.append("Qdrant binary not found: {}".format(QDRANT_EXE), "ERROR")
            return
        if not os.path.exists(QDRANT_CONFIG):
            self.qdrant_panel.append("Qdrant config not found: {}".format(QDRANT_CONFIG), "ERROR")
            return
        self._start_proc("Qdrant", QDRANT_CMD, TOOLS_DIR, self.qdrant_panel, 6333, QDRANT_LOG, "qdrant")

    def start_server(self):
        self._start_proc("Server", SERVER_CMD, REPO_ROOT, self.server_panel, 3000, SERVER_LOG, "server")

    def start_client(self):
        self._start_proc("Client", CLIENT_CMD, REPO_ROOT, self.client_panel, 5173, CLIENT_LOG, "client")

    def start_all(self):
        self.start_qdrant()
        self.root.after(1500, self.start_server)
        self.root.after(3500, self.start_client)
        self.root.after(5000, self._start_llm_tail)
        self.running = True
        self._update_btns()

    def _kill_proc_tree(self, proc):
        try:
            parent = psutil.Process(proc.pid)
            children = parent.children(recursive=True)
            for child in children:
                try:
                    child.kill()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            parent.kill()
            psutil.wait_procs(children + [parent], timeout=5)
        except psutil.NoSuchProcess:
            pass
        except Exception:
            try:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                              capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
            except Exception:
                pass

    def stop_all(self):
        self._stop_llm_tail()
        for name, attr, panel in [
            ("Qdrant", "qdrant_proc", self.qdrant_panel),
            ("Client", "client_proc", self.client_panel),
            ("Server", "server_proc", self.server_panel),
        ]:
            proc = getattr(self, attr, None)
            if proc and proc.poll() is None:
                panel.append("--- Stopping {} ---".format(name), "WARN")
                self._kill_proc_tree(proc)
                panel.append("{} stopped".format(name), "INFO")
                panel.set_status(False)
            setattr(self, attr, None)
        self.running = False
        self._update_btns()

    def clear_logs(self):
        for panel in [self.server_panel, self.client_panel, self.qdrant_panel, self.llm_panel]:
            panel.text.configure(state="normal")
            panel.text.delete("1.0", "end")
            panel.text.configure(state="disabled")

    def open_browser(self):
        try:
            import webbrowser
            webbrowser.open("http://localhost:5173")
            self.server_panel.append("Opened browser: http://localhost:5173", "INFO")
        except Exception as e:
            self.server_panel.append("Open browser failed: {}".format(e), "WARN")

    def _update_btns(self):
        any_running = any(
            getattr(self, attr, None) and getattr(self, attr).poll() is None
            for attr in ("server_proc", "client_proc", "qdrant_proc")
        )
        self.btn_stop_all.configure(state="normal" if any_running else "disabled")

    # ----- LLM tail -----
    def _start_llm_tail(self):
        if self.llm_tail_running:
            return
        self.llm_panel.append("\u2500" * 40, "LLM_TOKEN")
        self.llm_panel.append("Watching: .logs/<today>/*.llm.jsonl", "LLM_TOKEN")
        self.llm_panel.set_status(True)
        self.llm_tail_running = True
        self.llm_offset = 0
        self.llm_file = None
        threading.Thread(target=self._llm_tailer, daemon=True).start()

    def _stop_llm_tail(self):
        if self.llm_tail_running:
            self.llm_panel.append("--- LLM watch paused ---", "LLM_TOKEN")
        self.llm_tail_running = False
        self.llm_panel.set_status(False)

    def _resolve_llm_file(self):
        today = time.strftime("%Y-%m-%d")
        d = os.path.join(LOGS_DIR, today)
        if not os.path.isdir(d):
            return None
        cands = sorted(glob.glob(os.path.join(d, "*.llm.jsonl")), key=os.path.getmtime, reverse=True)
        return cands[0] if cands else None

    def _format_llm(self, raw):
        try:
            j = json.loads(raw)
        except Exception:
            return (raw[:200] if raw else ""), "LLM_TOKEN"
        route = j.get("route") or j.get("path") or "?"
        status = j.get("statusCode") or j.get("status") or "?"
        dur = j.get("durationMs")
        inT = j.get("inputTokens")
        outT = j.get("outputTokens")
        provider = j.get("provider") or ""
        model = j.get("model") or ""
        err = j.get("error") or ""
        parts = [route]
        if provider or model:
            parts.append("/".join(filter(None, [provider, model])))
        head = " ".join(parts)
        meta = []
        if dur is not None:
            meta.append("{}ms".format(int(dur)))
        if inT is not None:
            meta.append("in={}".format(inT))
        if outT is not None:
            meta.append("out={}".format(outT))
        if err:
            meta.append("err={}".format(str(err))[:60])
        line = "{} {} {}".format(head, status, " ".join(meta))
        is_err = (isinstance(status, int) and status >= 400) or err
        tag = "ERROR" if is_err else "LLM"
        return line, tag

    def _llm_tailer(self):
        while self.llm_tail_running:
            try:
                f = self._resolve_llm_file()
                if f and f != self.llm_file:
                    self.llm_file = f
                    self.llm_offset = 0
                    self.log_queue.put((self.llm_panel, "Tracking {}...".format(os.path.basename(f)), "LLM_TOKEN"))
                if self.llm_file and os.path.exists(self.llm_file):
                    size = os.path.getsize(self.llm_file)
                    if size < self.llm_offset:
                        self.llm_offset = 0
                    if size > self.llm_offset:
                        with open(self.llm_file, "r", encoding="utf-8", errors="replace") as fh:
                            fh.seek(self.llm_offset)
                            for raw in fh:
                                stripped = raw.rstrip()
                                if not stripped:
                                    continue
                                line, tag = self._format_llm(stripped)
                                self.log_queue.put((self.llm_panel, line, tag))
                            self.llm_offset = fh.tell()
            except Exception:
                pass
            time.sleep(0.5)

    def _on_close(self):
        if self.running:
            if not messagebox.askyesno("Exit", "Services are running.\nClose and stop all services?"):
                return
        self.stop_all()
        self.running = False
        self.root.destroy()

    def _force_cleanup(self):
        self._stop_llm_tail()
        for attr in ("server_proc", "client_proc", "qdrant_proc"):
            proc = getattr(self, attr, None)
            if proc and proc.poll() is None:
                self._kill_proc_tree(proc)

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    LauncherApp().run()
