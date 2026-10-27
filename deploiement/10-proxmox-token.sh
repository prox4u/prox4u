#!/usr/bin/env bash
# Prox4u — création du compte dédié + token API (lecture seule)
# À exécuter EN ROOT sur chaque serveur Proxmox VE — aucune interface graphique.
#
# Usage :
#   ./deploiement/10-proxmox-token.sh              # crée le rôle, l'utilisateur, le token ; affiche le token
#   ./deploiement/10-proxmox-token.sh --dry-run    # n'exécute rien, affiche les commandes qui seraient lancées
#
# Variables optionnelles :
#   PVE_APP_USER   utilisateur@realm à créer (défaut : manager@pve)
#   PVE_TOKEN_ID   identifiant du token (défaut : manager)
#   PVE_COMMENT    commentaire du compte/token
#
# Idempotent : relançable sans effet de bord. La valeur d'un token existant ne
# peut pas être re-consultée → le script l'indique et donne la commande de rotation.
set -euo pipefail

APP_USER="${PVE_APP_USER:-manager@pve}"
TOKEN_ID="${PVE_TOKEN_ID:-manager}"
COMMENT="${PVE_COMMENT:-App Prox4u — lecture seule}"
ROLE="ManagerReader"
# 100 % lecture seule, calibré sur les endpoints que l'app appelle (skill §5) :
#   DA.Read        → /cluster/resources, /cluster/status, /pools, /cluster/storage
#   Sys.Audit      → /nodes/{n}/status, RRD nœud, /storage, /nodes/{n}/network
#   VM.Audit       → /nodes/{n}/qemu/{vmid}/rrddata (historique VM)
#   SDA/SDI/SN/DA.Audit → /cluster/ceph/status + audit
PRIVS='DA.Read,DA.Audit,VM.Audit,Sys.Audit,SDA.Audit,SDI.Audit,SN.Audit'

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

ok()   { echo "✓ $*"; }
warn() { echo "⚠ $*" >&2; }
die()  { echo "✗ $*" >&2; exit 1; }

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    local out="" a
    for a in "$@"; do out+="$(printf '%q' "$a") "; done
    echo "  \$ ${out% }"
  else
    "$@"
  fi
}

# Existence (sans pveum → « absent », utile en --dry-run hors Proxmox)
has_role()  { command -v pveum >/dev/null 2>&1 && pveum role list "$ROLE" 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$ROLE"; }
has_user()  { command -v pveum >/dev/null 2>&1 && pveum user list "$APP_USER" 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$APP_USER"; }
has_token() { command -v pveum >/dev/null 2>&1 && pveum user token list "$APP_USER" 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$TOKEN_ID"; }

if [[ $DRY_RUN -eq 0 ]]; then
  [[ $EUID -eq 0 ]] || die "à lancer en root sur le serveur Proxmox (sudo ./deploiement/10-proxmox-token.sh)"
  command -v pveum >/dev/null 2>&1 || die "pveum introuvable — ce script doit tourner sur un serveur Proxmox VE"
fi

echo "→ Compte Prox4u : $APP_USER (token '$TOKEN_ID', rôle $ROLE)"
[[ $DRY_RUN -eq 1 ]] && echo "  (dry-run : aucune commande n'est exécutée)"
echo

# --- 1. Rôle lecture seule ---------------------------------------------------
if has_role; then
  ok "Rôle $ROLE déjà présent"
else
  run pveum role add "$ROLE" -privs "$PRIVS"
  ok "Rôle $ROLE créé (lecture seule : $PRIVS)"
fi

# --- 2. Utilisateur dédié ----------------------------------------------------
if has_user; then
  ok "Utilisateur $APP_USER déjà présent"
else
  run pveum user add "$APP_USER" -comment "$COMMENT"
  ok "Utilisateur $APP_USER créé"
fi

# --- 3. Token API (valeur affichée une seule fois) ---------------------------
TOKEN_VALUE=""
if has_token; then
  warn "Token $APP_USER!$TOKEN_ID déjà présent — sa valeur ne peut pas être re-consultée."
  warn "Rotation : pveum user token del $APP_USER $TOKEN_ID && pveum user token add $APP_USER $TOKEN_ID --privsep 0 -comment \"$COMMENT\""
else
  if [[ $DRY_RUN -eq 1 ]]; then
    run pveum user token add "$APP_USER" "$TOKEN_ID" --privsep 0 -comment "$COMMENT"
    TOKEN_VALUE="<valeur affichée à la création>"
  else
    # la valeur est imprimée sur stdout, une seule fois
    TOKEN_VALUE="$(pveum user token add "$APP_USER" "$TOKEN_ID" --privsep 0 -comment "$COMMENT")"
    ok "Token $TOKEN_ID créé"
  fi
fi

# --- 4. Droits sur tout le datacenter ----------------------------------------
run pveum acl modify / -user "$APP_USER" --roles "$ROLE"
ok "Rôle $ROLE accordé à $APP_USER sur / (datacenter)"

# --- 5. Auto-test avec le nouveau token --------------------------------------
if [[ $DRY_RUN -eq 0 && -n "$TOKEN_VALUE" ]]; then
  echo
  echo "→ Auto-test de l'API avec le nouveau token"
  AUTH="PVEAPIToken: $APP_USER!$TOKEN_ID=$TOKEN_VALUE"
  RESP="$(curl -sk -m 10 -H "$AUTH" https://localhost:8006/api2/json/cluster/resources || true)"
  if [[ "$RESP" == *'"type"'* ]]; then
    NODES="$(grep -o '"type":"node"' <<<"$RESP" | wc -l)"
    VMS="$(grep -o '"type":"vm"' <<<"$RESP" | wc -l)"
    ok "GET /cluster/resources → 200 ($NODES nœuds, $VMS VMs/CTs visibles) — DA.Read OK"
    FIRST_NODE="$(grep -o '"node":"[^"]*"' <<<"$RESP" | head -1 | cut -d'"' -f4)"
    if [[ -n "$FIRST_NODE" ]]; then
      CODE2="$(curl -sk -m 10 -o /dev/null -w '%{http_code}' -H "$AUTH" "https://localhost:8006/api2/json/nodes/$FIRST_NODE/status")"
      if [[ "$CODE2" == "200" ]]; then
        ok "GET /nodes/$FIRST_NODE/status → 200 — Sys.Audit OK"
      else
        warn "GET /nodes/$FIRST_NODE/status → HTTP $CODE2 (Sys.Audit insuffisant ?)"
      fi
    fi
  else
    warn "Auto-test en échec : $RESP"
    warn "Vérifier les droits : pveum acl list / -user $APP_USER"
  fi
fi

# --- 6. Récapitulatif ---------------------------------------------------------
echo
echo "────────────────────────────────────────────────────────────────"
if [[ "$TOKEN_VALUE" != "<valeur affichée à la création>" && -n "$TOKEN_VALUE" ]]; then
  echo "À reporter dans clusters.json (serveur de l'application) :"
  echo
  echo "    \"user\"       : \"$APP_USER\""
  echo "    \"tokenId\"    : \"$TOKEN_ID\""
  echo "    \"tokenValue\" : \"$TOKEN_VALUE\""
  echo
  echo "Puis : chmod 600 clusters.json && ./server.sh restart"
elif [[ $DRY_RUN -eq 1 ]]; then
  echo "dry-run : la valeur du token sera affichée ici, une seule fois, à la création."
else
  echo "Token non créé (déjà présent) — voir les avertissements ci-dessus."
fi
echo "────────────────────────────────────────────────────────────────"
