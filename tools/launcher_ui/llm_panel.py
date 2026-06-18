#!/usr/bin/env python
"""Block C: LLM 交互日志面板 — 左右分栏。

- 左:Listbox,每行一条 LLM 事件摘要 (\`[HH:MM:SS] EVENT model taskType\`)
- 右:Text widget,显示该事件完整 payload (request messages / response content / error)
"""

import time
import tkinter as tk
from tkinter import ttk

try:
    from launcher_gui import COLORS, TAG_COLORS
except Exception:
    COLORS = {"panel_header_bg": "#1a1a28", "panel_header_fg": "#a0a0b8",
              "text_bg": "#0d0d15", "text_fg": "#c8c8d4", "text_cursor": "#ffffff",
              "btn_bg": "#222233", "btn_fg": "#c8c8d4", "btn_active": "#2a2a40"}
    TAG_COLORS = {"ERROR": "#ff6666", "WARN": "#e5a040", "INFO": "#b0b0c0",
                  "LLM": "#38bdf8", "LLM_TOKEN": "#6a6a7a", "TIME": "#4a4a58"}


class LlmPanel(ttk.Frame):
    def __init__(self, parent, root, title="LLM \u00b7 AI \u901a\u4fe1", accent="#38bdf8", **kw):
        super().__init__(parent, **kw)
        self.root = root
        self._pending = []
        self._events = []

        header = tk.Frame(self, bg=COLORS["panel_header_bg"], height=28)
        header.pack(fill="x")
        header.pack_propagate(False)
        dot = tk.Label(header, text=" \u25cf", fg=accent, bg=COLORS["panel_header_bg"],
                       font=("Consolas", 10, "bold"))
        dot.pack(side="left", padx=(6, 0))
        tk.Label(header, text=title, fg=COLORS["panel_header_fg"], bg=COLORS["panel_header_bg"],
                 font=("Segoe UI", 9, "bold")).pack(side="left", padx=2)
        self.status_label = tk.Label(header, text="\u25cf STOPPED", fg="#5a5a6e",
                                     bg=COLORS["panel_header_bg"], font=("Consolas", 8))
        self.status_label.pack(side="right", padx=8)

        paned = tk.PanedWindow(self, orient="horizontal", bg="#2a2a3a",
                               sashwidth=4, sashrelief="flat")
        paned.pack(fill="both", expand=True)

        left = tk.Frame(paned, bg=COLORS["text_bg"])
        paned.add(left, minsize=160, stretch="never")
        self.listbox = tk.Listbox(left, bg=COLORS["text_bg"], fg=COLORS["text_fg"],
                                  selectbackground="#334", selectforeground="#fff",
                                  font=("Consolas", 9), relief="flat", borderwidth=0,
                                  activestyle="none", highlightthickness=0,
                                  exportselection=False)
        self.listbox.pack(fill="both", expand=True, side="left")
        lb_sb = tk.Scrollbar(left, orient="vertical", command=self.listbox.yview,
                             bg="#1a1a28", troughcolor=COLORS["text_bg"], borderwidth=0)
        lb_sb.pack(side="right", fill="y")
        self.listbox.config(yscrollcommand=lb_sb.set)
        self.listbox.bind("<<ListboxSelect>>", self._on_select)

        right = tk.Frame(paned, bg=COLORS["text_bg"])
        paned.add(right, minsize=240, stretch="always")
        self.text = tk.Text(right, bg=COLORS["text_bg"], fg=COLORS["text_fg"],
                            insertbackground=COLORS["text_cursor"],
                            font=("Consolas", 9), wrap="none",
                            state="disabled", relief="flat", borderwidth=0,
                            padx=10, pady=6, selectbackground="#334", maxundo=0)
        self.text.pack(side="left", fill="both", expand=True)
        rt_sb_v = tk.Scrollbar(right, orient="vertical", command=self.text.yview,
                               bg="#1a1a28", troughcolor=COLORS["text_bg"], borderwidth=0)
        rt_sb_v.pack(side="right", fill="y")
        rt_sb_h = tk.Scrollbar(self, orient="horizontal", command=self.text.xview,
                               bg="#1a1a28", troughcolor=COLORS["text_bg"], borderwidth=0)
        rt_sb_h.pack(side="bottom", fill="x")
        self.text.config(yscrollcommand=rt_sb_v.set, xscrollcommand=rt_sb_h.set)
        for tag, color in TAG_COLORS.items():
            self.text.tag_config(tag, foreground=color)

        self.text_max_lines = 5000

    def append_status(self, line, tag="LLM_TOKEN"):
        self.text.configure(state="normal")
        self.text.insert("end", "[{}] ".format(time.strftime("%H:%M:%S")), "TIME")
        self.text.insert("end", line + "\n", tag)
        self.text.configure(state="disabled")
        self.text.see("end")

    def set_status(self, running):
        c = COLORS.get("status_running", "#7ec87e") if running else "#5a5a6e"
        self.status_label.configure(
            text="\u25cf RUNNING" if running else "\u25cf STOPPED", fg=c)

    def add_event(self, parsed):
        self._pending.append(parsed)
        try:
            self.root.after_idle(self._flush)
        except Exception:
            pass

    def clear(self):
        self.listbox.delete(0, "end")
        self.text.configure(state="normal")
        self.text.delete("1.0", "end")
        self.text.configure(state="disabled")
        self._events.clear()

    def _flush(self):
        if not self._pending:
            return
        items = self._pending
        self._pending = []
        for p in items:
            self._events.append(p)
            idx = len(self._events) - 1
            self.listbox.insert("end", self._summary_line(p))
            self.listbox.itemconfig(idx, fg=self._summary_color(p))
            self._append_text_event(p)

    def _on_select(self, _evt=None):
        sel = self.listbox.curselection()
        if not sel:
            return
        i = sel[0]
        if 0 <= i < len(self._events):
            self._show_event(i)

    def _show_event(self, i):
        marker = self._marker_for(i)
        idx = self.text.search(marker, "1.0", stopindex="end")
        if idx:
            self.text.see(idx)
            self.text.tag_remove("sel", "1.0", "end")
            self.text.tag_add("sel", idx, "{} +1 lines".format(idx))

    def _marker_for(self, i):
        return "@@evt{}@@".format(i)

    def _summary_line(self, p):
        ts = (p.get("timestamp") or "")[-8:]
        ev = p.get("event", "?")
        model = (p.get("model") or "?")[:24]
        task = p.get("taskType") or ""
        rid = p.get("requestId") or ""
        lat = p.get("latencyMs")
        suffix = " {}".format(lat) if lat else ""
        return "[{}] {:<8}  {:<24}  {:<14}{}".format(ts, ev, model, task, suffix).strip()

    def _summary_color(self, p):
        ev = p.get("event", "")
        if ev == "error":
            return "#ff6666"
        if ev == "response":
            return "#66cc88"
        if ev == "request":
            return "#60a5fa"
        return "#a0a0b8"

    def _append_text_event(self, p):
        i = len(self._events) - 1
        self.text.configure(state="normal")
        self.text.insert("end", self._marker_for(i) + "\n", "TIME")
        ts = p.get("timestamp", "?")
        ev = p.get("event", "?")
        model = "{}/{}".format(p.get("provider", ""), p.get("model", ""))
        task = p.get("taskType", "")
        rid = p.get("requestId", "")
        lat = p.get("latencyMs")
        head = "[{}] {}  {}   task={}   rid={}   latency={}ms   promptTokens={}\n".format(
            ts, ev.upper(), model, task, rid, lat, p.get("actualPromptTokens"))
        self.text.insert("end", head, "LLM" if ev != "error" else "ERROR")
        if ev == "request":
            for m in (p.get("payload") or []):
                role = m.get("role", "?")
                content = m.get("content") or ""
                if isinstance(content, list):
                    content = "\n".join(str(x) for x in content)
                self.text.insert("end", "    \u2500\u2500 {} \u2500\u2500\n".format(role), "WARN")
                for ln in str(content).splitlines()[:30]:
                    self.text.insert("end", "    " + ln + "\n")
        elif ev == "response":
            content = (p.get("payload") or {}).get("content", "")
            self.text.insert("end", "    \u2500\u2500 content \u2500\u2500\n", "SUCCESS")
            for ln in str(content).splitlines()[:40]:
                self.text.insert("end", "    " + ln + "\n")
        elif ev == "error":
            err = p.get("error") or ""
            self.text.insert("end", "    ERROR: " + str(err) + "\n", "ERROR")
        self.text.insert("end", "\n")
        total = int(self.text.index("end-1c").split(".")[0])
        if total > self.text_max_lines:
            self.text.delete("1.0", "{}.0".format(total - self.text_max_lines))
        self.text.configure(state="disabled")