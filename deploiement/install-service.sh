#!/usr/bin/env bash
# Prox4u — installation du service systemd SYSTÈME (à exécuter en ROOT)
#
# Usage : sudo ./deploiement/install-service.sh
#
# Ce que fait le script (idempotent) :
#   1. vérifie le build (packages/server/dist/index.js) ;
#   2. libère le port 8080 : arrête le service user `prox4u` (variante labo)
#      et toute instance dev tsx éventuelle ;
#   3. copie l'unit dans /etc/systemd/system/ ;
#   4. daemon-reload + enable + start ;
#   5. affiche le status + vérifie /api/health.
#
# Après tout changement serveur :
#   pnpm --filter @prox4u/server build && sudo systemctl restart prox4u
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$ROOT/deploiement/prox4u.service"
UNIT_DST="/etc/systemd/system/prox4u.service"
APP_USER="opencode"
PORT=8080

err() { echo "✗ $*" >&2; }
ok()  { echo "✓ $*"; }

# --- 0. root + prérequis ----------------------------------------------------
[[ $EUID -eq 0 ]] || { err "à exécuter en root : sudo $0"; exit 1; }
[[ -f "$UNIT_SRC" ]] || { err "unit absent : $UNIT_SRC"; exit 1; }
id "$APP_USER" >/dev/null 2>&1 || { err "utilisateur $APP_USER inexistant"; exit 1; }

if [[ ! -f "$ROOT/packages/server/dist/index.js" ]]; then
  err "build absent : $ROOT/packages/server/dist/index.js"
  err "→ pnpm --filter @prox4u/server build  (puis relancer ce script)"
  exit 1
fi

# --- 1. libérer le port 8080 ------------------------------------------------
USRCTL=(runuser -u "$APP_USER" -- env "XDG_RUNTIME_DIR=/run/user/$(id -u "$APP_USER")" systemctl --user)
if "${USRCTL[@]}" list-unit-files prox4u.service 2>/dev/null | grep -q prox4u; then
  echo "→ arrêt du service user prox4u (variante labo)"
  "${USRCTL[@]}" disable --now prox4u || true
fi
pkill -u "$APP_USER" -f "tsx.*src/index\.ts" 2>/dev/null || true
for _ in $(seq 1 10); do
  ss -tln 2>/dev/null | grep -q ":$PORT " || break
  sleep 1
done
if ss -tln 2>/dev/null | grep -q ":$PORT "; then
  err "port $PORT encore occupé — identifier avec : ss -tlnp | grep :$PORT"
  exit 1
fi
ok "port $PORT libre"

# --- 2. installation de l'unit ----------------------------------------------
install -m 0644 -o root -g root "$UNIT_SRC" "$UNIT_DST"
ok "unit copié → $UNIT_DST"

systemctl daemon-reload

# --- 3. enable + start -------------------------------------------------------
systemctl enable prox4u
systemctl restart prox4u
ok "service enable + démarré"

# --- 4. vérification ---------------------------------------------------------
systemctl status prox4u --no-pager || true
sleep 3
if curl -skf -m 5 "https://localhost:$PORT/api/health" >/dev/null 2>&1; then
  ok "/api/health 200 — le service est opérationnel"
else
  err "/api/health ne répond pas — vérifier : journalctl -u prox4u -n 50"
  exit 1
fi
echo
echo "Gestion courante : systemctl {status|restart|stop} prox4u · logs : journalctl -u prox4u -f"
