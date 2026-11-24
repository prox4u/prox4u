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
#   ./deploiement/70-centreon-setup.sh --token-only    # TOKEN SEUL, non-interactif
#                                                       # (pas de groupe/compte/NSCA ;
#                                                       #  le compte prox4u doit exister)
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
#   DB_USER/DB_NAME/DB_PASS  identifiants DB (défaut : lus dans
#                       /etc/centreon/centreon ; repli root via socket unix,
#                       sinon prompt interactif — utile si le fichier est absent)
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
# Fichier de config lu par le daemon nsca-ng. DÉTECTÉ depuis l'unité systemd
# (ExecStart -c) si possible ; sinon repli sur ce chemin. Le daemon nsca-ng ne
# recharge PAS sa config à la volée → un redémarrage est requis après écriture.
NSCA_CFG_PATH="${NSCA_CFG_PATH:-/etc/centreon/nsca.cfg}"
# FIFO de commandes externes lu par le broker Centreon — cible de `command_file`
# de nsca-ng (le broker y lit les PROCESS_*_CHECK_RESULT). À vérifier selon l'env.
NSCA_COMMAND_FILE="${NSCA_COMMAND_FILE:-/var/lib/centreon/broker/broker.cmd}"
# [legacy] Commande du format NSCA traditionnel (`command=`) — non utilisée par
# nsca-ng (qui écrit dans le FIFO `NSCA_COMMAND_FILE` au lieu d'exécuter une cmd).
NSCA_CHECK_COMMAND="${NSCA_CHECK_COMMAND:-/usr/bin/centengine -c /etc/centengine/centengine.cfg --external-command}"
# URL REST à SAISIR dans Prox4u : joignable depuis le serveur Prox4u (autre
# machine) → pas localhost. Défaut : calculée (même scheme+chemin que CENTRON_URL,
# hôte = IP réelle du central). Surcharge : REST_URL_PROX4U (ex. hostname/proxy).
REST_URL_PROX4U="${REST_URL_PROX4U:-}"

# ── Helpers ──────────────────────────────────────────────────────────────────
ok()   { echo "✓ $*"; }
warn() { echo "⚠ $*" >&2; }
die()  { echo "✗ $*" >&2; exit 1; }

# URL REST à saisir dans Prox4u : le serveur Prox4u est sur une AUTRE machine que
# le central → l'URL doit être joignable par le réseau, pas localhost. Défaut :
# même scheme + chemin que CENTRON_URL, hôte = IP réelle du central (hostname -I).
# Surcharge : REST_URL_PROX4U (ex. si le central est joint via un hostname/proxy).
external_rest_url() {
  [[ -n "$REST_URL_PROX4U" ]] && { printf '%s' "$REST_URL_PROX4U"; return; }
  local url="$1" ip scheme path
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  [[ -n "$ip" ]] || ip="<ip-du-central>"
  scheme=$(sed -E 's#^(https?)://.*#\1#' <<< "$url")
  path=$(sed -E 's#^https?://[^/]+##' <<< "$url")
  [[ -n "$path" ]] || path="/centreon"
  [[ "$path" == /* ]] || path="/$path"
  printf '%s://%s%s' "$scheme" "$ip" "$path"
}

DRY_RUN=0; REMOVE=0; ROTATE_TOKEN=0; ROTATE_NSCA=0; TOKEN_ONLY=0
for a in "$@"; do
  case "$a" in
    --dry-run)      DRY_RUN=1 ;;
    --remove)       REMOVE=1 ;;
    --rotate-token) ROTATE_TOKEN=1 ;;
    --rotate-nsca)  ROTATE_NSCA=1 ;;
    --token-only)   TOKEN_ONLY=1 ;;
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

# Lire une clé DB dans un fichier de config Centreon, quel que soit le format :
#   - simple  : DB_PASS=value                          (/etc/centreon/centreon)
#   - PHP     : define('DB_PASS', 'value')
#   - PHP arr : $conf_centreon['password'] = 'value';   (ancien format — clés
#               user/name/password/host/port, mappées depuis DB_USER/DB_NAME/DB_PASS)
read_db_conf() {
  local key="$1" file="$2" v
  [[ -f "$file" ]] || return 1
  v=$(grep -E "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2- | tr -d " \t'\"")
  [[ -n "$v" ]] && { printf '%s' "$v"; return 0; }
  v=$(grep -oE "define[[:space:]]*\([[:space:]]*['\"]${key}['\"][[:space:]]*,[[:space:]]*['\"][^'\"]*['\"]" "$file" 2>/dev/null \
       | head -1 | sed -E "s/.*['\"]([^'\"]*)['\"]\$/\1/")
  [[ -n "$v" ]] && { printf '%s' "$v"; return 0; }
  local mapped
  case "$key" in
    DB_USER)  mapped="user" ;;
    DB_NAME)  mapped="name" ;;
    DB_PASS)  mapped="password" ;;
    DB_HOST)  mapped="host" ;;
    DB_PORT)  mapped="port" ;;
    *) return 1 ;;
  esac
  v=$(grep -oE "\\\$conf_centreon\[['\"]${mapped}['\"]\][[:space:]]*=[[:space:]]*['\"][^'\"]*['\"]" "$file" 2>/dev/null \
       | head -1 | sed -E "s/.*['\"]([^'\"]*)['\"]\$/\1/")
  [[ -n "$v" ]] && { printf '%s' "$v"; return 0; }
  return 1
}

# Identifiants DB — priorité : variables d'env > fichiers de config > repli.
# (Les fichiers peuvent être absents selon l'installation → ensure_db_access
#  gère le repli : root via socket unix, puis prompt interactif.)
DB_USER="${DB_USER:-}"; DB_NAME="${DB_NAME:-}"; DB_PASS="${DB_PASS:-}"
for conf in /etc/centreon/centreon /etc/centreon/centreon.conf.php; do
  [[ -n "$DB_USER" ]] || DB_USER=$(read_db_conf DB_USER "$conf" || true)
  [[ -n "$DB_NAME" ]] || DB_NAME=$(read_db_conf DB_NAME "$conf" || true)
  [[ -n "$DB_PASS" ]] || DB_PASS=$(read_db_conf DB_PASS "$conf" || true)
  if [[ -n "$DB_USER" && -n "$DB_NAME" && -n "$DB_PASS" ]]; then break; fi
done
DB_USER="${DB_USER:-centreon}"; DB_NAME="${DB_NAME:-centreon}"

# Binaire client DB : `mysql` ou `mariadb` (Debian n'a parfois que `mariadb`).
MYSQL_BIN=""
for b in mysql mariadb; do command -v "$b" >/dev/null 2>&1 && { MYSQL_BIN="$b"; break; }; done

# Connexion DB avec les identifiants résolus par ensure_db_access (DB_USER/DB_PASS).
db() {
  if [[ $DRY_RUN -eq 1 ]]; then echo "  \$ ${MYSQL_BIN:-mysql} -N -B -u $DB_USER $DB_NAME -e \"$1\""; return; fi
  if [[ -n "$DB_PASS" ]]; then
    "$MYSQL_BIN" -N -B -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "$1"
  else
    "$MYSQL_BIN" -N -B -u "$DB_USER" "$DB_NAME" -e "$1"
  fi
}

# Garantit un accès DB fonctionnel avant la 1ʳᵉ requête. Chaîne de repli :
#   1) identifiants configurés (env ou /etc/centreon/centreon) ;
#   2) root via socket (auth unix_socket — courant sur Debian, sans mdp) ;
#   3) prompt interactif du mdp DB (masqué) ;
#   4) sinon → die avec un message clair.
ensure_db_access() {
  [[ $DRY_RUN -eq 1 ]] && return 0
  [[ -n "$MYSQL_BIN" ]] || die "client mysql/mariadb absent — le script doit tourner sur le central"
  if [[ -n "$DB_PASS" ]] && "$MYSQL_BIN" -N -B -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "SELECT 1" >/dev/null 2>&1; then
    ok "accès DB OK (${DB_USER})"
    return
  fi
  if "$MYSQL_BIN" -N -B -u root "$DB_NAME" -e "SELECT 1" >/dev/null 2>&1; then
    DB_USER="root"; DB_PASS=""
    ok "accès DB OK (root via socket unix — /etc/centreon/centreon absent ou mdp invalide)"
    return
  fi
  read -r -s -p "Mot de passe DB ${DB_USER} : " DB_PASS; echo
  if "$MYSQL_BIN" -N -B -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "SELECT 1" >/dev/null 2>&1; then
    ok "accès DB OK (${DB_USER})"
    return
  fi
  die "accès DB Centreon impossible — vérifier les identifiants (env DB_USER/DB_PASS, /etc/centreon/centreon, ou root DB)"
}

# ── État global ──────────────────────────────────────────────────────────────
ADMIN_USER=""; ADMIN_PASSWORD=""; PROX4U_PASS=""
SELECTED_POLLERS=(); SELECTED_POLLER_NAMES=()
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

# Cible NSCA : le CENTRAL lui-même. Le listener NSCA (port 5668) tourne sur cette
# machine (cf. netstat) — pas de liste DB des pollers (pas d'équivalent CLAPI, et
# dans le cas mono-central la cible est la machine). L'IP est l'IP réelle de la
# machine : le serveur Prox4u (autre machine) doit joindre le central par son IP
# réelle, pas 127.0.0.1. (Pollers distants : à étendre si besoin.)
prompt_pollers() {
  local local_ip
  local_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  [[ -n "$local_ip" ]] || local_ip="127.0.0.1"
  SELECTED_POLLERS=("$local_ip")
  SELECTED_POLLER_NAMES=("Central")
  ok "cible NSCA : central ${local_ip} (listener ${NSCA_PORT})"
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
#   CONTACT -a add -v "name;alias;email;mdp;admin;gui_access;lang;authtype"
# admin=1 → contact_admin=1 → ADMIN GLOBAL (bypass des ACL — sans ça, la nouvelle
# API /api/latest/ refuse TOUT en 403 « pas la permission », même avec un token
# valide). Le flag est garanti par `setparam <alias>;admin;1` (le paramètre CLAPI
# s'appelle `admin`, PAS `contact_admin` qui est la colonne DB). authtype=local
# requis pour que le mot de passe soit posé.
setup_user() {
  if [[ $DRY_RUN -eq 1 ]]; then ok "compte ${USER_LOGIN} (dry-run)"; return; fi
  local show; show=$(clapi CONTACT show) || die "CLAPI « CONTACT show » échoué (central joignable ? auth ?)"
  # Check d'existence robuste : les noms de champs du JSON varient selon la version
  # (contact_alias/alias, contact_name/name) → on teste les deux, insensible à la casse.
  local exists; exists=$(echo "$show" | python3 -c "
import json,sys
try:
    for u in json.load(sys.stdin).get('result',[]):
        a=(u.get('contact_alias') or u.get('alias') or '').lower()
        n=(u.get('contact_name') or u.get('name') or '').lower()
        if a=='$USER_LOGIN' or n=='$USER_LOGIN': print('1'); break
except Exception: pass" 2>/dev/null || true)
  if [[ "$exists" == "1" ]]; then
    ok "compte ${USER_LOGIN} existe"
  else
    # ADD: name;alias;email;password;admin;gui_access;lang;authtype (doc CLAPI 26.10).
    clapi CONTACT add "Prox4u;${USER_LOGIN};${USER_EMAIL};${PROX4U_PASS};1;1;en;local" >/dev/null \
      || die "création du compte ${USER_LOGIN} échouée (mot de passe conforme à la politique Centreon ?)"
    ok "compte ${USER_LOGIN} créé (${USER_EMAIL})"
  fi
  # ADMIN GLOBAL garanti (idempotent, les 2 branches) : le paramètre CLAPI s'appelle
  # `admin` (PAS `contact_admin` — c'est le nom de la colonne DB). Sans ça, la
  # nouvelle API /api/latest/ refuse tout en 403 « pas la permission ».
  clapi CONTACT setparam "${USER_LOGIN};admin;1" >/dev/null 2>&1 \
    || warn "setparam admin=1 : ${USER_LOGIN} (déjà admin ?)"
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
  [[ -n "$MYSQL_BIN" ]] || die "client mysql/mariadb absent — le script doit tourner sur le central (accès DB requis pour le token)"
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
# Redémarrer le daemon NSCA (best-effort) — nécessaire si un daemon tourne déjà :
# il ne recharge PAS nsca.cfg à la volée, donc l'ancien mdp resterait actif.
# Ne s'applique qu'au daemon local (un poller distant se redémarre à la main).
maybe_restart_nsca() {
  local ip="$1" name="$2"
  # `return 0` explicite : un `return` nu renvoie le statut de la dernière
  # commande (ici l'échec du test) → set -e tuerait le script au retour.
  [[ $DRY_RUN -eq 1 ]] && return 0
  is_local_ip "$ip" || return 0
  # Le daemon NSCA écoute-t-il déjà (port en écoute = ancien mdp chargé) ?
  (exec 3<>"/dev/tcp/127.0.0.1/${NSCA_PORT}") 2>/dev/null || return 0
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "daemon NSCA en écoute sur ${name} — le redémarrer à la main pour charger le nouveau mdp"
    return
  fi
  local svc
  for svc in nsca-ng-server nsca-ng nsca centreon-nsca; do
    if systemctl restart "$svc" 2>/dev/null; then
      ok "daemon ${svc} redémarré sur ${name} (nouveau mdp NSCA chargé)"
      return
    fi
  done
  # Repli : l'unité peut avoir un nom non standard (socket activation, fork
  # custom…) → la déduire du PID qui écoute sur le port.
  local pid unit
  pid=$(ss -ltnp 2>/dev/null | awk -v p=":${NSCA_PORT}$" '$4 ~ p' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  if [[ -n "$pid" ]]; then
    unit=$(systemctl status "$pid" --no-pager 2>/dev/null | head -1 | awk '{print $2}')
    if [[ "$unit" == *.service ]] && systemctl restart "$unit" 2>/dev/null; then
      ok "daemon ${unit} redémarré sur ${name} (nouveau mdp NSCA chargé)"
      return
    fi
  fi
  warn "daemon NSCA en écoute sur ${name} mais redémarrage auto échoué — identifier l'unité (ss -ltnp | grep ${NSCA_PORT} → systemctl status <PID>) puis systemctl restart <unité>"
}
# Chemin du fichier de config lu par le daemon nsca-ng : on le DÉDUIT de l'unité
# systemd (ExecStart -c <chemin>) — c'est LA source de vérité. Repli : NSCA_CFG_PATH.
# (Écrire dans le mauvais fichier = mdp ignoré, le daemon garde sa PSK par défaut.)
nsca_daemon_cfg() {
  local ip="$1" execstart="" svc
  if is_local_ip "$ip"; then
    for svc in nsca-ng-server nsca-ng nsca centreon-nsca; do
      execstart=$(systemctl cat "$svc" 2>/dev/null | grep -m1 '^ExecStart' || true)
      [[ -n "$execstart" ]] && break
    done
  else
    execstart=$(ssh -o BatchMode=yes -o ConnectTimeout=5 "root@${ip}" \
      "for s in nsca-ng-server nsca-ng nsca centreon-nsca; do systemctl cat \$s 2>/dev/null | grep -m1 '^ExecStart' && break; done" 2>/dev/null || true)
  fi
  local p
  p=$(printf '%s' "$execstart" | grep -oE '\-c[= ]\S+' | head -1 | sed 's/^-c[= ]//')
  if [[ -n "$p" ]]; then printf '%s' "$p"; return 0; fi
  printf '%s' "$NSCA_CFG_PATH"
}
# Extrait le mdp NSCA d'une config (format nsca-ng `password = "…"` avec tab,
# ou legacy `password=…`). Fichier en argument, ou stdin si « - ».
extract_nsca_password() {
  local f="${1:--}"
  sed -nE 's/^[[:space:]]*password[[:space:]]*=[[:space:]]*//p' "$f" 2>/dev/null | head -1 \
    | sed -E 's/^"//; s/"[[:space:]]*$//; s/[[:space:]]+$//'
}
write_nsca_cfg_on() {
  local ip="$1" name="$2"
  local cfg_path cfg_block
  cfg_path=$(nsca_daemon_cfg "$ip")
  # Format nsca-ng (RFC 4279 TLS-PSK) : command_file (FIFO broker) + bloc
  # authorize (PSK + autorisation hosts/services). Le format NSCA traditionnel
  # ([main]/server_port=/password=) n'est PAS parsé par nsca-ng → le daemon
  # garderait sa PSK par défaut (« change-me ») et refuserait les trames.
  cfg_block=$(printf 'command_file = "%s"\n\nauthorize "*" {\n\tpassword = "%s"\n\thosts = ".*"\n\tservices = ".*"\n}\n' \
    "$NSCA_COMMAND_FILE" "$NSCA_PASSWORD")
  if is_local_ip "$ip"; then
    run mkdir -p "$(dirname "$cfg_path")"
    if [[ $DRY_RUN -eq 0 ]]; then printf '%s' "$cfg_block" > "$cfg_path"; chmod 600 "$cfg_path"; fi
    ok "config nsca-ng écrite localement (${cfg_path}) — poller ${name}"
  else
    # Poller distant : via SSH (root). Si inaccessible → avertissement.
    if ssh -o BatchMode=yes -o ConnectTimeout=5 "root@${ip}" "true" 2>/dev/null; then
      run ssh "root@${ip}" "mkdir -p \$(dirname ${cfg_path}) && printf '%s' $(printf '%q' "$cfg_block") > ${cfg_path} && chmod 600 ${cfg_path}"
      ok "config nsca-ng écrite sur ${name} (${ip}) via SSH (${cfg_path})"
    else
      warn "poller ${name} (${ip}) : SSH root inaccessible — écrire manuellement la config nsca-ng dans ${cfg_path} (mdp NSCA généré ci-dessous)"
    fi
  fi
  # Daemon NSCA : présence. Signal le plus fiable = le PORT en écoute (daemon
  # tournant, quel que soit le nom du binaire nsca-ng/nsca). Sinon, binaire
  # installé mais non démarré. (nsca-ng = NSCA moderne, nsca = legacy.)
  local check
  if is_local_ip "$ip"; then
    if (exec 3<>"/dev/tcp/127.0.0.1/${NSCA_PORT}") 2>/dev/null; then
      check="present"
    elif command -v nsca-ng >/dev/null 2>&1 || command -v nsca >/dev/null 2>&1; then
      check="installed"
    else
      check="absent"
    fi
  else
    check=$(ssh -o BatchMode=yes -o ConnectTimeout=5 "root@${ip}" "if (exec 3<>/dev/tcp/127.0.0.1/${NSCA_PORT}) 2>/dev/null; then echo present; elif command -v nsca-ng >/dev/null 2>&1 || command -v nsca >/dev/null 2>&1; then echo installed; else echo absent; fi" 2>/dev/null || echo unknown)
  fi
  if [[ "$check" == "present" ]]; then
    ok "daemon NSCA en écoute sur ${name} (port ${NSCA_PORT})"
  elif [[ "$check" == "installed" ]]; then
    warn "binaire NSCA installé mais daemon non démarré sur ${name} — le démarrer (systemctl start nsca-ng-server)"
  else
    warn "daemon NSCA ABSENT/INCONNU sur ${name} — installer l'add-on NSCA (nsca-ng), puis relancer ce script"
  fi
  # nsca.cfg vient d'être (ré)écrit : si un daemon tourne déjà, le redémarrer
  # pour qu'il charge le nouveau mdp (best-effort, local uniquement).
  maybe_restart_nsca "$ip" "$name"
}
setup_nsca() {
  if [[ $DRY_RUN -eq 1 ]]; then NSCA_PASSWORD="DRYRUN-NSCA"; ok "mdp NSCA (dry-run)"; return; fi
  # Idempotence : si un poller sélectionné a déjà une config nsca-ng avec un
  # mdp, le RÉUTILISER (sauf --rotate-nsca) — sinon chaque relance changerait
  # le mdp (le PSK doit rester identique entre le client et le daemon).
  # Le chemin est DÉTECTÉ depuis l'unité systemd (nsca_daemon_cfg), pas supposé.
  local i cfg existing
  if [[ $ROTATE_NSCA -eq 0 ]]; then
    for i in "${!SELECTED_POLLERS[@]}"; do
      cfg=$(nsca_daemon_cfg "${SELECTED_POLLERS[$i]}")
      if is_local_ip "${SELECTED_POLLERS[$i]}"; then
        [[ -f "$cfg" ]] || continue
        existing=$(extract_nsca_password "$cfg")
      else
        existing=$(ssh -o BatchMode=yes -o ConnectTimeout=5 "root@${SELECTED_POLLERS[$i]}" "cat ${cfg} 2>/dev/null" 2>/dev/null | extract_nsca_password -)
      fi
      if [[ -n "$existing" ]]; then
        NSCA_PASSWORD="$existing"
        ok "mdp NSCA existant réutilisé (${cfg} — ${SELECTED_POLLER_NAMES[$i]:-${SELECTED_POLLERS[$i]}})"
        break
      fi
    done
  fi
  if [[ -z "$NSCA_PASSWORD" ]]; then
    NSCA_PASSWORD=$(openssl rand -hex 12)
    ok "mdp NSCA généré"
  fi
  for i in "${!SELECTED_POLLERS[@]}"; do
    write_nsca_cfg_on "${SELECTED_POLLERS[$i]}" "${SELECTED_POLLER_NAMES[$i]:-${SELECTED_POLLERS[$i]}}"
  done
}

# ── 7. Auto-vérification ─────────────────────────────────────────────────────
verify() {
  if [[ $DRY_RUN -eq 1 ]]; then ok "vérif token + NSCA (dry-run)"; return; fi
  # 7a. Token via la nouvelle API (X-AUTH-TOKEN) sur une ressource RÉELLE
  #     (/configuration/hosts) — le racine /api/latest/ renvoie 301/404 quel que
  #     soit le token, donc non discriminant. Codes attendus :
  #       200 = token valide + permissions OK (admin global)
  #       403 = token reconnu MAIS sans permission → flag admin (contact_admin) à 0
  #       401 = token invalide · 000 = API injoignable
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "X-AUTH-TOKEN: ${API_TOKEN}" \
    "${CENTRON_URL}/api/latest/configuration/hosts" 2>/dev/null || echo 000)
  case "$code" in
    200) ok "token API valide + permissions OK (HTTP 200 sur /configuration/hosts)" ;;
    403) warn "token reconnu mais SANS permission (403) — le compte doit être ADMIN GLOBAL : centreon -u admin -p <mdp> -o CONTACT -a setparam -v \"${USER_LOGIN};admin;1\"" ;;
    401) warn "vérif token : HTTP 401 (token invalide)" ;;
    *)   warn "vérif token : HTTP ${code} (API /api/latest/ injoignable ou non exposée ?)" ;;
  esac
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
  echo "  REST URL       :  $(external_rest_url "$CENTRON_URL")   ← à saisir (joignable depuis Prox4u)"
  echo "  REST user      :  ${USER_LOGIN}"
  echo "  REST token     :  ${API_TOKEN}"
  echo "  Mdp NSCA       :  ${NSCA_PASSWORD}"
  echo "  Port NSCA      :  ${NSCA_PORT}"
  echo "  Serveur NSCA   :  ${SELECTED_POLLERS[*]:-<poller>}"
  echo "  IP central     :  ${central_ip}"
  echo "──────────────────────────────────────────────────────────────────"
  echo "  Secrets → .env du SERVEUR Prox4u (copier-coller, prévalence sur l'UI) :"
  echo "    CENTREON_REST_TOKEN=\"${API_TOKEN}\""
  echo "    CENTREON_NSCA_PASSWORD=\"${NSCA_PASSWORD}\""
  echo "    # CENTREON_CLAPI_PASSWORD=\"<mdp admin>\"   (si transport CLAPI)"
  echo "──────────────────────────────────────────────────────────────────"
  echo "  ⚠ Le token et le mdp NSCA ne sont affichés QUE ICI (et en base)."
  echo "    Groupe : ${GROUP_NAME} (admin global) · Compte : ${USER_LOGIN} (${USER_EMAIL})"
  echo "  ⚠ NSCA : vérifier que le daemon 'nsca-ng' est installé+démarré sur le central"
  echo "    et que NSCA_CHECK_COMMAND soumet bien le check à centengine."
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

# ── 10. Token seul (--token-only, non-interactif) ────────────────────────────
# Ne touche qu'au token (pas de groupe/compte/NSCA), SANS prompts (seul l'accès
# DB est requis — pas d'auth admin/CLAPI). Le compte ${USER_LOGIN} doit exister
# (créé par le mode complet ci-dessus, ou manuellement). Combinable avec
# --rotate-token (régénérer) et --remove (supprimer).
token_only_main() {
  local user_id
  if [[ $DRY_RUN -eq 1 ]]; then
    user_id="DRYRUN"
    ok "compte ${USER_LOGIN} (dry-run)"
  else
    user_id=$(db "SELECT contact_id FROM contact WHERE contact_alias='${USER_LOGIN}' LIMIT 1" || true)
    if [[ -z "$user_id" ]]; then
      die "compte ${USER_LOGIN} introuvable en base (table contact). Le créer d'abord :
      → 70-centreon-setup.sh (mode complet, sans --token-only), ou
      → CLAPI : centreon -u admin -p <mdp> -o CONTACT -a add -v \"Prox4u;${USER_LOGIN};${USER_LOGIN}@localhost;<mdp>;1;0;en;local\""
    fi
    ok "compte ${USER_LOGIN} trouvé (contact_id=${user_id})"
  fi

  if [[ $REMOVE -eq 1 ]]; then
    warn "--remove : suppression du token ${USER_LOGIN} (les services créés par le module sont conservés)"
    db "DELETE FROM security_authentication_tokens WHERE user_id=${user_id}" 2>/dev/null || true
    db "DELETE FROM token WHERE user_id=${user_id}" 2>/dev/null || true
    ok "token supprimé (re-vérifier manuellement dans l'UI Centreon si besoin)"
    exit 0
  fi

  setup_token
  # Vérif token seul (pas de listener NSCA) — sur une ressource réelle
  # (/configuration/hosts) : 200 = OK, 403 = token reconnu sans permission
  # (flag admin à 0), 401 = invalide, 000 = injoignable.
  if [[ $DRY_RUN -eq 1 ]]; then
    ok "vérif token (dry-run)"
  else
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "X-AUTH-TOKEN: ${API_TOKEN}" \
      "${CENTRON_URL}/api/latest/configuration/hosts" 2>/dev/null || echo 000)
    case "$code" in
      200) ok "token API valide + permissions OK (HTTP 200 sur /configuration/hosts)" ;;
      403) warn "token reconnu mais SANS permission (403) — le compte doit être ADMIN GLOBAL : centreon -u admin -p <mdp> -o CONTACT -a setparam -v \"${USER_LOGIN};admin;1\"" ;;
      401) warn "vérif token : HTTP 401 (token invalide)" ;;
      *)   warn "vérif token : HTTP ${code} (API /api/latest/ injoignable ou non exposée ?)" ;;
    esac
  fi

  echo ""
  echo "══════════════════════════════════════════════════════════════════"
  echo "  TOKEN API CENTREON PRÊT — à saisir dans Prox4u (Admin → Centreon (NSCA))"
  echo "══════════════════════════════════════════════════════════════════"
  echo "  Transport  :  REST v1"
  echo "  REST URL   :  $(external_rest_url "$CENTRON_URL")   ← à saisir (joignable depuis Prox4u)"
  echo "  REST user  :  ${USER_LOGIN}"
  echo "  REST token :  ${API_TOKEN}"
  echo "──────────────────────────────────────────────────────────────────"
  echo "  Secret → .env du SERVEUR Prox4u (copier-coller, prévalence sur l'UI) :"
  echo "    CENTREON_REST_TOKEN=\"${API_TOKEN}\""
  echo "──────────────────────────────────────────────────────────────────"
  echo "  ⚠ Le token n'est affiché QUE ICI (et en base). En cas de perte :"
  echo "    relancer avec --token-only --rotate-token."
  echo "══════════════════════════════════════════════════════════════════"
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  echo "Prox4u — setup Centreon (${CENTRON_URL})"
  if [[ $TOKEN_ONLY -eq 1 ]]; then
    echo "  mode --token-only : token seul (pas de groupe/compte/NSCA)"
    [[ $DRY_RUN -eq 1 ]] && echo "(mode --dry-run : rien ne sera exécuté)"
    echo ""
    ensure_db_access
    token_only_main
    exit 0
  fi
  echo "  groupe=${GROUP_NAME} · compte=${USER_LOGIN} · port NSCA=${NSCA_PORT}"
  [[ $DRY_RUN -eq 1 ]] && echo "(mode --dry-run : rien ne sera exécuté)"
  echo ""

  prompt_admin
  if [[ $REMOVE -eq 1 ]]; then
    ensure_db_access
    auth; do_remove; exit 0
  fi
  prompt_prox4u_pass
  prompt_pollers
  auth
  setup_group
  setup_user
  ensure_db_access   # DB requise uniquement pour le token (pas d'équivalent CLAPI)
  setup_token
  setup_nsca
  verify
  summary
}
main
