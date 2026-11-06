#!/usr/bin/env bash
# Prox4u — déploiement de l'agent Telegraf sur un nœud Proxmox VE (bare-metal)
# À exécuter EN ROOT sur chaque serveur Proxmox VE (pas dans une VM/CT — c'est le
# host qui doit exposer SMART / capteurs / ZFS / unités systemd).
#
# Rôle : collecter les métriques locales que l'API PVE ne donne pas et les pousser
# dans l'InfluxDB 3 Core de prox4u (base `raw`) :
#   smart_device (attributs SMART prédictifs) · sensors (températures) · zfs (ARC/pools)
#   systemd_units (état des unités) · disk/diskio/mem/cpu/system
#
# Consolidation : le consolidateur prox4u agrège ces tables de `raw` (31 j) vers
# `consolidated` (rétention ∞) en buckets 15 min — historique SMART/capteurs/ZFS
# infini. Le module web `node-sensors` lit le dernier point (état courant) dans
# `raw` ; les buckets consolidés servent les tendances à long terme.
#
# Usage :
#   TELEGRAF_INFLUX_TOKEN="apiv3_..." ./deploiement/60-telegraf-nodes.sh
#   ./deploiement/60-telegraf-nodes.sh --dry-run          # n'exécute rien, affiche les commandes
#
# Variables :
#   TELEGRAF_INFLUX_TOKEN  token d'écriture InfluxDB — REQUIS. Par défaut réutilise le
#                          token admin de prox4u/.env ; un token dédié (write `raw`) peut
#                          être passé ici sans toucher au reste.
#   INFLUX_URL             URL InfluxDB 3 Core (défaut : https://192.168.1.180:8181)
#   INFLUX_BUCKET          base cible (défaut : raw)
#   INFLUX_ORG             organisation (défaut : influxdb)
#   PING_TARGET            IP/hostname pour la sonde de latence (défaut : hôte InfluxDB)
#
# Idempotent : relançable. Un telegraf.conf existant est sauvegardé en .bak.<ts> avant
# d'être régénéré. Le service est (re)démarré.
set -euo pipefail

# Non-interactive pour tous les apt du script (pas de prompt dpkg). Exporté globalement
# car le helper `run` passe ses args tels quels (`"$@"`) : un préfixe `VAR=x cmd` serait
# interprété comme une commande, pas comme une assignation d'environnement.
export DEBIAN_FRONTEND=noninteractive

INFLUX_URL="${INFLUX_URL:-https://192.168.1.180:8181}"
INFLUX_BUCKET="${INFLUX_BUCKET:-raw}"
INFLUX_ORG="${INFLUX_ORG:-influxdb}"
# Cible du ping : par défaut le point d'accès InfluxDB (host:port, le trajet exact
# que Telegraf utilise pour écrire — métrique de latence pertinente). Méthode TCP :
# fonctionne sans CAP_NET_RAW (Telegraf tourne en user non-root sur Debian).
PING_TARGET="${PING_TARGET:-${INFLUX_URL#https://}}"
NODE_TAG="$(hostname 2>/dev/null || echo unknown-node)"

ok()   { echo "✓ $*"; }
warn() { echo "⚠ $*" >&2; }
die()  { echo "✗ $*" >&2; exit 1; }

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    local out="" a
    for a in "$@"; do out+="$(printf '%q' "$a") "; done
    echo "  \$ ${out% }"
  else
    "$@"
  fi
}

# ── 0. Prérequis ────────────────────────────────────────────────────────────
# En --dry-run on ne change rien → le root n'est pas exigé (aperçu possible non-root).
[[ $EUID -eq 0 || $DRY_RUN -eq 1 ]] || die "à exécuter en root (sudo)"
[[ -n "${TELEGRAF_INFLUX_TOKEN:-}" ]] || \
  die "TELEGRAF_INFLUX_TOKEN requis — ex. :\n   TELEGRAF_INFLUX_TOKEN=\"\$(grep '^INFLUX_TOKEN=' /chemin/vers/prox4u/.env | cut -d= -f2)\" $0"

ok "InfluxDB   : $INFLUX_URL (bucket=$INFLUX_BUCKET, org=$INFLUX_ORG)"
ok "Tag nœud   : node=$NODE_TAG"
ok "Cible ping : $PING_TARGET"
[[ $DRY_RUN -eq 1 ]] && { echo "(mode --dry-run : rien ne sera exécuté)"; }

# ── 1. Dépôt InfluxData (requis pour telegraf — pas dans les dépôts Debian) ──
# telegraf n'est PAS dans les dépôts Debian : il vient de repos.influxdata.com.
# Si le dépôt n'est pas encore déclaré, on l'ajoute (clé GPG + source).
# On ne touche PAS aux dépôts Proxmox Enterprise (licence payante / pve-no-subscription).
if ! apt-config dump 2>/dev/null | grep -qi "repos.influxdata.com"; then
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] ajouterait le dépôt InfluxData (clé GPG + /etc/apt/sources.list.d/influxdata.list)"
  else
    mkdir -p /etc/apt/keyrings
    keytmp="$(mktemp)"
    if curl --silent --location -o "$keytmp" https://repos.influxdata.com/influxdata-archive.key \
       && gpg --show-keys --with-colons "$keytmp" 2>/dev/null | grep -q "24C975CBA61A024EE1B631787C3D57159FC2F927"; then
      gpg --dearmor < "$keytmp" > /etc/apt/keyrings/influxdata-archive.gpg
      rm -f "$keytmp"
      # Détermine le codename (trixie, bookworm, etc.)
      codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
      echo "deb [signed-by=/etc/apt/keyrings/influxdata-archive.gpg] https://repos.influxdata.com/debian ${codename} main" \
        > /etc/apt/sources.list.d/influxdata.list
      ok "dépôt InfluxData ajouté (codename=$codename, clé GPG vérifiée)"
    else
      rm -f "$keytmp"
      die "dépôt InfluxData : impossible de télécharger/vérifier la clé GPG — télégraf non installable"
    fi
  fi
else
  # Dépôt déjà déclaré : vérifier que la clé GPG existe
  if [[ ! -f /etc/apt/keyrings/influxdata-archive.gpg ]]; then
    if [[ $DRY_RUN -eq 1 ]]; then
      echo "[dry-run] installerait la clé GPG InfluxData → /etc/apt/keyrings/influxdata-archive.gpg"
    else
      keytmp="$(mktemp)"
      if curl --silent --location -o "$keytmp" https://repos.influxdata.com/influxdata-archive.key \
         && gpg --show-keys --with-colons "$keytmp" 2>/dev/null | grep -q "24C975CBA61A024EE1B631787C3D57159FC2F927"; then
        mkdir -p /etc/apt/keyrings
        gpg --dearmor < "$keytmp" > /etc/apt/keyrings/influxdata-archive.gpg
        rm -f "$keytmp"
        ok "clé GPG InfluxData installée (empreinte vérifiée)"
      else
        rm -f "$keytmp"
        warn "clé GPG InfluxData : téléchargement ou empreinte inattendue — apt update échouera sur ce dépôt"
      fi
    fi
  fi
fi

# ── 2. Paquets ──────────────────────────────────────────────────────────────
# apt-get update est en best-effort : s'il échoue (miroir injoignable, codename, clock,
# ou dépôts Enterprise 401 sans licence), les listes déjà cachées dans /var/lib/apt/lists
# suffisent souvent pour l'install. Seul l'install est fatal (sans les paquets, pas de
# déploiement). Les dépôts Enterprise 401 n'empêchent PAS d'installer telegraf (Débian).
run apt-get update -qq || \
  warn "apt-get update a échelé — on continue avec les listes cachées. Sur le nœud : cat /etc/os-release && cat /etc/apt/sources.list"
run apt-get install -y -qq telegraf smartmontools lm-sensors

# ── 3. Détection des capteurs (lm-sensors) — non interactif ────────────────
if [[ $DRY_RUN -eq 0 ]]; then
  if sensors-detect --auto --no-beep >/dev/null 2>&1; then
    ok "sensors-detect : capteurs détectés"
  else
    warn "sensors-detect : rien détecté (le plugin sensors restera vide, SMART disques non concerné)"
  fi
fi

# ── 4. Sauvegarde d'un telegraf.conf existant ──────────────────────────────
CONF=/etc/telegraf/telegraf.conf
if [[ -f $CONF ]] && [[ $DRY_RUN -eq 0 ]]; then
  cp -a "$CONF" "${CONF}.bak.$(date +%s)"
  ok "telegraf.conf existant sauvegardé → ${CONF}.bak.*"
fi

# ── 5. Génération de la config ─────────────────────────────────────────────
# insecure_skip_verify = true : cert auto-signé InfluxDB (généré par 40-tls-init.sh).
# Pour une chaîne de confiance stricte, remplacer par tls_ca = "/chemin/influxdb-cert.pem".

# ── Auto-détection des devices SMART (SATA, SAS, NVMe, RAID, LUN, baies…) ──
# smartctl --scan liste tous les devices SMART-capables quel que soit le type.
# Pour NVMe : smartctl donne le contrôleur (/dev/nvme0), Telegraf veut le namespace
# (/dev/nvme0n1). On convertit.
SMART_DEVICES=""
if [[ $DRY_RUN -eq 0 ]] && command -v smartctl &>/dev/null; then
  while IFS= read -r line; do
    dev=$(echo "$line" | awk '{print $1}')
    # NVMe : /dev/nvmeX → /dev/nvmeXn1 (namespace 1)
    if [[ "$dev" =~ ^/dev/nvme[0-9]+$ ]]; then
      dev="${dev}n1"
    fi
    SMART_DEVICES="${SMART_DEVICES}\"${dev}\","
  done < <(smartctl --scan 2>/dev/null)
  SMART_DEVICES="${SMART_DEVICES%,}"  # retire la virgule finale
  [[ -n "$SMART_DEVICES" ]] && ok "devices SMART détectés : $SMART_DEVICES" || \
    warn "smartctl --scan : aucun device détecté (le plugin smart restera vide)"
else
  SMART_DEVICES='"/dev/sda","/dev/nvme0n1"'  # fallback générique (dry-run / pas de smartctl)
fi

if [[ $DRY_RUN -eq 1 ]]; then
  # Aperçu sans écrire (et sans exposer le token en clair sur la console).
  cat <<EOF
[dry-run] config serait générée vers $CONF :
  agent         : interval=10s, hostname=$NODE_TAG
  global_tags   : node=$NODE_TAG, node_source=telegraf
  outputs.influxdb_v2 : $INFLUX_URL (bucket=$INFLUX_BUCKET, org=$INFLUX_ORG, insecure_skip_verify=true)
  plugins       : smart, sensors, zfs, systemd_units, ping, disk, diskio, mem, cpu, system
  (token masqué)
EOF
else
cat > "$CONF" <<EOF
# Prox4u — agent Telegraf (généré par deploiement/60-telegraf-nodes.sh)
# Nœud : $NODE_TAG  ·  Cible : $INFLUX_URL (bucket $INFLUX_BUCKET)

[agent]
  interval       = "10s"
  flush_interval = "10s"
  round_interval = true
  collection_jitter = "2s"
  hostname       = "$NODE_TAG"

[global_tags]
  node        = "$NODE_TAG"
  node_source = "telegraf"

# ── Sortie : InfluxDB 3 Core via le plugin influxdb_v2 (API de compatibilité) ──
# Noms d'options spécifiques au plugin influxdb_v2 (Telegraf ≥1.34) :
#   insecure_skip_verify (PAS tls_skip_verify) · retry_success (PAS retry_success_interval)
[[outputs.influxdb_v2]]
  urls                 = ["$INFLUX_URL"]
  token                = "$TELEGRAF_INFLUX_TOKEN"
  organization         = "$INFLUX_ORG"
  bucket               = "$INFLUX_BUCKET"
  insecure_skip_verify = true
  timeout              = "10s"

# ── Santé disque : attributs SMART prédictifs (smartmontools) ──
# Liste auto-détectée via smartctl --scan (SATA, SAS, NVMe, RAID, LUN, baies…).
[[inputs.smart]]
  devices = [$SMART_DEVICES]

# ── Températures (lm-sensors) : CPU + disques ──
[[inputs.sensors]]

# ── ZFS : ARC + état des pools ──
[[inputs.zfs]]

# ── Unités systemd (tous les états — le filtrage se fait côté requête) ──
[[inputs.systemd_units]]

# ── Latence réseau : à réactiver quand Telegraf aura CAP_NET_RAW (ping ICMP) ──
# [[inputs.ping]]
#   urls = ["$PING_TARGET"]
#   count = 1
#   timeout = "2s"

# ── Complément local exact (recoupe l'API PVE, mais au niveau host) ──
[[inputs.disk]]
  ignore_fs = ["tmpfs","devtmpfs","devfs","overlay","squashfs","iso9660"]
[[inputs.diskio]]
[[inputs.mem]]
[[inputs.cpu]]
  percpu = true
  totalcpu = true
[[inputs.system]]
EOF

ok "config générée → $CONF"
fi

# ── 6. Exécution en root : accès SMART / disques / capteurs ────────────────
# Sur un nœud Proxmox (hypervisor dédié), Telegraf a besoin d'accéder aux devices
# raw (/dev/sdX, /dev/nvmeX) pour smartctl, et aux capteurs hwmon. Le user
# telegraf par défaut ne peut pas → override systemd pour User=root.
if [[ $DRY_RUN -eq 0 ]]; then
  override_dir=/etc/systemd/system/telegraf.service.d
  mkdir -p "$override_dir"
  printf '[Service]\nUser=root\nGroup=root\n' > "$override_dir/override.conf"
  systemctl daemon-reload
  ok "override systemd : telegraf tourne en root (accès SMART + capteurs)"
fi

# ── 7. (Re)démarrage du service ────────────────────────────────────────────
run systemctl enable telegraf
run systemctl restart telegraf

# ── 8. Self-test ───────────────────────────────────────────────────────────
if [[ $DRY_RUN -eq 0 ]]; then
  sleep 12   # laisse le 1er cycle (interval 10s) produire + flusher
  if systemctl is-active --quiet telegraf; then
    ok "service telegraf : actif"
  else
    warn "service telegraf : INACTIF — journal : journalctl -u telegraf -n 30 --no-pager"
  fi
  # Vérifie que des points sont arrivés dans le bucket cible (requête depuis le nœud).
  if curl -sk -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TELEGRAF_INFLUX_TOKEN" \
       -H 'Content-Type: application/json' \
       --data-binary "{\"db\":\"$INFLUX_BUCKET\",\"q\":\"SELECT count(*) AS n FROM smart_device\"}" \
       "$INFLUX_URL/api/v3/query_sql" | grep -q "200"; then
    ok "écriture InfluxDB : OK (table 'smart_device' interrogable)"
  else
    warn "écriture InfluxDB : non confirmée — vérifier le token / la portée réseau (port 8181 exposé via INFLUX_LAN_BIND)"
  fi
fi

echo
echo "→ Prochaine étape (depuis le serveur prox4u) : valider que les mesures arrivent"
echo "    cd prox4u && TOK=\$(grep '^INFLUX_TOKEN=' .env | cut -d= -f2)"
echo "    curl -sk https://localhost:8181/api/v3/query_sql -H \"Authorization: Bearer \$TOK\" \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"db\":\"raw\",\"q\":\"SELECT table_name FROM information_schema.tables WHERE table_name IN ('\''smart_device'\'','\''sensors'\'','\''zfs'\'','\''systemd_units'\'','\''disk'\'','\''cpu'\'','\''mem'\'')\"}'"
[[ $DRY_RUN -eq 1 ]] && echo "(--dry-run : service non démarré, config non écrite)"
