#!/usr/bin/env bash
# Prox4u — démarrage / arrêt / statut de l'instance DEV (tsx, source)
# Usage: ./server.sh {start|stop|restart|status}
#
# NB (labo) : l'app tourne en service systemd USER (prox4u, build dist) —
# voir deploiement/prox4u.user.service. Ce script gère l'instance DEV :
#   systemctl --user stop prox4u   # libérer le port 8080 avant ./server.sh start
# « status : non en cours » ne veut PAS dire que le service est arrêté
# (ce script ne voit que le process tsx / index.ts).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/logs"
PID_FILE="$LOG_DIR/server.pid"
LOG_FILE="$LOG_DIR/server.log"
PORT="${PORT:-8080}"
# TLS : si les certificats sont configurés dans .env, l'app sert HTTPS uniquement
# || true : grep sans match renvoie 1 → pipefail+set -e tueraient le script si TLS n'est pas configuré
TLS_CERT="$(grep -E '^TLS_CERT=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
if [[ -n "${TLS_CERT:-}" && -f "$ROOT/$TLS_CERT" ]]; then
  URL="https://localhost:$PORT/api/health"
  CURL_ARGS=(--cacert "$ROOT/$TLS_CERT")
else
  URL="http://localhost:$PORT/api/health"
  CURL_ARGS=()
fi

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "index.ts"
}

wait_healthy() {
  for _ in $(seq 1 20); do
    if curl -sf -m 2 "${CURL_ARGS[@]}" "$URL" > /dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

free_port() {
  # nettoie tout résidu (orphelins d'un arrêt incomplet) avant de démarrer
  pkill -f "tsx.*src/index\.ts" 2>/dev/null || true
  for _ in $(seq 1 10); do
    ss -tln 2>/dev/null | grep -q ":$PORT " || return 0
    sleep 1
  done
}

start() {
  if is_running; then
    echo "déjà en cours (pid $(cat "$PID_FILE")) → $URL"
    return 0
  fi
  free_port
  mkdir -p "$LOG_DIR"
  cd "$ROOT/packages/server"
  export PATH="$HOME/.local/bin:$PATH"
  setsid nohup npx tsx src/index.ts >> "$LOG_FILE" 2>&1 < /dev/null &
  if wait_healthy; then
    local pid
    pid="$(pgrep -f "src/index\.ts" | head -1 || true)"
    [[ -n "$pid" ]] && echo "$pid" > "$PID_FILE"
    echo "démarré (pid ${pid:-?}) → $URL"
  else
    echo "échec du démarrage — dernière ligne de $LOG_FILE :" >&2
    tail -1 "$LOG_FILE" >&2 || true
    exit 1
  fi
}

stop() {
  if ! is_running; then
    echo "non en cours"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid pgid
  pid="$(cat "$PID_FILE")"
  # tuer tout le groupe de processus (setsid au démarrage) : ne pas orpheliner
  # le child node qui détient le port
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  [[ -n "$pgid" ]] && kill -- "-$pgid" 2>/dev/null || true
  pkill -f "tsx.*src/index\.ts" 2>/dev/null || true
  for _ in $(seq 1 10); do
    pgrep -f "tsx.*src/index\.ts" > /dev/null || break
    sleep 1
  done
  pkill -9 -f "tsx.*src/index\.ts" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "arrêté (pid $pid)"
}

status() {
  if is_running; then
    echo "en cours (pid $(cat "$PID_FILE")) → $URL"
    curl -sf -m 2 "${CURL_ARGS[@]}" "$URL" && echo
  else
    echo "non en cours"
    return 1
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "usage: $0 {start|stop|restart|status}" >&2; exit 2 ;;
esac
