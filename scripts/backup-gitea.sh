#!/usr/bin/env bash
# Sauvegarde quotidienne du projet prox4u :
#   1. git  : commit auto + push vers Gitea (git.prox4u.com, repo privé prox4u/prox4u)
#   2. tar  : copie indépendante dans /home/opencode/backups/prox4u/
# Exclusions tar : node_modules (réinstallable, racine + packages/* de la workspace pnpm)
# et data/influxdb (ré-écrie par les agents).
# Rétention : les 7 derniers tars.
set -euo pipefail

PROJ="/home/opencode/projet/prox4u"
BACKUP_DIR="/home/opencode/backups/prox4u"
KEEP=7
STAMP="$(date +%Y%m%d)"
TARBALL="$BACKUP_DIR/backup-prox4u-$STAMP.tar"

mkdir -p "$BACKUP_DIR"

# --- Git : auto-commit + push (le .gitignore exclut déjà data/, node_modules/, .env…) ---
cd "$PROJ"
git add -A
if ! git diff --cached --quiet; then
  git commit -m "backup: auto-commit $STAMP $(date +%H%M)"
fi
if ! git push origin master; then
  echo "WARN: git push en échec (réseau ?) — le tar ci-dessous reste fait" >&2
fi

# --- Tar : copie autonome du projet (y compris .git, en secours du remote) ---
tar --exclude='./node_modules' \
    --exclude='*/node_modules' \
    --exclude='./data/influxdb' \
    -cf "$TARBALL" -C "$PROJ" .

# --- Rétention : conserver les KEEP derniers tars ---
ls -1t "$BACKUP_DIR"/backup-prox4u-*.tar 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "Sauvegarde OK : git=$(git rev-parse --short HEAD) tar=$(du -h "$TARBALL" | cut -f1) ($TARBALL)"
