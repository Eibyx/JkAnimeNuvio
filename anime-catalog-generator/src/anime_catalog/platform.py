"""Detección de plataforma (Termux/Android) y diagnóstico del entorno (`anime-catalog doctor`)."""

from __future__ import annotations

import importlib
import os
import platform as _platform
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Any

TERMUX_PREFIX = "/data/data/com.termux/files/usr"


def is_termux(env: dict[str, str] | None = None) -> bool:
    e = os.environ if env is None else env
    return bool(e.get("TERMUX_VERSION")) or e.get("PREFIX", "").startswith(TERMUX_PREFIX) or Path(TERMUX_PREFIX).is_dir()


def is_android() -> bool:
    return is_termux() or hasattr(sys, "getandroidapilevel") or "ANDROID_ROOT" in os.environ


def platform_info() -> dict[str, Any]:
    return {
        "system": _platform.system(), "machine": _platform.machine(), "python": _platform.python_version(),
        "termux": is_termux(), "android": is_android(), "sqlite": sqlite3.sqlite_version,
    }


REQUIRED_MODULES = [
    ("pydantic_core", "pydantic-core (extensión nativa en Rust; en Termux se compila o se instala con pkg)"),
    ("pydantic", "pydantic"),
    ("httpx", "httpx"),
    ("typer", "typer"),
    ("yaml", "PyYAML"),
    ("rich", "rich"),
    ("fastapi", "fastapi (interfaz web)"),
    ("uvicorn", "uvicorn (interfaz web)"),
    ("starlette", "starlette (interfaz web)"),
]


def doctor(home: Path | None = None) -> list[dict[str, Any]]:
    """Comprobaciones básicas. Cada elemento: {check, ok, detail}."""
    out: list[dict[str, Any]] = []

    def add(check: str, ok: bool, detail: str) -> None:
        out.append({"check": check, "ok": ok, "detail": detail})

    add("Python >= 3.12", sys.version_info >= (3, 12), _platform.python_version())
    for mod, label in REQUIRED_MODULES:
        try:
            m = importlib.import_module(mod)
            add(f"módulo {mod}", True, f"{label} {getattr(m, '__version__', '')}".strip())
        except Exception as err:  # ImportError o fallo al cargar la extensión nativa
            add(f"módulo {mod}", False, f"{label}: {err}")
    ver = tuple(int(x) for x in sqlite3.sqlite_version.split(".")[:3])
    add("SQLite >= 3.24 (UPSERT)", ver >= (3, 24, 0), sqlite3.sqlite_version)
    try:
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE t(a PRIMARY KEY, b)")
        con.execute("INSERT INTO t VALUES(1,1) ON CONFLICT(a) DO UPDATE SET b=excluded.b")
        mode = con.execute("PRAGMA journal_mode=WAL").fetchone()[0]
        con.close()
        add("SQLite UPSERT/WAL", True, f"journal={mode}")
    except sqlite3.Error as err:
        add("SQLite UPSERT/WAL", False, str(err))
    target = home or Path(tempfile.gettempdir())
    try:
        target.mkdir(parents=True, exist_ok=True)
        probe = target / ".write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        free = shutil.disk_usage(target).free / 1e6
        add("directorio de datos escribible", True, f"{target} ({free:.0f} MB libres)")
        add("espacio libre >= 300 MB", free >= 300, f"{free:.0f} MB")
    except OSError as err:
        add("directorio de datos escribible", False, f"{target}: {err}")
    add("plataforma", True, ", ".join(f"{k}={v}" for k, v in platform_info().items()))
    if is_termux():
        add("Termux: almacenamiento privado", str(target).startswith(("/data/data/com.termux", str(Path.home()))),
            "los datos se guardan en el directorio privado de Termux (no hace falta termux-setup-storage)")
    return out
