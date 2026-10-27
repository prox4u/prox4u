#!/usr/bin/env bash
# Prox4u — configuration du .env sur le serveur d'application (étape 3)
# Crée .env depuis .env.example s'il est absent et remplit automatiquement les
# variables qui dépendent de l'environnement local :
#   INFLUX_UID / INFLUX_GID  → uid/gid du user cible (défaut : user courant)
#   EXPLORER_SESSION_KEY     → clé aléatoire si vide ou CHANGE_ME (jamais écrasée)
#
# Usage :
#   ./deploiement/30-env-setup.sh [dossier-install] [user]
#     dossier-install  racine de l'application (défaut : dossier parent du kit)
#     user             user cible qui portera l'app et les données (défaut : user courant)
#
# Ensuite, dans l'ordre :
#   TLS_SAN_EXTRA="IP:<ip>" ./deploiement/40-tls-init.sh [dossier-install]
#   ./deploiement/50-influxdb-init.sh [dossier-install]
#   sudo chown -R <user>:<groupe> <dossier-install>/data
set -euo pipefail

INSTALL_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TARGET_USER="${2:-$(id -un)}"
cd "$INSTALL_DIR"
ok()   { echo "✓ $*"; }
warn() { echo "⚠ $*" >&2; }
die()  { echo "✗ $*" >&2; exit 1; }

# Le user cible doit exister (c'est lui qui portera l'app ET les données)
if ! id "$TARGET_USER" >/dev/null 2>&1; then
  die "user '$TARGET_USER' inexistant → sudo useradd -r -s /usr/sbin/nologin $TARGET_USER"
fi
UID_T="$(id -u "$TARGET_USER")"
GID_T="$(id -g "$TARGET_USER")"

# .env depuis le template s'il est absent
if [[ ! -f .env ]]; then
  cp .env.example .env
  ok ".env créé depuis .env.example"
else
  ok ".env déjà présent (seules les variables à compléter sont remplies)"
fi

env_get() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }
set_env() { # $1 = variable, $2 = valeur → remplace la ligne ou l'ajoute
  if grep -q "^${1}=" .env; then
    sed -i.bak "s|^${1}=.*|${1}=${2}|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

# INFLUX_UID / INFLUX_GID : le conteneur InfluxDB tourne avec ce uid/gid et il
# doit correspondre au propriétaire de data/ (vérifié par up.sh).
# Valeur du template (1500) ou vide → remplacée ; autre valeur → conservée.
for VAR in INFLUX_UID INFLUX_GID; do
  NEW="$UID_T"; [[ "$VAR" == "INFLUX_GID" ]] && NEW="$GID_T"
  CUR="$(env_get "$VAR")"
  if [[ -z "$CUR" || "$CUR" == "1500" ]]; then
    set_env "$VAR" "$NEW"
    ok "$VAR = $NEW (user $TARGET_USER)"
  else
    warn "$VAR déjà défini à $CUR — valeur conservée (assurez-vous que data/ est chown'ée en conséquence)"
  fi
done

# EXPLORER_SESSION_KEY : générée si vide ou CHANGE_ME, jamais écrasée ensuite
SESSION_KEY="$(env_get EXPLORER_SESSION_KEY)"
if [[ -z "$SESSION_KEY" || "$SESSION_KEY" == "CHANGE_ME" ]]; then
  set_env EXPLORER_SESSION_KEY "$(openssl rand -hex 32)"
  ok "EXPLORER_SESSION_KEY générée (UI Explorer activable sur le port 8888)"
else
  ok "EXPLORER_SESSION_KEY déjà configurée"
fi

echo
echo "Étapes suivantes, dans l'ordre (depuis le kit) :"
echo "  TLS_SAN_EXTRA=\"IP:<ip-du-serveur-app>\" ./40-tls-init.sh $INSTALL_DIR"
echo "  ./50-influxdb-init.sh $INSTALL_DIR"
echo "  sudo chown -R $TARGET_USER:$(id -gn "$TARGET_USER") $INSTALL_DIR/data"
echo "  puis : clusters.json (DEPLOY.md §6) && cd $INSTALL_DIR && ./up.sh"
