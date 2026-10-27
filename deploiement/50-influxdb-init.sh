#!/usr/bin/env bash
# Génère le token admin InfluxDB 3 si absent (data/influxdb/admin-token.json)
# et le synchronise avec INFLUX_TOKEN dans .env.
#
# Usage :
#   ./deploiement/50-influxdb-init.sh [dossier-install]
#     dossier-install  racine de l'application (défaut : dossier parent du kit)
set -euo pipefail
INSTALL_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$INSTALL_DIR"

DATA_DIR="data/influxdb"
TOKEN_FILE="$DATA_DIR/admin-token.json"
mkdir -p "$DATA_DIR"

if [[ -f "$TOKEN_FILE" ]]; then
  echo "Token InfluxDB déjà présent : $TOKEN_FILE"
  exit 0
fi

# Charge .env si présent (pour récupérer un INFLUX_TOKEN existant)
if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -n "${INFLUX_TOKEN:-}" && "$INFLUX_TOKEN" != "CHANGE_ME" ]]; then
  TOKEN="$INFLUX_TOKEN"
else
  RAND="$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')"
  TOKEN="apiv3_${RAND}"
  if [[ -f ".env" ]]; then
    if grep -q '^INFLUX_TOKEN=' .env; then
      sed -i.bak "s|^INFLUX_TOKEN=.*|INFLUX_TOKEN=${TOKEN}|" .env && rm -f .env.bak
    else
      printf '\n# InfluxDB 3 Core (généré par deploiement/50-influxdb-init.sh)\nINFLUX_TOKEN=%s\n' "$TOKEN" >> .env
    fi
  else
    printf '# Prox4u — variables locales (gitignored)\n\n# InfluxDB 3 Core (généré par deploiement/50-influxdb-init.sh)\nINFLUX_URL=https://localhost:8181\nINFLUX_TOKEN=%s\nINFLUX_RAW_DB=raw\nINFLUX_AGG_DB=consolidated\n' "$TOKEN" > .env
  fi
fi

cat > "$TOKEN_FILE" <<EOF
{
  "token": "${TOKEN}",
  "name": "admin",
  "description": "Admin token InfluxDB 3 (généré par deploiement/50-influxdb-init.sh)"
}
EOF
# 644 (et non 600) : Docker monte ce fichier en secret (bind-mount) et le
# conteneur tourne en utilisateur non-root → il doit pouvoir le lire.
chmod 644 "$TOKEN_FILE"
echo "Token InfluxDB créé : $TOKEN_FILE"
