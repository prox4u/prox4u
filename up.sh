#!/usr/bin/env bash
# Prox4u — démarrage complet : InfluxDB (Docker) + application
# Usage: ./up.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

err() { echo "✗ $*" >&2; }
ok()  { echo "✓ $*"; }

# || true : une variable absente ne doit pas tuer le script (défaut appliqué ensuite)
env_get() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }

# --- 1. Prérequis --------------------------------------------------------
[[ -f .env ]] || { err ".env absent — copier .env.example et le remplir"; exit 1; }

INFLUX_URL="$(env_get INFLUX_URL)"
INFLUX_TOKEN="$(env_get INFLUX_TOKEN)"
INFLUX_CA_CERT="$(env_get INFLUX_CA_CERT)"
INFLUX_UID="$(env_get INFLUX_UID)"; INFLUX_UID="${INFLUX_UID:-1500}"
INFLUX_GID="$(env_get INFLUX_GID)"; INFLUX_GID="${INFLUX_GID:-1500}"
PORT="$(env_get PORT)"; PORT="${PORT:-8080}"

if [[ ! -f data/tls/app-cert.pem || ! -f data/tls/influxdb-cert.pem ]]; then
  err "certificats TLS absents → lancer d'abord : ./deploiement/40-tls-init.sh"
  exit 1
fi
if [[ ! -f data/influxdb/admin-token.json ]]; then
  err "token InfluxDB absent → lancer d'abord : ./deploiement/50-influxdb-init.sh"
  exit 1
fi
if [[ -z "$INFLUX_TOKEN" || "$INFLUX_TOKEN" == "CHANGE_ME" ]]; then
  err "INFLUX_TOKEN vide ou CHANGE_ME dans .env → ./deploiement/50-influxdb-init.sh"
  exit 1
fi

# ownership des données : le conteneur tourne en non-root (uid/gid INFLUX_UID:INFLUX_GID)
OWN="$(stat -c '%u:%g' data/influxdb 2>/dev/null || echo '?')"
if [[ "$OWN" != "${INFLUX_UID}:${INFLUX_GID}" ]]; then
  err "data/influxdb est en $OWN, attendu ${INFLUX_UID}:${INFLUX_GID}"
  err "→ sudo chown -R ${INFLUX_UID}:${INFLUX_GID} data/influxdb"
  exit 1
fi

# --- 2. InfluxDB (Docker) -------------------------------------------------
if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
else
  DOCKER=(sudo docker)
fi

ok "InfluxDB : démarrage du conteneur"
"${DOCKER[@]}" compose up -d influxdb

# attente du /health (Bearer exigé, cert auto-signé → cacert local)
HEALTH_URL="${INFLUX_URL:-https://localhost:8181}/health"
if [[ -n "$INFLUX_CA_CERT" && -f "$INFLUX_CA_CERT" ]]; then
  CURL_TLS=(--cacert "$INFLUX_CA_CERT")
else
  CURL_TLS=(-k)
fi
for i in $(seq 1 30); do
  if curl -sf -m 2 "${CURL_TLS[@]}" "$HEALTH_URL" -H "Authorization: Bearer $INFLUX_TOKEN" >/dev/null 2>&1; then
    ok "InfluxDB healthy (après $((i * 2)) s)"
    break
  fi
  if [[ $i -eq 30 ]]; then
    err "InfluxDB pas healthy après 60 s — logs : ${DOCKER[*]} compose logs influxdb"
    exit 1
  fi
  sleep 2
done

# --- 3. Explorer (UI InfluxDB, optionnel) -----------------------------------
# Refus de démarrer l'UI d'admin avec une clé de session faible/absente :
EXPLORER_KEY="$(env_get EXPLORER_SESSION_KEY)"
if [[ -z "$EXPLORER_KEY" || "$EXPLORER_KEY" == "CHANGE_ME" ]]; then
  echo "⚠ Explorer non démarré : définissez EXPLORER_SESSION_KEY dans .env (openssl rand -hex 32) — UI optionnelle sur le port 8888"
elif "${DOCKER[@]}" compose up -d explorer >/dev/null 2>&1; then
  ok "Explorer démarré → https://localhost:8888"
else
  echo "⚠ Explorer non démarré (optionnel) — ${DOCKER[*]} compose up -d explorer"
fi

# --- 4. Application --------------------------------------------------------
./server.sh start

ok "Prêt → https://localhost:$PORT"
