#!/usr/bin/env bash
# Prox4u — setup Centreon pour le module « Alarmes & Centreon » (famille centreon-nsca)
# À exécuter EN ROOT sur le CENTRAL Centreon (versions 22 → 26).
#
# Rôle : préparer le central pour que le module Prox4u puisse provisionner des
# services passifs (API) et envoyer des trames NSCA. Le script fait TOUT sur le
# central, de façon idempotente :
#   1. Groupe de permission `groupeprox4u` — créé si absent (CLAPI ACLGROUP)
#   2. Compte `prox4u` (mot de passe saisi) + rattachement au groupe
#      (CLAPI CONTACT, contact_admin=1 → ADMIN GLOBAL : tous les droits API/CLAPI)
#   3. Token API généré + inséré en base (security_token +
#      security_authentication_tokens, schéma 21.10+ ; fallback table `token`)
#      — affiché UNE seule fois
#   4. Mot de passe NSCA généré + posé sur le(s) poller(s) choisi(s) (nsca.cfg)
#   5. Auto-vérification : le token est accepté par la nouvelle API
#      (/api/latest/, en-tête X-AUTH-TOKEN) + le listener NSCA répond
#   6. Récap : identifiants + token + mdp NSCA + config prête à coller (Page 3)
#
# Transport du module : API (nouvelle API Centreon, /api/latest/, en-tête
# X-AUTH-TOKEN = token API). Le compte `prox4u` n'a BESOIN que du token API pour
# le provisioning ; le mdp NSCA sert au runtime (send_nsca).
#
# Usage :
#   ./deploiement/70-centreon-setup.sh                 # interactif (création)
#   ./deploiement/70-centreon-setup.sh --dry-run       # n'exécute rien (aperçu)
#   ./deploiement/70-centreon-setup.sh --remove        # nettoie groupe/compte/token
#   ./deploiement/70-centreon-setup.sh --rotate-token  # régénère le token API
#   ./deploiement/70-centreon-setup.sh --rotate-nsca   # régénère le mdp NSCA
#
# Variables :
#   CENTRON_URL         base URL du central (défaut http://localhost/centreon)
#   GROUP_NAME          nom du groupe de permission (défaut groupeprox4u)
#   USER_LOGIN          login du compte (défaut prox4u)
#   USER_EMAIL          email du compte (défaut prox4u@localhost)
#   NSCA_PORT           port du listener NSCA (défaut 5668)
#   NSCA_CFG_PATH       chemin de nsca.cfg sur le poller (défaut /etc/centreon/nsca.cfg)
#   NSCA_CHECK_COMMAND  commande de soumission du résultat NSCA vers centengine
#                       (défaut : voir ci-dessous — à ajuster si l'env diffère)
#
# Idempotent : relançable sans effet de bord. Les secrets (mdp/token/NSCA) ne sont
# JAMAIS loggués (seuls des messages génériques + les erreurs brutes le sont).
set -euo pipefail

# ── Variables ────────────────────────────────────────────────────────────────
CENTRON_URL="${CENTRON_URL:-http://localhost/centreon}"
GROUP_NAME="${GROUP_NAME:-groupeprox4u}"
USER_LOGIN="${USER_LOGIN:-prox4u}"
USER_EMAIL="${USER_EMAIL:-prox4u@localhost}"
NSCA_PORT="${NSCA_PORT:-5668}"
NSCA_CFG_PATH="${NSCA_CFG_PATH:-/etc/centreon/nsca.cfg}"
# Soumission du résultat de check passif vers centengine (à ajuster si l'env diffère).
NSCA_CHECK_COMMAND="${NSCA_CHECK_COMMAND:-/usr/bin/centengine -c /etc/centengine/centengine.cfg --external-command}"

# ── Helpers ──────────────────────────────────────────────────────────────────
ok()   { echo "✓ $*"; }
warn() { echo "⚠ $*" >&2; }
die()  { echo "✗ $*" >&2; exit 1; }

DRY_RUN=0; REMOVE=0; ROTATE_TOKEN=0; ROTATE_NSCA=0
for a in "$@"; do
  case "$a" in
    --dry-run)      DRY_RUN=1 ;;
    --remove)       REMOVE=1 ;;
    --rotate-token) ROTATE_TOKEN=1 ;;
    --rotate-nsca)  ROTATE_NSCA=1 ;;
    -h|--help)      grep '^# ' "$0" | sed 's/^# //'; exit 0 ;;
    *) die "option inconnue : $a (voir --help)" ;;
  esac
done

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    local out="" a2; for a2 in "$@"; do out+="$(printf '%q' "$a2") "; done
    echo "  \$ ${out% }"
  else
    "$@"
  fi
}

# JSON → valeur (python3, robuste). $1 = clé, stdin = JSON.
jget() { python3 -c "import json,sys; print(json.load(sys.stdin).get('$1',''))" 2>/dev/null || true; }

# ── 0. Prérequis ─────────────────────────────────────────────────────────────
[[ $EUID -eq 0 || $DRY_RUN -eq 1 ]] || die "à exécuter en root (sudo)"
for b in curl python3 openssl; do command -v "$b" >/dev/null 2>&1 || die "binaire requis absent : $b"; done

# Identifiants DB (fichier de config Centreon) — pour le token + la liste des pollers.
DB_USER="centreon"; DB_NAME="centreon"; DB_PASS=""
if [[ -f /etc/centreon/centreon ]]; then
  DB_USER=$(grep -E '^DB_USER' /etc/centreon/centreon | head -1 | cut -d= -f2 || true); DB_USER="${DB_USER:-centreon}"
  DB_NAME=$(grep -E '^DB_NAME' /etc/centreon/centreon | head -1 | cut -d= -f2 || true); DB_NAME="${DB_NAME:-centreon}"
  DB_PASS=$(grep -E '^DB_PASS' /etc/centreon/centreon | head -1 | cut -d= -f2 || true)
fi
db() {
  if [[ $DRY_RUN -eq 1 ]]; then echo "  \$ mysql -N -B -u $DB_USER $DB_NAME -e \"$1\""; return; fi
  mysql -N -B -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "$1"
}

# ── État global ──────────────────────────────────────────────────────────────
ADMIN_USER=""; ADMIN_PASSWORD=""; PROX4U_PASS=""
SELECTED_POLLERS=(); SELECTED_POLLER_NAMES=()
POLLER_IDS=(); POLLER_NAMES=(); POLLER_IPS=()
AUTH_TOKEN=""; GROUP_ID=""; API_TOKEN=""; NSCA_PASSWORD=""

# ── 1. Prompts interactifs ───────────────────────────────────────────────────
prompt_admin() {
  if [[ $DRY_RUN -eq 1 ]]; then ADMIN_USER="admin"; ADMIN_PASSWORD="DRYRUN"; ok "admin (dry-run)"; return; fi
  read -r -p "User admin Centreon [admin] : " ADMIN_USER; ADMIN_USER="${ADMIN_USER:-admin}"
  read -r -s -p "Mot de passe admin (masqué) : " ADMIN_PASSWORD; echo
  [[ -n "$ADMIN_PASSWORD" ]] || die "mot de passe admin requis"
}

prompt_prox4u_pass() {
  if [[ $DRY_RUN -eq 1 ]]; then PROX4U_PASS="DRYRUN-PASS"; ok "mdp ${USER_LOGIN} (dry-run)"; return; fi
  read -r -s -p "Mot de passe du compte ${USER_LOGIN} : " PROX4U_PASS; echo
  local p2; read -r -s -p "Confirmation : " p2; echo
  [[ "$PROX4U_PASS" == "$p2" ]] || die "les deux mots de passe ne correspondent pas"
  [[ ${#PROX4U_PASS} -ge 8 ]] || warn "mot de passe < 8 caractères (recommandé ≥ 8)"
}

# Liste les pollers (DB) et fait choisir (numéros séparés par des espaces).
prompt_pollers() {
  if [[ $DRY_RUN -eq 1 ]]; then
    SELECTED_POLLERS=("127.0.0.1"); SELECTED_POLLER_NAMES=("poller-dryrun")
    ok "poller (dry-run) : 127.0.0.1"
    return
  fi
  local rows; rows=$(db "SELECT instance_id, instance_name, ns_ip_address FROM instances WHERE ns_activate=1 ORDER BY instance_id" 2>/dev/null || \
               db "SELECT instance_id, instance_name, instance_ip FROM instance WHERE ns_activate=1 ORDER BY instance_id" 2>/dev/null || true)
  [[ -n "$rows" ]] || die "aucun poller actif trouvé en base (table instances/instance)"
  echo ""
  echo "Pollers disponibles :"
  local n=0 id name ip
  while IFS=$'\t' read -r id name ip; do
    [[ -z "${id:-}" ]] && continue
    n=$((n+1)); POLLER_IDS+=("$id"); POLLER_NAMES+=("$name"); POLLER_IPS+=("$ip")
    printf "  [%d] %s  (%s)\n" "$n" "$name" "$ip"
  done <<< "$rows"
  echo ""
  local sel s; read -r -p "Numéro(s) de poller(s) pour le mdp NSCA (ex. 1 ou 1 2) : " sel
  for s in $sel; do
    [[ "$s" =~ ^[0-9]+$ ]] && (( s >= 1 && s <= n )) || { warn "numéro ignoré : $s"; continue; }
    SELECTED_POLLERS+=("${POLLER_IPS[$((s-1))]}")
    SELECTED_POLLER_NAMES+=("${POLLER_NAMES[$((s-1))]}")
  done
  [[ ${#SELECTED_POLLERS[@]} -gt 0 ]] || die "aucun poller sélectionné"
}

# ── 2. Auth admin (REST legacy) → authToken ──────────────────────────────────
auth() {
  if [[ $DRY_RUN -eq 1 ]]; then AUTH_TOKEN="DRYRUN"; ok "auth admin (dry-run)"; return; fi
  local resp
  resp=$(curl -s -X POST "${CENTRON_URL}/api/index.php?action=authenticate" \
            -F "username=${ADMIN_USER}" -F "password=${ADMIN_PASSWORD}") || die "curl auth échoué (URL ?)"
  AUTH_TOKEN=$(echo "$resp" | jget authToken)
  [[ -n "$AUTH_TOKEN" ]] || die "auth admin échouée (user/mdp incorrects ?) — réponse : ${resp:0:120}"
  ok "auth admin OK (${ADMIN_USER})"
}

# CLAPI-over-REST : $1=object $2=action [$3=values]
clapi() {
  local object="$1" action="$2" values="${3:-}" body
  if [[ $DRY_RUN -eq 1 ]]; then echo "  \$ clapi ${object} ${action} ${values:-}"; return; fi
  if [[ -n "$values" ]]; then
    body=$(python3 -c "import json,sys; print(json.dumps({'action':sys.argv[1],'object':sys.argv[2],'values':sys.argv[3]}))" "$action" "$object" "$values")
  else
    body=$(python3 -c "import json,sys; print(json.dumps({'action':sys.argv[1],'object':sys.argv[2]}))" "$action" "$object")
  fi
  curl -s -X POST "${CENTRON_URL}/api/index.php?action=action&object=centreon_clapi" \
    -H "Content-Type: application/json" \
    -H "centreon-auth-token: ${AUTH_TOKEN}" \
    -d "$body"
}

# ── 3. Groupe de permission ──────────────────────────────────────────────────
# Le compte sera ADMIN GLOBAL (contact_admin=1, voir setup_user) : le groupe sert
# à l'organisation. On le crée donc sans règle ACL complexe (robuste 22→26).
setup_group() {
  if [[ $DRY_RUN -eq 1 ]]; then GROUP_ID="DRYRUN"; ok "groupe ${GROUP_NAME} (dry-run)"; return; fi
  local show; show=$(clapi ACLGROUP show) || die "CLAPI « ACLGROUP show » échoué (central joignable ? auth ?)"
  GROUP_ID=$(echo "$show" | python3 -c "
import json,sys
try:
    for g in json.load(sys.stdin).get('result',[]):
        if g.get('name')=='$GROUP_NAME': print(g.get('id')); break
except Exception: pass" 2>/dev/null || true)
  if [[ -n "$GROUP_ID" ]]; then
    ok "groupe ${GROUP_NAME} existe (id=${GROUP_ID})"
  else
    # ACLGROUP add: "name;alias" (2 champs requis).
    clapi ACLGROUP add "${GROUP_NAME};Prox4u (module)" >/dev/null || die "CLAPI « ACLGROUP add » échoué"
    show=$(clapi ACLGROUP show) || die "CLAPI « ACLGROUP show » (relecture) échoué"
    GROUP_ID=$(echo "$show" | python3 -c "
import json,sys
try:
    for g in json.load(sys.stdin).get('result',[]):
        if g.get('name')=='$GROUP_NAME': print(g.get('id')); break
except Exception: pass" 2>/dev/null || true)
    [[ -n "$GROUP_ID" ]] || die "création du groupe ${GROUP_NAME} échouée"
    ok "groupe ${GROUP_NAME} créé (id=${GROUP_ID})"
  fi
}

# ── 4. Compte + rattachement ─────────────────────────────────────────────────
# L'objet CLAPI pour un user Centreon (login+mdp) est CONTACT (pas USER) :
#   CONTACT -a add -v "name;login;email;mdp;admin;oreon;lang;authtype"
# admin=1 → contact_admin=1 → ADMIN GLOBAL (is_admin=1, bypass des ACL — c'est ce
# qui garantit que le module a tous les droits REST/CLAPI, robuste 22→26).
# authtype=local est requis pour que le mot de passe soit posé.
setup_user() {
  if [[ $DRY_RUN -eq 1 ]]; then ok "compte ${USER_LOGIN} (dry-run)"; return; fi
  local show; show=$(clapi CONTACT show) || die "CLAPI « CONTACT show » échoué (central joignable ? auth ?)"
  local exists; exists=$(echo "$show" | python3 -c "
import json,sys
try:
    for u in json.load(sys.stdin).get('result',[]):
        if u.get('contact_alias')=='$USER_LOGIN' or u.get('contact_name')=='$USER_LOGIN': print('1'); break
except Exception: pass" 2>/dev/null || true)
  if [[ "$exists" == "1" ]]; then
    ok "compte ${USER_LOGIN} existe"
    # S'assurer qu'il est admin global (idempotent, best-effort).
    clapi CONTACT setparam "${USER_LOGIN};contact_admin;1" >/dev/null 2>&1 \
      || warn "setparam contact_admin=1 : ${USER_LOGIN} (déjà admin ?)"
  else
    clapi CONTACT add "Prox4u;${USER_LOGIN};${USER_EMAIL};${PROX4U_PASS};1;0;en;local" >/dev/null \
      || die "création du compte ${USER_LOGIN} échouée (mot de passe conforme à la politique Centreon ?)"
    ok "compte ${USER_LOGIN} créé (admin global) (${USER_EMAIL})"
  fi
  # Rattachement au groupe (idempotent).
  local rc; rc=$(clapi ACLGROUP addcontact "${GROUP_NAME};${USER_LOGIN}" 2>&1 || true)
  if echo "$rc" | grep -qiE "error|fail|exception"; then
    warn "rattachement groupe : ${rc:0:160} (déjà membre ?)"
  else
    ok "compte ${USER_LOGIN} rattaché à ${GROUP_NAME}"
  fi
}

# ── 5. Token API ─────────────────────────────────────────────────────────────
# Pas d'endpoint API/CLAPI de génération de token → INSERT SQL.
# Schéma 21.10+ (donc 22→26) : 2 tables
#   security_token (id, token, creation_date, expiration_date)
#   security_authentication_tokens (token [PK], provider_token_id,
#     provider_configuration_id, user_id, token_name, token_type, creator_id,
#     creator_name, is_revoked)
# Fallback : ancienne table `token` (≤ 20.x).
setup_token() {
  if [[ $DRY_RUN -eq 1 ]]; then API_TOKEN="DRYRUN-TOKEN"; ok "token API (dry-run)"; return; fi
  command -v mysql >/dev/null 2>&1 || die "mysql absent — le script doit tourner sur le central (accès DB requis pour le token)"
  local user_id; user_id=$(db "SELECT contact_id FROM contact WHERE contact_alias='${USER_LOGIN}' LIMIT 1" || true)
  [[ -n "$user_id" ]] || die "compte ${USER_LOGIN} introuvable en base (contact) — création du compte échouée ?"

  local existing=""
  if db "SHOW TABLES LIKE 'security_authentication_tokens'" | grep -q security_authentication_tokens; then
    # ── Schéma moderne (21.10+) ──
    existing=$(db "SELECT token FROM security_authentication_tokens WHERE user_id=${user_id} AND token_type='manual' AND is_revoked=0 LIMIT 1" || true)
    if [[ -n "$existing" && $ROTATE_TOKEN -eq 0 ]]; then
      API_TOKEN="$existing"; ok "token API existant réutilisé"
      return
    fi
    API_TOKEN=$(openssl rand -hex 16)
    db "DELETE FROM security_authentication_tokens WHERE user_id=${user_id} AND token_type='manual'"
    local provider_id; provider_id=$(db "SELECT id FROM provider_configuration WHERE name='local' LIMIT 1" || true)
    [[ -n "$provider_id" ]] || die "provider 'local' introuvable (provider_configuration) — version Centreon ?"
    local st_id; st_id=$(db "INSERT INTO security_token (token, creation_date, expiration_date) VALUES ('${API_TOKEN}', UNIX_TIMESTAMP(), NULL); SELECT LAST_INSERT_ID();")
    [[ -n "$st_id" ]] || die "INSERT security_token échoué"
    db "INSERT INTO security_authentication_tokens (token, provider_token_id, provider_configuration_id, user_id, token_name, token_type, creator_id, creator_name) VALUES ('${API_TOKEN}', ${st_id}, ${provider_id}, ${user_id}, 'prox4u', 'manual', ${user_id}, 'prox4u')" \
      || die "INSERT security_authentication_tokens échoué"
    ok "token API généré + inséré (schéma security_token)"
  else
    # ── Schéma legacy (≤ 20.x) ──
    db "SHOW TABLES LIKE 'token'" | grep -q token || die "aucune table token trouvée (security_authentication_tokens ni token) — version Centreon ?"
    existing=$(db "SELECT token FROM token WHERE user_id=${user_id} LIMIT 1" || true)
    if [[ -n "$existing" && $ROTATE_TOKEN -eq 0 ]]; then
      API_TOKEN="$existing"; ok "token API existant réutilisé (schéma legacy)"
      return
    fi
    API_TOKEN=$(openssl rand -hex 16)
    db "DELETE FROM token WHERE user_id=${user_id}"
    db "INSERT INTO token (user_id, name, token) VALUES (${user_id}, 'prox4u', '${API_TOKEN}')" \
      || die "INSERT token échoué"
    ok "token API généré + inséré (schéma legacy `token`)"
  fi
}

# ── 6. NSCA (best-effort, sur le(s) poller(s) choisi(s)) ─────────────────────
is_local_ip() {
  local ip="$1" local_ip
  local_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  [[ "$ip" == "127.0.0.1" || "$ip" == "localhost" || "$ip" == "$local_ip" ]]
}
write_nsca_cfg_on() {
  local ip="$1" name="$2"
  local cfg_block
  cfg_block=$(printf '[main]\nserver_port=%s\nencrypt=1\npassword=%s\ncommand=%s\n' \
    "$NSCA_PORT" "$NSCA_PASSWORD" "$NSCA_CHECK_COMMAND")
  if is_local_ip "$ip"; then
    run mkdir -p "$(dirname "$NSCA_CFG_PATH")"
    if [[ $DRY_RUN -eq 0 ]]; then printf '%s' "$cfg_block" > "$NSCA_CFG_PATH"; chmod 600 "$NSCA_CFG_PATH"; fi
    ok "nsca.cfg écrit localement (${NSCA_CFG_PATH}) — poller ${name}"
  else
    # Poller distant : via SSH (root). Si inaccessible → avertissement.
    if ssh -o BatchMode=yes -o ConnectTimeout=5 "root@${ip}" "true" 2>/dev/null; then
      run ssh "root@${ip}" "mkdir -p \$(dirname ${NSCA_CFG_PATH}) && printf '%s' $(printf '%q' "$cfg_block") > ${NSCA_CFG_PATH} && chmod 600 ${NSCA_CFG_PATH}"
      ok "nsca.cfg écrit sur ${name} (${ip}) via SSH"
    else
      warn "poller ${name} (${ip}) : SSH root inaccessible — écrire manuellement nsca.cfg (mdp NSCA généré ci-dessous)"
    fi
  fi
  # Daemon nsca : vérifier la présence.
  local check
  if is_local_ip "$ip"; then
    check=$( { command -v nsca >/dev/null 2>&1 && echo present || echo absent; } )
  else
    check=$(ssh -o BatchMode=yes -o ConnectTimeout=5 "root@${ip}" "command -v nsca >/dev/null 2>&1 && echo present || echo absent" 2>/dev/null || echo unknown)
  fi
  if [[ "$check" == "present" ]]; then
    ok "daemon nsca présent sur ${name}"
  else
    warn "daemon nsca ABSENT/INCONNU sur ${name} — installer l'add-on NSCA de centreon-engine, puis relancer ce script"
  fi
}
setup_nsca() {
  if [[ $DRY_RUN -eq 1 ]]; then NSCA_PASSWORD="DRYRUN-NSCA"; ok "mdp NSCA (dry-run)"; return; fi
  if [[ $ROTATE_NSCA -eq 1 || -z "$NSCA_PASSWORD" ]]; then
    NSCA_PASSWORD=$(openssl rand -hex 12)
    ok "mdp NSCA généré"
  fi
  local i
  for i in "${!SELECTED_POLLERS[@]}"; do
    write_nsca_cfg_on "${SELECTED_POLLERS[$i]}" "${SELECTED_POLLER_NAMES[$i]:-${SELECTED_POLLERS[$i]}}"
  done
}

# ── 7. Auto-vérification ─────────────────────────────────────────────────────
verify() {
  if [[ $DRY_RUN -eq 1 ]]; then ok "vérif token + NSCA (dry-run)"; return; fi
  # 7a. Token via la nouvelle API (X-AUTH-TOKEN) — 401 = invalide, sinon = valide.
  #     NB : la nouvelle API est /api/latest/ (pas /api/restapi/) et s'authentifie
  #     par l'en-tête X-AUTH-TOKEN (pas Basic auth). Le module Prox4u doit l'utiliser
  #     ainsi (cf. skill centreon-nsca).
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "X-AUTH-TOKEN: ${API_TOKEN}" \
    "${CENTRON_URL}/api/latest/" 2>/dev/null || echo 000)
  if [[ "$code" != "401" && "$code" != "000" ]]; then
    ok "token API accepté par la nouvelle API (HTTP ${code})"
  else
    warn "vérif token : HTTP ${code} (token invalide, ou la nouvelle API /api/latest/ n'est-elle pas exposée ?)"
  fi
  # 7b. Listener NSCA (test TCP).
  local i ip
  for i in "${!SELECTED_POLLERS[@]}"; do
    ip="${SELECTED_POLLERS[$i]}"
    if (exec 3<>"/dev/tcp/${ip}/${NSCA_PORT}") 2>/dev/null; then
      ok "listener NSCA ${ip}:${NSCA_PORT} répond"
    else
      warn "listener NSCA ${ip}:${NSCA_PORT} ne répond pas (daemon démarré ?)"
    fi
  done
}

# ── 8. Récap ─────────────────────────────────────────────────────────────────
summary() {
  local central_ip; central_ip=$(hostname -I 2>/dev/null | awk '{print $1}'); central_ip="${central_ip:-<ip-du-central>}"
  echo ""
  echo "══════════════════════════════════════════════════════════════════"
  echo "  SETUP CENTREON TERMINÉ — à saisir dans Prox4u (Admin → Centreon (NSCA))"
  echo "══════════════════════════════════════════════════════════════════"
  echo "  Module activé :  OUI"
  echo "  Transport      :  REST v1"
  echo "  REST URL       :  ${CENTRON_URL}"
  echo "  REST user      :  ${USER_LOGIN}"
  echo "  REST token     :  ${API_TOKEN}"
  echo "  Mdp NSCA       :  ${NSCA_PASSWORD}"
  echo "  Port NSCA      :  ${NSCA_PORT}"
  echo "  Serveur NSCA   :  ${SELECTED_POLLERS[*]:-<poller>}"
  echo "  IP central     :  ${central_ip}"
  echo "──────────────────────────────────────────────────────────────────"
  echo "  ⚠ Le token et le mdp NSCA ne sont affichés QUE ICI (et en base)."
  echo "    Groupe : ${GROUP_NAME} (admin global) · Compte : ${USER_LOGIN} (${USER_EMAIL})"
  echo "  ⚠ NSCA : vérifier que le daemon 'nsca' est installé+démarré sur le(s)"
  echo "    poller(s) et que NSCA_CHECK_COMMAND soumet bien le check à centengine."
  echo "══════════════════════════════════════════════════════════════════"
}

# ── 9. Nettoyage (--remove) ──────────────────────────────────────────────────
do_remove() {
  warn "--remove : nettoyage groupe/compte/token (les services créés par le module sont conservés)"
  local user_id; user_id=$(db "SELECT contact_id FROM contact WHERE contact_alias='${USER_LOGIN}' LIMIT 1" 2>/dev/null || true)
  if [[ -n "$user_id" ]]; then
    db "DELETE FROM security_authentication_tokens WHERE user_id=${user_id}" 2>/dev/null || true
    db "DELETE FROM token WHERE user_id=${user_id}" 2>/dev/null || true
  fi
  clapi ACLGROUP delcontact "${GROUP_NAME};${USER_LOGIN}" >/dev/null 2>&1 || true
  clapi CONTACT del "${USER_LOGIN}" >/dev/null 2>&1 || true
  clapi ACLGROUP del "${GROUP_NAME}" >/dev/null 2>&1 || true
  ok "nettoyage terminé (re-vérifier manuellement dans l'UI Centreon)"
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  echo "Prox4u — setup Centreon (${CENTRON_URL})"
  echo "  groupe=${GROUP_NAME} · compte=${USER_LOGIN} · port NSCA=${NSCA_PORT}"
  [[ $DRY_RUN -eq 1 ]] && echo "(mode --dry-run : rien ne sera exécuté)"
  echo ""

  prompt_admin
  if [[ $REMOVE -eq 1 ]]; then
    auth; do_remove; exit 0
  fi
  prompt_prox4u_pass
  prompt_pollers
  auth
  setup_group
  setup_user
  setup_token
  setup_nsca
  verify
  summary
}
main
