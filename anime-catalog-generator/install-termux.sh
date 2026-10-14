#!/data/data/com.termux/files/usr/bin/bash
# Instalador de Anime Catalog Generator para Termux (Android). Sin root, sin Docker y sin Node.js.
#
#   bash install-termux.sh            instalación normal
#   bash install-termux.sh --dry-run  muestra los pasos sin ejecutar nada
#   bash install-termux.sh --force    permite ejecutarlo fuera de Termux (pruebas)
#
# Qué hace:
#   1. Detecta Termux y comprueba la arquitectura.
#   2. Instala paquetes del sistema con pkg (python, compiladores, rust para pydantic-core).
#   3. Comprueba la versión de Python (>= 3.12) y SQLite (>= 3.24).
#   4. Crea un entorno virtual privado en ~/.anime-catalog/venv.
#   5. Instala pydantic-core: primero intenta el paquete de Termux; si no existe, lo compila con
#      Rust (en Termux no sirven los wheels "manylinux" de PyPI: Termux usa bionic, no glibc).
#   6. Instala la aplicación (CLI + interfaz web) sin extras nativos (nada de uvloop/httptools).
#   7. Prepara ~/.anime-catalog (datos, perfiles, .env con permisos 600) en almacenamiento privado.
#   8. Crea el comando `anime-catalog` en $PREFIX/bin y verifica con `anime-catalog doctor`.
set -euo pipefail

DRY_RUN=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 2 ;;
  esac
done

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_HOME="${ANIME_CATALOG_HOME:-$HOME/.anime-catalog}"
VENV="$APP_HOME/venv"
PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"
MIN_PY="3.12"

say()  { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[aviso]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }
run()  {
  if [ "$DRY_RUN" = 1 ]; then printf '   $ %s\n' "$*"; else "$@"; fi
}

is_termux() {
  [ -n "${TERMUX_VERSION:-}" ] || [[ "${PREFIX:-}" == /data/data/com.termux/* ]] || [ -d /data/data/com.termux/files/usr ]
}

# ---------------------------------------------------------------- 1. plataforma
say "Anime Catalog Generator · instalador para Termux"
if is_termux; then
  say "Termux detectado (TERMUX_VERSION=${TERMUX_VERSION:-?}, arquitectura $(uname -m))"
elif [ "$FORCE" = 1 ] || [ "$DRY_RUN" = 1 ]; then
  warn "No parece Termux; se continúa porque se indicó --force/--dry-run"
else
  die "Este instalador es para Termux (Android). En Linux/macOS/Windows usa: pip install -e '$SRC_DIR'  (o --force)"
fi
case "$(uname -m)" in
  aarch64|armv7l|armv8l|x86_64|i686) ;;
  *) warn "Arquitectura $(uname -m) no probada" ;;
esac

# ---------------------------------------------------------------- 2. paquetes del sistema
say "Instalando paquetes del sistema (pkg)…"
REQUIRED=(python clang make sqlite openssl libffi)
OPTIONAL=(python-pip pkg-config libyaml binutils)  # según la versión del repositorio algunos no existen o ya vienen incluidos
run pkg update -y
run pkg install -y "${REQUIRED[@]}"
for p in "${OPTIONAL[@]}"; do
  if [ "$DRY_RUN" = 1 ]; then run pkg install -y "$p"; else pkg install -y "$p" >/dev/null 2>&1 || warn "paquete opcional $p no disponible (no es necesario)"; fi
done

# ---------------------------------------------------------------- 3. Python y SQLite
PY="$(command -v python3 || command -v python || true)"
if [ "$DRY_RUN" = 1 ] && [ -z "$PY" ]; then PY=python3; fi
[ -n "$PY" ] || die "No se encontró Python tras instalar el paquete 'python'"
if [ "$DRY_RUN" = 0 ] || command -v "$PY" >/dev/null 2>&1; then
  PYV="$("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
  "$PY" - "$MIN_PY" <<'EOF' || die "Se necesita Python >= 3.12 (instalado: $PYV). Ejecuta: pkg upgrade python"
import sys
need = tuple(int(x) for x in sys.argv[1].split("."))
sys.exit(0 if sys.version_info[:2] >= need else 1)
EOF
  say "Python $PYV correcto"
  SQLV="$("$PY" -c 'import sqlite3; print(sqlite3.sqlite_version)')"
  "$PY" -c 'import sqlite3,sys; v=tuple(map(int,sqlite3.sqlite_version.split(".")[:3])); sys.exit(0 if v>=(3,24,0) else 1)' \
    || die "SQLite $SQLV es demasiado antiguo (se necesita >= 3.24). Ejecuta: pkg upgrade sqlite"
  say "SQLite $SQLV correcto"
fi

# ---------------------------------------------------------------- 4. entorno virtual
say "Preparando $APP_HOME (almacenamiento privado de Termux; no requiere termux-setup-storage)"
run mkdir -p "$APP_HOME/data" "$APP_HOME/profiles" "$APP_HOME/reports"
# --system-site-packages permite reutilizar pydantic-core si lo instaló pkg (evita compilar).
run "$PY" -m venv --system-site-packages "$VENV"
VPY="$VENV/bin/python"
# Importante: en Termux no se debe actualizar pip con pip (lo gestiona pkg); solo herramientas de build.
run "$VPY" -m pip install --upgrade setuptools wheel

# ---------------------------------------------------------------- 5. pydantic-core
have_pydantic_core() { [ "$DRY_RUN" = 0 ] && "$VPY" -c 'import pydantic_core' >/dev/null 2>&1; }
if have_pydantic_core; then
  say "pydantic-core ya disponible"
else
  say "Buscando pydantic-core precompilado en los repositorios de Termux…"
  if [ "$DRY_RUN" = 1 ]; then
    run pkg install -y python-pydantic-core
  elif pkg install -y python-pydantic-core >/dev/null 2>&1 && "$VPY" -c 'import pydantic_core' >/dev/null 2>&1; then
    say "pydantic-core instalado desde pkg"
  else
    warn "No hay paquete precompilado: se compilará pydantic-core con Rust (puede tardar 10-30 min la primera vez)"
    run pkg install -y rust
    # maturin necesita conocer el nivel de API de Android para enlazar contra bionic.
    API_LEVEL="$(getprop ro.build.version.sdk 2>/dev/null || echo 24)"
    export ANDROID_API_LEVEL="${ANDROID_API_LEVEL:-$API_LEVEL}"
    say "ANDROID_API_LEVEL=$ANDROID_API_LEVEL"
    # Limitar trabajos de compilación reduce el riesgo de que Android mate el proceso por memoria.
    export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
    run "$VPY" -m pip install --no-binary pydantic-core "pydantic>=2.6,<3"
  fi
fi
if [ "$DRY_RUN" = 1 ]; then
  echo "   (dry-run) export ANDROID_API_LEVEL=\$(getprop ro.build.version.sdk)  # usado si hay que compilar pydantic-core"
fi

# ---------------------------------------------------------------- 6. aplicación
say "Instalando Anime Catalog Generator (CLI + interfaz web)…"
# Solo dependencias puras de Python salvo pydantic-core y PyYAML (que usa libyaml si está).
run "$VPY" -m pip install "$SRC_DIR"

# ---------------------------------------------------------------- 7. configuración local
if [ ! -f "$APP_HOME/.env" ]; then
  say "Creando $APP_HOME/.env (permisos 600)"
  if [ "$DRY_RUN" = 0 ]; then
    umask 077
    cp "$SRC_DIR/.env.example" "$APP_HOME/.env"
    chmod 600 "$APP_HOME/.env"
  else
    run cp "$SRC_DIR/.env.example" "$APP_HOME/.env"
    run chmod 600 "$APP_HOME/.env"
  fi
fi
for f in "$SRC_DIR"/filters/*.yaml; do
  [ -e "$f" ] || continue
  dest="$APP_HOME/profiles/$(basename "$f")"
  if [ ! -e "$dest" ]; then run cp "$f" "$dest"; fi
done

# ---------------------------------------------------------------- 8. comando global
WRAPPER="$PREFIX_DIR/bin/anime-catalog"
say "Creando el comando $WRAPPER"
if [ "$DRY_RUN" = 0 ]; then
  BASH_BIN="$(command -v bash)"  # en Termux: $PREFIX/bin/bash
  cat > "$WRAPPER" <<EOF
#!$BASH_BIN
# Generado por install-termux.sh: usa el entorno privado de la app.
export ANIME_CATALOG_HOME="\${ANIME_CATALOG_HOME:-$APP_HOME}"
exec "$VENV/bin/anime-catalog" "\$@"
EOF
  chmod 700 "$WRAPPER"
else
  echo "   (dry-run) escribir $WRAPPER -> exec $VENV/bin/anime-catalog \"\$@\" con ANIME_CATALOG_HOME=$APP_HOME"
fi

# ---------------------------------------------------------------- verificación
say "Verificando la instalación…"
run "$WRAPPER" --help
run "$WRAPPER" doctor
if [ "$DRY_RUN" = 0 ]; then
  ANIME_CATALOG_HOME="$APP_HOME" "$VPY" - <<'EOF'
import threading, time, urllib.request
from anime_catalog.config import Settings
from anime_catalog.web.security import SecurityConfig
from anime_catalog.web.server import create_app
import uvicorn
app = create_app(Settings.from_env(), security=SecurityConfig(port=8799))
cfg = uvicorn.Config(app, host="127.0.0.1", port=8799, log_level="error")
srv = uvicorn.Server(cfg)
t = threading.Thread(target=srv.run, daemon=True); t.start()
for _ in range(50):
    try:
        with urllib.request.urlopen("http://127.0.0.1:8799/api/status", timeout=2) as r:
            print("   interfaz web: OK (HTTP %d)" % r.status); break
    except Exception:
        time.sleep(0.2)
else:
    raise SystemExit("La interfaz web no respondió")
srv.should_exit = True; t.join(5)
EOF
fi

cat <<EOF

Listo. Comandos:
  anime-catalog ui            interfaz web en http://127.0.0.1:8765 (ábrela en Chrome)
  bash $SRC_DIR/start-termux.sh   igual, con wake-lock para que Android no la suspenda
  anime-catalog mappings update   descarga los datasets (≈25 MB)
  anime-catalog --help        todos los comandos

Datos en: $APP_HOME   (privado: otras apps no pueden leerlo)
Claves: edítalas en Ajustes de la interfaz o en $APP_HOME/.env
EOF
