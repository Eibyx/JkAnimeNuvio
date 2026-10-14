#!/data/data/com.termux/files/usr/bin/bash
# Inicia la interfaz web de Anime Catalog Generator en Termux y muestra la dirección local.
#
#   bash start-termux.sh                 http://127.0.0.1:8765
#   bash start-termux.sh --port 9000
#   bash start-termux.sh --open          además abre el navegador
#   bash start-termux.sh --no-wakelock   no pedir wake-lock
#   bash start-termux.sh --dry-run       mostrar lo que se haría
#
# Android puede suspender procesos en segundo plano. Este script pide `termux-wake-lock` (mantiene
# la CPU despierta mientras corre) y lo libera al salir. Ver README → Termux para más detalles.
set -euo pipefail

PORT=8765
OPEN=0
WAKELOCK=1
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --open) OPEN=1; shift ;;
    --no-wakelock) WAKELOCK=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; exit 2 ;;
  esac
done
case "$PORT" in ''|*[!0-9]*) echo "Puerto inválido: $PORT" >&2; exit 2 ;; esac

export ANIME_CATALOG_HOME="${ANIME_CATALOG_HOME:-$HOME/.anime-catalog}"
URL="http://127.0.0.1:${PORT}"
CMD=(anime-catalog ui --host 127.0.0.1 --port "$PORT")
if ! command -v anime-catalog >/dev/null 2>&1; then
  if [ -x "$ANIME_CATALOG_HOME/venv/bin/anime-catalog" ]; then
    CMD=("$ANIME_CATALOG_HOME/venv/bin/anime-catalog" ui --host 127.0.0.1 --port "$PORT")
  elif [ "$DRY_RUN" = 0 ]; then
    echo "No se encontró anime-catalog. Ejecuta primero: bash install-termux.sh" >&2
    exit 1
  fi
fi

echo "Anime Catalog Generator"
echo "  Interfaz: ${URL}"
echo "  Datos:    ${ANIME_CATALOG_HOME}"
echo "  Ábrela en Chrome en este mismo teléfono. Ctrl+C (o cierra la sesión de Termux) para detener."

if [ "$DRY_RUN" = 1 ]; then
  [ "$WAKELOCK" = 1 ] && echo "   $ termux-wake-lock"
  [ "$OPEN" = 1 ] && echo "   $ termux-open-url ${URL}"
  echo "   $ ${CMD[*]}"
  exit 0
fi

release() { if [ "$WAKELOCK" = 1 ] && command -v termux-wake-unlock >/dev/null 2>&1; then termux-wake-unlock || true; fi; }
trap release EXIT
if [ "$WAKELOCK" = 1 ] && command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || true
fi
if [ "$OPEN" = 1 ]; then
  ( sleep 2; if command -v termux-open-url >/dev/null 2>&1; then termux-open-url "$URL"; else am start -a android.intent.action.VIEW -d "$URL" >/dev/null 2>&1 || true; fi ) &
fi
"${CMD[@]}"
