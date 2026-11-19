---
name: git
description: Infrastructure git de Prox4u — Gitea perso (https://git.prox4u.com/) : repos privés prox4u/prox4u (app) et prox4u_web/prox4u_web (site vitrine www.prox4u.fr), remote origin (token dans l'URL), branche master, auto-backup quotidien (cron 03:00, scripts/backup-gitea.sh = auto-commit + push + tar rétention 7), Gitea MCP (outils gitea.*). À venir : mirror GitHub de prox4u. Use when committing/pushing, configuring remotes, managing the Gitea instance or the GitHub mirror, or diagnosing a backup.
---

# Prox4u — Infrastructure git (Gitea perso + GitHub à venir)

## 1. Instance Gitea (git.prox4u.com)
- **URL** : **https://git.prox4u.com/** (Gitea, IP 37.187.121.211) — ⚠️ le domaine est **`.com`**, pas `.fr` : **git.prox4u.fr n'existe pas** (NXDOMAIN, vérifié 2026-11-19).
- **Comptes** : user `prox4u` (propriétaire du repo app, email info@lunixform.com) + organisation `prox4u_web` (site vitrine).
- **Token** : `57c91531…cec2a` (compte `prox4u`) — présent dans l'URL du remote `origin` (§2) et dans l'env du Gitea MCP (§5). ⚠️ **Valeur sensible** : aujourd'hui seulement dans `.git/config` (non tracké) ; **avant tout mirror public (GitHub), le révoquer/rotater** et s'assurer qu'aucun fichier tracké ne le contient (`git grep 57c91531`).
- **SSH** (alternative HTTPS) : `ssh://git@git.prox4u.com:2222/<owner>/<repo>.git` (port **2222**).

## 2. Repos & remote
| Repo | Contenu | Branche | Visibilité |
|---|---|---|---|
| `prox4u/prox4u` | **L'app** (ce repo) | `master` | privé |
| `prox4u_web/prox4u_web` | Site vitrine www.prox4u.fr (sa skill `website` vit dans **son** repo) | `master` | privé |

- **Remote local** (app) : `origin` = `https://prox4u:<token>@git.prox4u.com/prox4u/prox4u.git` — branche de travail `master` (seule branche).
- **Reclone frais** : `.git/config` ne voyage pas → recréer le remote avec le token : `git remote add origin https://prox4u:57c91531…cec2a@git.prox4u.com/prox4u/prox4u.git`.

## 3. Workflow (commit + push)
- **Commit explicite après chaque tâche** (message `type(scope): description` en FR) + **push `origin master`** — le travail ne doit jamais rester « non commité » localement (règle skill `general` §10).
- **Rien de sensible dans l'historique** : `.env`, `data/`, `node_modules/` sont gitignorés (`.gitignore` racine).
- **Vérifier le push** : `git ls-remote origin master` doit égaler `git rev-parse master` (le Gitea MCP n'a pas d'outil lecture branche/commit).

## 4. Auto-backup quotidien (cron)
- **Cron** (user `opencode`) : `0 3 * * * /home/opencode/projet/prox4u/scripts/backup-gitea.sh >> /home/opencode/backups/prox4u/backup.log 2>&1`
- **Script** `scripts/backup-gitea.sh` (`set -euo pipefail`) :
  1. `git add -A` + auto-commit `backup: auto-commit YYYYMMDD HHMM` (seulement si diff) + `git push origin master` (échec → **WARN non bloquant**).
  2. **tar autonome** du projet (y compris `.git`, en secours du remote) — exclusions : `node_modules` (racine + `packages/*`) et `data/influxdb`.
  3. **Rétention 7 tars** : `/home/opencode/backups/prox4u/backup-prox4u-YYYYMMDD.tar`.
- **Log** : `/home/opencode/backups/prox4u/backup.log` — dernière ligne attendue : `Sauvegarde OK : git=<sha> tar=<taille>`.
- Le tar est une **copie indépendante du git** : elle survit à une panne de Gitea.

## 5. Gitea MCP (outils agent)
- Serveur MCP `gitea` configuré sur cette instance (token via env) — outils `tools.gitea.*` : issues/comments/labels/milestones, PR, wiki, releases, `list_my_repos`, `resolve_repo`, `gitea_status` (état de la connexion).
- Connexion **auto-découverte** depuis `.git/config` (remote `origin`) ; `gitea_status` pour vérifier (configured/baseUrl/owner/repo).
- **Pas d'outil lecture branche/commit** → vérifier l'état distant par `git ls-remote origin master`.

## 6. Pièges
- **`.fr` vs `.com`** : « git perso sur git.prox4u.fr » = git.**prox4u.com** (le .fr ne résout pas) — déjà source de confusion (2026-11-19).
- **Token dans l'URL du remote** : perdu au reclone (§2) ; ne jamais l'écrire dans un fichier tracké sans le signaler ici (§1).
- **Auto-commit 03:00** : le cron committe le working tree tel quel — finir les tâches avec un arbre propre (commit + push), sinon un commit `backup: auto-commit` mélange du travail inachevé dans l'historique.
- **Push en échec du cron** = réseau/Gitea indispo : le tar reste fait (WARN dans le log) — au prochain run, le push rattrape.
- **Restart du serveur ≠ git** : voir skill `operations` (PIDs exacts via `ss -tlnp`).

## 7. GitHub (à venir — mirror prox4u)
**Décision (2026-11-19)** : un git prox4u sur **GitHub** sera à gérer ensuite. Non implémenté — questions à trancher avant mise en place :
- **Visibilité** : public (vitrine du projet) ou privé (simple mirror) ?
- **Direction de synchro** : Gitea → GitHub (mirror unidirectionnel, Gitea reste source de vérité) ou GitHub en primaire ?
- **Compte/org GitHub + token** (PAT fine) — à stocker comme le token Gitea (remote URL ou env, pas dans un fichier tracké).
- **Si public** : révoquer le token Gitea §1 (ou le sortir de cette skill), et passer en revue les valeurs sensibles trackées (IP PVE 192.168.1.80, SMTP OVH du site vitrine, chemins `/home/opencode/…`).
- **Mécanismes possibles** : `git remote add github <url>` + push manuel/cron, mirror natif Gitea (settings du repo), ou GitHub Actions.
- **Quand c'est fait** : mettre à jour ce §7 (URL, token, direction, cron) + inventaire `skills/README.md` §4.2 + skill `general` §10.
