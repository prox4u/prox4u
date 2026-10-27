#!/usr/bin/env bash
# Génère des certificats auto-signés (10 ans par défaut) pour l'application et
# InfluxDB dans data/tls/ — à exécuter avant `docker compose up -d influxdb`.
#
# Usage :
#   ./deploiement/40-tls-init.sh [dossier-install]
#     dossier-install  racine de l'application (défaut : dossier parent du kit)
#
# Variables optionnelles :
#   TLS_DAYS       validité en jours (défaut 3650)
#   TLS_SAN_EXTRA  SAN supplémentaires, ex: "DNS:proxmox.local,IP:192.168.1.50"
set -euo pipefail
INSTALL_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$INSTALL_DIR"

TLS_DIR="data/tls"
DAYS="${TLS_DAYS:-3650}"
SAN_EXTRA="${TLS_SAN_EXTRA:-}"

mkdir -p "$TLS_DIR"

gen() {
  local name="$1" cn="$2"
  local key="$TLS_DIR/$name-key.pem" cert="$TLS_DIR/$name-cert.pem"
  if [[ -f "$key" && -f "$cert" ]]; then
    echo "Certificat $name déjà présent : $cert"
    return 0
  fi
  local san="DNS:$cn,IP:127.0.0.1"
  [[ -n "$SAN_EXTRA" ]] && san="$san,$SAN_EXTRA"
  openssl req -x509 -newkey rsa:2048 -nodes -days "$DAYS" \
    -keyout "$key" -out "$cert" \
    -subj "/CN=$cn" \
    -addext "subjectAltName=$san"
  # 644 : le conteneur InfluxDB (user dédié, ex. uid 1500) doit pouvoir lire la clé ;
  # déployement local avec certificats auto-signés (pour un multi-utilisateurs,
  # préférer un groupe partagé + 640)
  chmod 644 "$key"
  echo "Certificat $name généré : $cert (validité ${DAYS} j)"
}

gen app localhost
gen influxdb localhost

echo
echo "À ajouter dans .env :"
echo "  TLS_KEY=data/tls/app-key.pem"
echo "  TLS_CERT=data/tls/app-cert.pem"
echo "  INFLUX_CA_CERT=data/tls/influxdb-cert.pem"
echo "  INFLUX_URL=https://localhost:8181"
