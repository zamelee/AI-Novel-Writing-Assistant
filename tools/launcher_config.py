#!/usr/bin/env python
"""AI-Novel Launcher 配置持久化。

位置:%APPDATA%\\AI-Novel-Launcher\\config.json
- 用户级,不污染项目
- 首次启动若不存在则创建 + 生成随机 auth_token

字段(全部 int / str):
  server_port  int   Express listen port, 默认 3000
  client_port  int   Vite dev server port, 默认 5173
  qdrant_port  int   Qdrant HTTP port, 默认 6333
  http_port    int   launcher 自带只读 HTTP API port, 默认 17888
  auth_token   str   /api/* 鉴权 token,首次启动随机生成 32 字符
"""

import json
import os
import secrets
import sys
from pathlib import Path
from typing import Any


_APP_NAME = "AI-Novel-Launcher"
_DEFAULT_CONFIG: dict[str, Any] = {
    "server_port": 3000,
    "client_port": 5173,
    "qdrant_port": 6333,
    "http_port": 17888,
}


def get_config_dir() -> Path:
    """%APPDATA%\\AI-Novel-Launcher (Win) 或 ~/.config/AI-Novel-Launcher (其他)。"""
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / _APP_NAME
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / _APP_NAME


def get_config_path() -> Path:
    return get_config_dir() / "config.json"


def default_config() -> dict[str, Any]:
    cfg = dict(_DEFAULT_CONFIG)
    cfg["auth_token"] = secrets.token_urlsafe(24)
    return cfg


def load_config() -> dict[str, Any]:
    p = get_config_path()
    if not p.exists():
        cfg = default_config()
        save_config(cfg)
        return cfg
    try:
        with p.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return default_config()
    cfg = dict(_DEFAULT_CONFIG)
    cfg.update({k: v for k, v in data.items() if k in _DEFAULT_CONFIG})
    cfg["auth_token"] = data.get("auth_token") or secrets.token_urlsafe(24)
    return cfg


def save_config(cfg: dict[str, Any]) -> None:
    p = get_config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    os.replace(tmp, p)


def set_port(cfg: dict[str, Any], key: str, port: int) -> dict[str, Any]:
    """改端口:校验 + clamp 到 [1, 65535],写盘。"""
    if key not in _DEFAULT_CONFIG:
        raise KeyError(f"unknown config key: {key}")
    port = max(1, min(65535, int(port)))
    cfg = dict(cfg)
    cfg[key] = port
    save_config(cfg)
    return cfg