"""Compatibilidad con Termux (simulada): scripts, detección, diagnóstico y dependencias sin extras nativos.

No hay un Android real en CI: se comprueba la lógica de los scripts con `--dry-run`, un `pkg`
simulado y un `$PREFIX` falso. Lo que falta verificar en un dispositivo físico está en el README.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
import tomllib
import urllib.request
from pathlib import Path

import pytest

from anime_catalog.platform import doctor, is_termux

ROOT = Path(__file__).resolve().parents[1]
INSTALL = ROOT / "install-termux.sh"
START = ROOT / "start-termux.sh"
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None or os.name != "posix", reason="requiere bash (POSIX)")


def run(args: list[str], env: dict[str, str], timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(args, env={**os.environ, **env}, capture_output=True, text=True, timeout=timeout)


def test_scripts_have_valid_bash_syntax():
    for script in (INSTALL, START):
        assert subprocess.run([BASH, "-n", str(script)]).returncode == 0
        assert os.access(script, os.X_OK)


def test_installer_dry_run_lists_all_steps(tmp_path):
    r = run([BASH, str(INSTALL), "--dry-run"], {"HOME": str(tmp_path)})
    assert r.returncode == 0, r.stderr
    out = r.stdout
    for expected in ("pkg install -y python clang make sqlite openssl libffi", "python-pydantic-core", "-m venv --system-site-packages",
                     "ANDROID_API_LEVEL", "chmod 600", "/.anime-catalog/profiles/anime-2020s.yaml", "doctor", "pip install"):
        assert expected in out, expected
    assert "install --upgrade pip" not in out  # en Termux pip lo gestiona pkg
    assert "uvicorn[standard]" not in out


def test_installer_refuses_outside_termux_without_force(tmp_path):
    env = {"HOME": str(tmp_path), "PREFIX": str(tmp_path / "usr"), "TERMUX_VERSION": ""}
    if Path("/data/data/com.termux/files/usr").is_dir():
        pytest.skip("se está ejecutando en Termux")
    r = run([BASH, str(INSTALL)], env)
    assert r.returncode == 1 and "Termux" in r.stderr


@pytest.mark.skipif(os.environ.get("ANIME_CATALOG_SLOW") != "1", reason="instalación completa simulada (ANIME_CATALOG_SLOW=1)")
def test_installer_full_run_with_simulated_pkg(tmp_path):
    stub = tmp_path / "stub"
    stub.mkdir()
    (stub / "pkg").write_text('#!/bin/bash\necho "$*" >> "$PKG_LOG"\n[ "$3" = python-pydantic-core ] && exit 1\nexit 0\n')
    (stub / "pkg").chmod(0o755)
    prefix = tmp_path / "prefix" / "bin"
    prefix.mkdir(parents=True)
    env = {"HOME": str(tmp_path / "home"), "PREFIX": str(tmp_path / "prefix"), "PATH": f"{stub}:{os.environ['PATH']}",
           "PKG_LOG": str(tmp_path / "pkg.log")}
    r = run([BASH, str(INSTALL), "--force"], env, timeout=900)
    assert r.returncode == 0, r.stdout[-3000:] + r.stderr[-3000:]
    assert "interfaz web: OK" in r.stdout
    home = tmp_path / "home" / ".anime-catalog"
    assert (home / ".env").stat().st_mode & 0o777 == 0o600
    assert (home / "profiles" / "anime-2020s.yaml").exists()
    assert os.access(prefix / "anime-catalog", os.X_OK)


def test_start_script_dry_run(tmp_path):
    r = run([BASH, str(START), "--dry-run", "--open", "--port", "9123"], {"HOME": str(tmp_path)})
    assert r.returncode == 0
    assert "http://127.0.0.1:9123" in r.stdout and "termux-wake-lock" in r.stdout and "--host 127.0.0.1" in r.stdout
    assert run([BASH, str(START), "--port", "abc"], {"HOME": str(tmp_path)}).returncode == 2


@pytest.mark.skipif(shutil.which("anime-catalog") is None, reason="anime-catalog no está instalado en el PATH")
def test_start_script_serves_ui_on_localhost(tmp_path):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = {**os.environ, "HOME": str(tmp_path), "ANIME_CATALOG_HOME": str(tmp_path / "app"), "MDBLIST_API_KEY": "", "TMDB_API_KEY": ""}
    proc = subprocess.Popen([BASH, str(START), "--no-wakelock", "--port", str(port)], env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, start_new_session=True)
    try:
        status = None
        for _ in range(100):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=2) as resp:
                    status = resp.status
                    body = resp.read().decode()
                    break
            except OSError:
                time.sleep(0.2)
        assert status == 200
        assert str(tmp_path / "app") in body  # usa el directorio privado de la app
    finally:
        os.killpg(proc.pid, 15)
        proc.wait(10)


def test_termux_detection():
    assert is_termux({"TERMUX_VERSION": "0.118.1"})
    assert is_termux({"PREFIX": "/data/data/com.termux/files/usr"})
    if not Path("/data/data/com.termux/files/usr").is_dir():
        assert not is_termux({"PREFIX": "/usr"})


def test_doctor_checks(tmp_path):
    checks = {c["check"]: c for c in doctor(tmp_path)}
    assert checks["módulo pydantic_core"]["ok"] and checks["módulo fastapi"]["ok"] and checks["módulo uvicorn"]["ok"]
    assert checks["SQLite >= 3.24 (UPSERT)"]["ok"]
    assert checks["directorio de datos escribible"]["ok"]


def test_dependencies_have_no_native_extras():
    deps = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["dependencies"]
    joined = " ".join(deps)
    assert "uvicorn[standard]" not in joined and "uvloop" not in joined and "httptools" not in joined
    assert not any(d.startswith(("orjson", "ujson", "lxml", "numpy")) for d in deps)


def test_web_stack_runs_without_uvloop_or_httptools(tmp_path):
    code = (
        "import sys, importlib.abc\n"
        "class Block(importlib.abc.MetaPathFinder):\n"
        "    def find_spec(self, name, path, target=None):\n"
        "        if name.split('.')[0] in ('uvloop','httptools','watchfiles','orjson'): raise ModuleNotFoundError(name)\n"
        "sys.meta_path.insert(0, Block())\n"
        "from anime_catalog.config import Settings\n"
        "from anime_catalog.web.server import create_app\n"
        "from pathlib import Path\n"
        f"d=Path({str(tmp_path)!r})\n"
        "app=create_app(Settings(database_path=d/'a.db', datasets_dir=d/'ds', reports_dir=d/'r', profiles_dir=d/'p', env_file=d/'.env', overrides_path=d/'o.yaml'))\n"
        "import uvicorn.config\n"
        "print('ok')\n"
    )
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and "ok" in r.stdout, r.stderr


def test_ui_refuses_remote_binding_without_token():
    from anime_catalog.config import Settings
    from anime_catalog.web.server import run as run_server

    with pytest.raises(SystemExit, match="allow-remote"):
        run_server(Settings(), host="0.0.0.0", port=8765)
    with pytest.raises(SystemExit, match="token"):
        run_server(Settings(), host="0.0.0.0", port=8765, allow_remote=True, access_token=None)
