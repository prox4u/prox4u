#!/usr/bin/env bash
# Prox4u — paquetage d'une release (source + dist pré-buildé)
# À exécuter sur la machine de développement. Le tarball est transférable sur
# un serveur cible sans git : extraction + `pnpm install --prod` + `./up.sh`.
#
# Usage :
#   ./deploiement/20-package-release.sh [dossier-sortie]     # défaut : deploiement/releases/
#
# Le tarball est produit DANS le kit (deploiement/releases/) : le dossier
# deploiement/ reste un livrable autonome (procédure + scripts + application).
#
# Exclu du paquet (secrets / état local) : .env, clusters.json, data/, logs/,
# node_modules, deploiement/releases/, .git, .opencode.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

OUT_DIR="${1:-$KIT_DIR/releases}"
mkdir -p "$OUT_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
TARBALL="$OUT_DIR/prox4u-$STAMP.tar.gz"

echo "→ Build production (shared → server → web)"
pnpm build >/dev/null
echo "✓ build terminé"

echo "→ Tarball : $TARBALL"
tar --exclude='./node_modules' \
    --exclude='./packages/shared/node_modules' \
    --exclude='./packages/server/node_modules' \
    --exclude='./packages/web/node_modules' \
    --exclude='./data' \
    --exclude='./logs' \
    --exclude='./.env' \
    --exclude='./clusters.json' \
    --exclude='./deploiement/releases' \
    --exclude='./releases' \
    --exclude='./.git' \
    --exclude='./.opencode' \
    -czf "$TARBALL" -C "$ROOT" .

# Garde-fou : aucun secret dans le paquet
if tar -tzf "$TARBALL" | grep -Eq '(^|/)(\.env|clusters\.json|data/|logs/)$'; then
  echo "✗ Fichier sensible détecté dans le tarball — paquet abandonné" >&2
  rm -f "$TARBALL"
  exit 1
fi

echo "✓ $TARBALL ($(du -h "$TARBALL" | cut -f1))"
echo
echo "Le kit deploiement/ est maintenant autonome (procédure + scripts + application)."
echo "Déploiement sur le serveur cible (détail dans deploiement/DEPLOY.md) :"
echo "  scp -r $KIT_DIR root@cible:/tmp/"
echo "  cd /tmp/deploiement && sudo tar -xzf releases/prox4u-$STAMP.tar.gz -C /opt/prox4u"
echo "  ./30-env-setup.sh /opt/prox4u proxmox && … (voir DEPLOY.md §5)"
