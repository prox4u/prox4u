#!/usr/bin/env bash
# Prox4u — déploiement de l'agent Telegraf sur un nœud Proxmox VE (bare-metal)
# À exécuter EN ROOT sur chaque serveur Proxmox VE (pas dans une VM/CT — c'est le
# host qui doit exposer SMART / capteurs / ZFS / unités systemd).
#
# Rôle : collecter les métriques locales que l'API PVE ne donne pas et les pousser
# dans l'InfluxDB 3 Core de prox4u (base `raw`) :
#   smart_device (attributs SMART prédictifs) · sensors (températures) · zfs (ARC)
#   zpool (état des pools — alarme « pool dégradé », GitHub #4)
#   systemd_units (état des unités) · disk/diskio/mem/cpu/system
#   dm_names (mapping device-mapper → LV PVE, pour l'I/O disque PAR DISQUE des VM)
#   net (trafic réseau par interface) + net_if_mac (mapping interface hôte → MAC,
#   pour le trafic PAR INTERFACE de chaque VM)
#   quorum_detail (détail corosync `pvecm status` : état du Qdevice + votes,
#   pour la surveillance du quorum cluster — l'API PVE ne donne que quorate)
#   reboot_pending (1 si /var/run/reboot-required — check d'audit pending_reboot)
#   security_updates (nb de correctifs de sécurité en attente — check d'audit)
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
# Redéploiement (telegraf déjà installé) : on saute le dépôt — pas besoin de
# télécharger la clé GPG (le réseau internet peut être instable sur le LAN).
if command -v telegraf >/dev/null 2>&1; then
  ok "telegraf déjà installé — dépôt InfluxData ignoré (redéploiement, pas de téléchargement GPG)"
elif ! apt-config dump 2>/dev/null | grep -qi "repos.influxdata.com"; then
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
if command -v telegraf >/dev/null 2>&1 && dpkg -s smartmontools lm-sensors >/dev/null 2>&1; then
  ok "paquets déjà installés (telegraf + smartmontools + lm-sensors) — apt ignoré (redéploiement)"
else
  run apt-get update -qq || \
    warn "apt-get update a échelé — on continue avec les listes cachées. Sur le nœud : cat /etc/os-release && cat /etc/apt/sources.list"
  run apt-get install -y -qq telegraf smartmontools lm-sensors
fi

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

# ── 5b. Script de mapping device-mapper → LV (consommé par le plugin exec) ──
# Les disques PVE (LVM-thin) sont des LV device-mapper : côté hôte, /proc/diskstats
# les liste comme `dm-N` SANS NOM. L'API PVE n'expose pas le mapping dm-N ↔ LV —
# seul le nœud le connaît (/sys/block/dm-N/dm/name). Le plugin exec exécute ce
# script à chaque cycle et écrit la table quasi statique `dm_names` (dm → LV,
# ex. dm-10 → local--vm--100--disk--0) : prox4u l'utilise pour l'I/O disque
# PAR DISQUE de chaque VM (Vue VM → Monitor → « Disques I/O — par device »).
DM_NAMES_SCRIPT=/usr/local/lib/prox4u-telegraf-dm-names.sh
if [[ $DRY_RUN -eq 0 ]]; then
  cat > "$DM_NAMES_SCRIPT" <<'EOS'
#!/usr/bin/env bash
# Prox4u — mapping device-mapper → LV PVE (table dm_names pour Telegraf).
# Sortie : line protocol InfluxDB (tags dm + mapper_name). Le champ présent=1i
# est obligatoire : une ligne line-protocol sans champ n'est pas valide.
# FORMAT (InfluxDB 3 Core) : `mesure,tag=v,tag=v champ=1i` — virgule après la
# mesure, tags NON quoted (key="v" serait lu comme un CHAMP string), valeurs de
# tags échappées (\, = espace). Le tag node est ajouté par global_tags.
set -euo pipefail
esc() { local v="$1"; v="${v//\\/\\\\}"; v="${v//,/\\,}"; v="${v//=/\\=}"; v="${v// /\\ }"; printf '%s' "$v"; }
for d in /sys/block/dm-*; do
  [[ -e "$d/dm/name" ]] || continue
  name="$(cat "$d/dm/name" 2>/dev/null)" || continue
  [[ -n "$name" ]] || continue
  printf 'dm_names,dm=%s,mapper_name=%s present=1i\n' "$(esc "$(basename "$d")")" "$(esc "$name")"
done
EOS
  chmod 755 "$DM_NAMES_SCRIPT"
  ok "script mapping dm → LV installé → $DM_NAMES_SCRIPT"
else
  echo "[dry-run] installerait le script $DM_NAMES_SCRIPT (mapping device-mapper → LV)"
fi

# ── 5c. Script de mapping interface → MAC (consommé par le plugin exec) ──
# Chaque carte réseau de VM/CT est un device tap côté hôte (vnet*/tap*/veth*)
# dont le NOM n'est pas exposé par l'API PVE. L'API PVE donne en revanche le
# MAC de chaque interface de VM (config net0/net1). Le plugin exec exécute ce
# script à chaque cycle et écrit la table quasi statique `net_if_mac`
# (iface hôte → MAC) : prox4u l'utilise pour le trafic réseau PAR INTERFACE
# de chaque VM (Vue VM → Monitor → « Réseau — par interface »).
IFACE_MAC_SCRIPT=/usr/local/lib/prox4u-telegraf-iface-mac.sh
if [[ $DRY_RUN -eq 0 ]]; then
  cat > "$IFACE_MAC_SCRIPT" <<'EOS'
#!/usr/bin/env bash
# Prox4u — mapping interface hôte → MAC (table net_if_mac pour Telegraf).
# Sortie : line protocol InfluxDB (tags iface + mac). Le champ présent=1i
# est obligatoire : une ligne line-protocol sans champ n'est pas valide.
# FORMAT (InfluxDB 3 Core) : `mesure,tag=v,tag=v champ=1i` — virgule après la
# mesure, tags NON quoted (key="v" serait lu comme un CHAMP string), valeurs de
# tags échappées (\, = espace). Le tag node est ajouté par global_tags.
set -euo pipefail
esc() { local v="$1"; v="${v//\\/\\\\}"; v="${v//,/\\,}"; v="${v//=/\\=}"; v="${v// /\\ }"; printf '%s' "$v"; }
for i in /sys/class/net/*; do
  [[ -r "$i/address" ]] || continue
  mac="$(cat "$i/address" 2>/dev/null)" || continue
  [[ -n "$mac" && "$mac" != "00:00:00:00:00:00" ]] || continue
  printf 'net_if_mac,iface=%s,mac=%s present=1i\n' "$(esc "$(basename "$i")")" "$(esc "$(printf '%s' "$mac" | tr 'A-F' 'a-f')")"
done
EOS
  chmod 755 "$IFACE_MAC_SCRIPT"
  ok "script mapping interface → MAC installé → $IFACE_MAC_SCRIPT"
else
  echo "[dry-run] installerait le script $IFACE_MAC_SCRIPT (mapping interface hôte → MAC)"
fi

# ── 5d. Empreinte matérielle (modèle CPU + DMI, consommé par le plugin exec) ──
# L'API PVE n'expose ni le modèle CPU ni le modèle de machine. Le plugin exec
# exécute ce script à chaque cycle et écrit la table quasi statique
# `node_hardware` (cpu_model + product + vendor + board) : prox4u l'utilise
# pour la carte « Détails hôte » de la page nœud (identification matérielle).
# Quasi-statique (change au remplacement de machine) ; prox4u lit le dernier
# point par nœud sur une fenêtre de 1 h. `unknown` = illisible (VM sans DMI).
HW_INFO_SCRIPT=/usr/local/lib/prox4u-telegraf-hw-info.sh
if [[ $DRY_RUN -eq 0 ]]; then
  cat > "$HW_INFO_SCRIPT" <<'EOS'
#!/usr/bin/env bash
# Prox4u — empreinte matérielle (table node_hardware pour Telegraf).
# Sortie : line protocol InfluxDB (tags cpu_model + product + vendor + board).
# Le champ présent=1i est obligatoire : une ligne line-protocol sans champ
# n'est pas valide. Valeur illisible → `unknown` (le serveur la mappe en null).
# FORMAT (InfluxDB 3 Core) : `mesure,tag=v,tag=v champ=1i` — virgule après la
# mesure, tags NON quoted (key="v" serait lu comme un CHAMP string), valeurs de
# tags échappées (\, = espace — le modèle CPU contient des espaces). Le tag
# node est ajouté par global_tags.
esc() { local v="$1"; v="${v//\\/\\\\}"; v="${v//,/\\,}"; v="${v//=/\\=}"; v="${v// /\\ }"; printf '%s' "$v"; }
val() { local v="${1:-}"; [[ -n "$v" ]] || v="unknown"; esc "$v"; }
cpu_model="$(awk -F': ' '/model name/ {print $2; exit}' /proc/cpuinfo 2>/dev/null)" || cpu_model=""
product="$(cat /sys/class/dmi/id/product_name 2>/dev/null)" || product=""
vendor="$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)" || vendor=""
board="$(cat /sys/class/dmi/id/board_name 2>/dev/null)" || board=""
printf 'node_hardware,cpu_model=%s,product=%s,vendor=%s,board=%s present=1i\n' \
  "$(val "$cpu_model")" "$(val "$product")" "$(val "$vendor")" "$(val "$board")"
EOS
  chmod 755 "$HW_INFO_SCRIPT"
  ok "script empreinte matérielle installé → $HW_INFO_SCRIPT"
else
  echo "[dry-run] installerait le script $HW_INFO_SCRIPT (empreinte matérielle CPU + DMI)"
fi

# ── 5e. Détail du quorum cluster (Qdevice + votes, consommé par le plugin exec) ──
# L'API PVE n'expose que `quorate` + `nodes` — PAS l'état du Qdevice ni le
# détail des votes (vérifié dans le code source PVE : /cluster/status). Le
# plugin exec exécute ce script qui parse `pvecm status` (corosync) et écrit
# la table quasi statique `quorum_detail` :
#   expected_votes · total_votes · quorum_threshold · quorate
#   has_qdevice (0/1) · qdevice_online (0/1)
# prox4u lit le dernier point par nœud (fenêtre 10 min) pour l'état RÉEL du
# Qdevice (up/down/absent) + l'alerte « Qdevice hors ligne ». Sur un nœud
# hors cluster, `pvecm status` échoue → le script ne sort rien (silencieux).
QUORUM_SCRIPT=/usr/local/lib/prox4u-telegraf-quorum.sh
if [[ $DRY_RUN -eq 0 ]]; then
  cat > "$QUORUM_SCRIPT" <<'EOS'
#!/usr/bin/env bash
# Prox4u — détail du quorum cluster (table quorum_detail pour Telegraf).
# Exécute `pvecm status` (corosync) et parse le votequorum + le membership
# (dont le Qdevice). L'API PVE ne donne que quorate + nodes : l'état du
# Qdevice (en ligne / hors ligne) et le détail des votes n'existent qu'au
# niveau corosync.
# Sortie : line protocol InfluxDB. Le tag node est ajouté par global_tags.
# Quasi statique (change au changement de membership) ; prox4u lit le dernier
# point par nœud sur une fenêtre de 10 min.
set -euo pipefail

out="$(pvecm status 2>/dev/null)" || exit 0
[[ -n "$out" ]] || exit 0

# Champ « Key: value » (correspondance exacte sur la clé, valeur sans espaces).
field() { printf '%s\n' "$out" | awk -F': *' -v k="$1" '$1==k {gsub(/ /,"",$2); print $2; exit}'; }
expected="$(field 'Expected votes')"
total="$(field 'Total votes')"
threshold="$(field 'Quorum')"
quorate="$(field 'Quorate')"
flags="$(printf '%s\n' "$out" | awk '$1=="Flags" {sub(/^Flags *: */,""); print; exit}')"

q=0; [[ "$quorate" == "Yes" ]] && q=1
hq=0; [[ "$flags" == *Qdevice* ]] && hq=1

# Qdevice dans le membership : nodeid 0x00000000 (constante corosync). On ne
# repose PAS sur le nom exact « Qdevice » en dernier champ : quand le Qdevice
# est hors ligne, la ligne porte un suffixe (« Qdevice (votes 1) ») et le
# dernier champ n'est plus « Qdevice ». En ligne = votes ($2) > 0.
qon=0
if printf '%s\n' "$out" | awk '$1=="0x00000000" {if ($2+0>0) on=1; found=1} END{exit !(found&&on)}'; then
  qon=1
fi
# Qdevice présent dans le membership (même avec 0 vote) → configuré.
if printf '%s\n' "$out" | awk '$1=="0x00000000" {found=1} END{exit !found}'; then
  hq=1
fi

printf 'quorum_detail expected_votes=%si,total_votes=%si,quorum_threshold=%si,quorate=%si,has_qdevice=%si,qdevice_online=%si\n' \
  "${expected:-0}" "${total:-0}" "${threshold:-0}" "$q" "$hq" "$qon"
EOS
  chmod 755 "$QUORUM_SCRIPT"
  ok "script détail quorum (Qdevice + votes) installé → $QUORUM_SCRIPT"
else
  echo "[dry-run] installerait le script $QUORUM_SCRIPT (détail quorum corosync : Qdevice + votes)"
fi

# ── 5f. Redémarrage en attente (consommé par le plugin exec) ──
# dpkg crée /var/run/reboot-required quand un redémarrage est requis (noyau /
# paquets mis à jour non appliqués). Le plugin exec exécute ce script à chaque
# cycle et écrit la table quasi statique `reboot_pending` (pending=1 si le
# fichier existe, 0 sinon). prox4u lit le dernier point par nœud (fenêtre 1 h)
# pour le check d'audit `pending_reboot`. Toujours une ligne (pending=0/1) :
# prox4u distingue « pas de reboot en attente » (0) de « inconnu » (pas de data).
REBOOT_SCRIPT=/usr/local/lib/prox4u-telegraf-reboot.sh
if [[ $DRY_RUN -eq 0 ]]; then
  cat > "$REBOOT_SCRIPT" <<'EOS'
#!/usr/bin/env bash
# Prox4u — redémarrage en attente (table reboot_pending pour Telegraf).
# Sortie : line protocol InfluxDB. Le champ pending=1i/0i est obligatoire
# (une ligne line-protocol sans champ n'est pas valide). Le tag node est
# ajouté par global_tags. Quasi statique (change à la mise à jour / au reboot).
set -euo pipefail
p=0
[[ -e /var/run/reboot-required ]] && p=1
printf 'reboot_pending pending=%si\n' "$p"
EOS
  chmod 755 "$REBOOT_SCRIPT"
  ok "script reboot en attente installé → $REBOOT_SCRIPT"
else
  echo "[dry-run] installerait le script $REBOOT_SCRIPT (redémarrage en attente)"
fi

# ── 5g. Mises à jour de sécurité en attente (consommé par le plugin exec) ──
# Compte les paquets de sécurité en attente (apt list --upgradable, repo
# « security »). Le plugin exec exécute ce script à chaque cycle et écrit la
# table `security_updates` (updates = nombre). prox4u lit le dernier point par
# nœud (fenêtre 1 h) pour le check d'audit `security_updates` (seuil warnCount).
# `apt list` lit les listes déjà cachées (pas de réseau) ; ~1–3 s. Toujours une
# ligne (updates=0 si rien) : prox4u distingue « 0 update » de « inconnu ».
UPDATES_SCRIPT=/usr/local/lib/prox4u-telegraf-updates.sh
if [[ $DRY_RUN -eq 0 ]]; then
  cat > "$UPDATES_SCRIPT" <<'EOS'
#!/usr/bin/env bash
# Prox4u — mises à jour de sécurité en attente (table security_updates pour
# Telegraf). Compte les paquets upgradables issus du dépôt « security ».
# Sortie : line protocol InfluxDB. Le champ updates=Ni est obligatoire. Le
# tag node est ajouté par global_tags. Quasi statique (change à chaque apt).
set -euo pipefail
count=0
if out="$(apt list --upgradable 2>/dev/null)"; then
  count="$(printf '%s\n' "$out" | grep -c 'security' || true)"
fi
[[ "$count" =~ ^[0-9]+$ ]] || count=0
printf 'security_updates updates=%si\n' "$count"
EOS
  chmod 755 "$UPDATES_SCRIPT"
  ok "script mises à jour sécurité installé → $UPDATES_SCRIPT"
else
  echo "[dry-run] installerait le script $UPDATES_SCRIPT (mises à jour sécurité en attente)"
fi

# ── 5h. État des pools ZFS (consommé par le plugin exec) ──
# `zpool status -p -H -o name,state` : l'état d'un pool (ONLINE / DEGRADED /
# OFFLINE / FAULTED / UNAVAIL) n'existe que dans zpool — le plugin zfs de
# Telegraf ne collecte que l'ARC (table `zfs`) et, en option, des counters I/O
# (table `zfs_pool`, SANS état). Ce script écrit la table `zpool` (tag pool,
# champ state) pour l'alarme « pool ZFS dégradé » (GitHub #4). prox4u lit le
# dernier point par (node, pool) sur une fenêtre de 1 h. ZFS non installé →
# silencieux (pas de ligne) : prox4u traite l'absence comme « pool inconnu »
# (pas de faux OK).
ZPOOL_SCRIPT=/usr/local/lib/prox4u-telegraf-zpool.sh
if [[ $DRY_RUN -eq 0 ]]; then
  cat > "$ZPOOL_SCRIPT" <<'EOS'
#!/usr/bin/env bash
# Prox4u — état des pools ZFS (table zpool pour Telegraf).
# Exécute `zpool status -p -H -o name,state` et sort le line protocol InfluxDB
# : une ligne par pool, tag pool=<nom>, champ state=<ONLINE|DEGRADED|...>.
# Le tag node est ajouté par global_tags. Quasi statique (change au changement
# d'état d'un pool) ; prox4u lit le dernier point par (node, pool) sur une
# fenêtre de 1 h pour l'alarme « pool ZFS dégradé » (GitHub #4).
set -euo pipefail

command -v zpool >/dev/null 2>&1 || exit 0   # ZFS non installé → silencieux
out="$(zpool status -p -H -o name,state 2>/dev/null)" || exit 0
[[ -n "$out" ]] || exit 0

while IFS=$'\t' read -r name state; do
  [[ -n "$name" && -n "$state" ]] || continue
  # Échappement tag line protocol (, = espace).
  esc="${name//,/\\,}"; esc="${esc//=/\\=}"; esc="${esc// /\\ }"
  printf 'zpool,pool=%s state="%s"\n' "$esc" "$state"
done <<< "$out"
EOS
  chmod 755 "$ZPOOL_SCRIPT"
  ok "script état pools ZFS installé → $ZPOOL_SCRIPT"
else
  echo "[dry-run] installerait le script $ZPOOL_SCRIPT (état des pools ZFS : zpool status)"
fi

if [[ $DRY_RUN -eq 1 ]]; then
  # Aperçu sans écrire (et sans exposer le token en clair sur la console).
  cat <<EOF
[dry-run] config serait générée vers $CONF :
  agent         : interval=10s, hostname=$NODE_TAG
  global_tags   : node=$NODE_TAG, node_source=telegraf
  outputs.influxdb_v2 : $INFLUX_URL (bucket=$INFLUX_BUCKET, org=$INFLUX_ORG, insecure_skip_verify=true)
  plugins       : smart, sensors, zfs, systemd_units, ping, disk, diskio, mem, cpu, system, net, exec (dm_names, iface_mac, hw_info, quorum, reboot, updates, zpool)
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

# ── Mapping device-mapper → LV PVE (table dm_names) — I/O disque par VM ──
# Le script écrit du line protocol : dm-N → nom du LV (vg--vm--<vmid>--disk--<n>).
# Quasi statique (change à la création/suppression de disques) ; prox4u lit le
# dernier point par (node, dm) sur une fenêtre de 1 h.
[[inputs.exec]]
  commands = ["/usr/local/lib/prox4u-telegraf-dm-names.sh"]
  data_format = "influx"
  timeout = "10s"

# ── Mapping interface hôte → MAC (table net_if_mac) — réseau par interface VM ──
# Le script écrit du line protocol : iface → MAC (minuscules). Quasi statique
# (change au démarrage/arrêt des VMs) ; prox4u lit le dernier point par
# (node, iface) sur une fenêtre de 1 h.
[[inputs.exec]]
  commands = ["/usr/local/lib/prox4u-telegraf-iface-mac.sh"]
  data_format = "influx"
  timeout = "10s"

# ── Empreinte matérielle (table node_hardware) — modèle CPU + DMI ──
# Quasi-statique : prox4u lit le dernier point par nœud (fenêtre 1 h) pour la
# carte « Détails hôte » de la page nœud (identification matérielle).
[[inputs.exec]]
  commands = ["/usr/local/lib/prox4u-telegraf-hw-info.sh"]
  data_format = "influx"
  timeout = "10s"

# ── Détail du quorum cluster (table quorum_detail) — Qdevice + votes ──
# pvecm status (corosync) : l'API PVE ne donne que quorate + nodes. Ce script
# fournit l'état du Qdevice (en ligne / hors ligne) et le détail des votes
# (expected/total/threshold). Quasi statique (change au changement de
# membership) ; prox4u lit le dernier point par nœud (fenêtre 10 min) pour
# l'état réel du Qdevice + l'alerte « Qdevice hors ligne ».
[[inputs.exec]]
  commands = ["/usr/local/lib/prox4u-telegraf-quorum.sh"]
  data_format = "influx"
  timeout = "10s"

# ── Redémarrage en attente (table reboot_pending) — check d'audit ──
# /var/run/reboot-required (dpkg) : 1 si un reboot est requis, 0 sinon.
# Quasi statique ; prox4u lit le dernier point par nœud (fenêtre 1 h).
[[inputs.exec]]
  commands = ["/usr/local/lib/prox4u-telegraf-reboot.sh"]
  data_format = "influx"
  timeout = "10s"

# ── Mises à jour sécurité en attente (table security_updates) — check d'audit ──
# apt list --upgradable (dépôt « security ») : nombre de correctifs en attente.
# Quasi statique ; prox4u lit le dernier point par nœud (fenêtre 1 h). Timeout
# 30 s (apt list peut prendre quelques secondes).
[[inputs.exec]]
  commands = ["/usr/local/lib/prox4u-telegraf-updates.sh"]
  data_format = "influx"
  timeout = "30s"

# ── État des pools ZFS (table zpool) — alarme « pool dégradé » (GitHub #4) ──
# zpool status -p -H -o name,state : l'état d'un pool (ONLINE/DEGRADED/…) n'est
# fourni que par zpool (le plugin zfs ne collecte que l'ARC + counters I/O).
# Quasi statique ; prox4u lit le dernier point par (node, pool) (fenêtre 1 h).
[[inputs.exec]]
  commands = ["/usr/local/lib/prox4u-telegraf-zpool.sh"]
  data_format = "influx"
  timeout = "10s"

# ── Réseau : counters par interface (table net) — trafic par NIC ──
# Toutes les interfaces : NICs physiques, ponts (vmbr*) ET tap des VMs
# (vnet*/tap*/veth*) — les tap sont la source du trafic PAR INTERFACE de
# chaque VM (MAC du tap = MAC de l'interface VM, config PVE). Prox4u calcule
# les débits par delta des counters bytes_recv/bytes_sent.
[[inputs.net]]

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
echo "      -d '{\"db\":\"raw\",\"q\":\"SELECT table_name FROM information_schema.tables WHERE table_name IN ('\''smart_device'\'','\''sensors'\'','\''zfs'\'','\''zpool'\'','\''systemd_units'\'','\''disk'\'','\''diskio'\'','\''cpu'\'','\''mem'\'','\''dm_names'\'','\''net'\'','\''net_if_mac'\'','\''reboot_pending'\'','\''security_updates'\'')\"}'"
[[ $DRY_RUN -eq 1 ]] && echo "(--dry-run : service non démarré, config non écrite)"
