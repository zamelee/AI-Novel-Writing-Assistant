#!/usr/bin/env python
"""AI-Novel Launcher 通用 helper。

- 端口扫描 / 进程清理 (psutil)
- 子进程环境变量拼装 (Block B L1: launcher 写 PORT/QDRANT_URL 给 server/client)
"""

import os
import subprocess
import sys
import time
from typing import Iterable

import psutil


def find_pids_on_port(port: int) -> set[int]:
    """返回正在 LISTEN 该端口的所有 PID。"""
    pids: set[int] = set()
    try:
        for conn in psutil.net_connections(kind="inet"):
            if conn.status == "LISTEN" and conn.laddr.port == port and conn.pid:
                pids.add(conn.pid)
    except (psutil.AccessDenied, OSError):
        pass
    return pids


def kill_pids(pids: Iterable[int], timeout: float = 5.0) -> set[int]:
    """先 psutil.terminate 等 timeout,再 SIGKILL;返回没杀干净的 PID 集合。"""
    survivors: set[int] = set()
    for pid in pids:
        try:
            proc = psutil.Process(pid)
            for child in proc.children(recursive=True):
                try:
                    child.terminate()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            proc.terminate()
            proc.wait(timeout=timeout)
        except psutil.NoSuchProcess:
            pass
        except (psutil.TimeoutExpired, psutil.AccessDenied):
            survivors.add(pid)
        except Exception:
            survivors.add(pid)
    return survivors


def kill_pids_force(pids: Iterable[int]) -> None:
    """Windows fallback: taskkill /F /T。"""
    for pid in pids:
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True,
                creationflags=subprocess.CREATE_NO_WINDOW,
                timeout=8,
            )
        except Exception:
            pass


def is_port_listening(port: int) -> bool:
    return bool(find_pids_on_port(port))


def free_port(port: int) -> bool:
    """杀干净 LISTEN 该端口的进程,返回是否真的释放了。"""
    pids = find_pids_on_port(port)
    if not pids:
        return True
    survivors = kill_pids(pids)
    if survivors:
        kill_pids_force(survivors)
        time.sleep(2)
    return not find_pids_on_port(port)


def build_child_env(overrides: dict[str, str]) -> dict[str, str]:
    """父进程 env 副本,合并 overrides,统一 UTF-8 IO 编码。"""
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    for k, v in overrides.items():
        env[str(k)] = str(v)
    return env


def server_env(server_port: int, qdrant_port: int) -> dict[str, str]:
    """Block B L1: server 子进程要的环境变量。"""
    return {
        "PORT": str(server_port),
        "QDRANT_URL": f"http://localhost:{qdrant_port}",
    }


def client_env(client_port: int, server_port: int) -> dict[str, str]:
    """Block B L1: client (vite) 子进程要的环境变量。vite.config 通过 process.env.PORT
    读 server 端口做 proxy target。"""
    return {
        "PORT": str(server_port),
        "VITE_PORT": str(client_port),
    }


def default_cmd_windows(*args: str) -> list[str]:
    """Windows: 在 cmd.exe /c 下跑一个命令列表。"""
    if sys.platform == "win32":
        return ["cmd.exe", "/c", *args]
    return list(args)