#!/usr/bin/env bash
# =============================================================================
# Prox4u — Test manuel NSCA (module centreon-nsca)
#
# Envoie une trame de check passif vers un daemon NSCA de test et vérifie le
# statut correspondant dans Centreon. Permet de valider le canal de bout en
# bout SANS passer par l'app (isoler le problème app vs Centreon).
#
# Usage :
#   NSCA_HOST=central.example NSCA_PORT=5668 NSCA_PASS=secret \
#   CENTREON_HOST=vm-web-01 CENTREON_SERVICE=Prox4u-Alarm-CPU \
#   ./scripts/nsca-test.sh
#
# Prérequis : le binaire `send_nsca` dans le PATH, et un service passif
# `CENTREON_SERVICE` déjà provisionné sur l'hôte `CENTREON_HOST` (via Prox4u
# ou à la main). Le daemon NSCA du central doit accepter 2DES (mot de passe).
# =============================================================================
set -euo pipefail

NSCA_HOST="${NSCA_HOST:-central.example}"
NSCA_PORT="${NSCA_PORT:-5668}"
NSCA_PASS="${NSCA_PASS:-}"
CENTREON_HOST="${CENTREON_HOST:-vm-web-01}"
CENTREON_SERVICE="${CENTREON_SERVICE:-Prox4u-Alarm-CPU}"
CODE="${CODE:-2}"   # 0=OK 1=WARNING 2=CRITICAL 3=UNKNOWN
OUTPUT="${OUTPUT:-Prox4u — trame de test manuelle (check passif NSCA)}"

command -v send_nsca >/dev/null 2>&1 || { echo "ERREUR : le binaire 'send_nsca' n'est pas dans le PATH (apt-get install nsca-client)"; exit 1; }
[ -n "$NSCA_PASS" ] || { echo "ERREUR : NSCA_PASS vide (mot de passe du daemon NSCA)"; exit 1; }

CFG="$(mktemp /tmp/send_nsca.XXXXXX.cfg)"
trap 'rm -f "$CFG"' EXIT
chmod 600 "$CFG"
cat > "$CFG" <<EOF
server ${NSCA_HOST}
port ${NSCA_PORT}
encrypt 1
password ${NSCA_PASS}
timeout 15
EOF

echo "→ Envoi de la trame vers ${NSCA_HOST}:${NSCA_PORT}"
echo "  host=${CENTREON_HOST} service=${CENTREON_SERVICE} code=${CODE}"
printf '%s\t%s\t%s\t%s\n' "${CENTREON_HOST}" "${CENTREON_SERVICE}" "${CODE}" "${OUTPUT}" \
  | send_nsca -H "${NSCA_HOST}" -c "$CFG"
echo "✓ Trame acceptée par le daemon NSCA."
echo ""
echo "→ Vérification dans Centreon : ouvrir le service « ${CENTREON_SERVICE} » de l'hôte « ${CENTREON_HOST} »"
echo "  et confirmer le statut ${CODE} (0=OK 1=WARNING 2=CRITICAL 3=UNKNOWN) + le message ci-dessus."
echo "  (Le statut apparaît après la réception NSCA ; en passive, il n'est pas"
echo "   rafraîchi par un check actif — c'est la trame qui le met à jour.)"
