---
name: git
description: Infrastructure git de Prox4u — Gitea perso (https://git.prox4u.com/, source de vérité) : repos privés prox4u/prox4u (app) et prox4u_web/prox4u_web (site vitrine www.prox4u.fr), remote origin (token dans l'URL), branche master, auto-backup quotidien (cron 03:00, scripts/backup-gitea.sh = auto-commit + push + tar rétention 7), Gitea MCP (outils gitea.*) + mirror GitHub PUBLIC github.com/prox4u/prox4u (remote github, synchro unidirectionnelle Gitea→GitHub). Use when committing/pushing, configuring remotes, managing the Gitea instance or the GitHub mirror, or diagnosing a backup.
---

# Prox4u — Infrastructure git (Gitea perso + GitHub à venir)

## 1. Instance Gitea (git.prox4u.com)
- **URL** : **https://git.prox4u.com/** (Gitea, IP 37.187.121.211) — ⚠️ le domaine est **`.com`**, pas `.fr` : **git.prox4u.fr n'existe pas** (NXDOMAIN, vérifié 2026-11-19).
- **Comptes** : user `prox4u` (propriétaire du repo app, email info@lunixform.com) + organisation `prox4u_web` (site vitrine).
- **Token** : `57c91531…cec2a` (compte `prox4u`) — token **complet** dans `.git/config` du serveur (URL du remote `origin`) et dans l'env du Gitea MCP (§5) ; sinon Gitea UI → compte → Settings → Applications. ⚠️ **Rotation recommandée (2026-11-19)** : le token complet a été commité dans `skills/git/SKILL.md` (commit `31d2994`) et cette histoire est **miroitée sur le GitHub public** → il est exposé. Après rotation : mettre à jour `.git/config` (remote origin), l'env du MCP et ce §1 (masqué).
- **SSH** (alternative HTTPS) : `ssh://git@git.prox4u.com:2222/<owner>/<repo>.git` (port **2222**).

## 2. Repos & remote
| Repo | Contenu | Branche | Visibilité |
|---|---|---|---|
| `prox4u/prox4u` | **L'app** (ce repo) | `master` | privé |
| `prox4u_web/prox4u_web` | Site vitrine www.prox4u.fr (sa skill `website` vit dans **son** repo) | `master` | privé |

- **Remotes locaux** (app) :
  - `origin` = `https://prox4u:<token Gitea>@git.prox4u.com/prox4u/prox4u.git` — **source de vérité**
  - `github` = `https://prox4u:<token GitHub>@github.com/prox4u/prox4u.git` — **mirror public** (§7)
  - Branche de travail : `master` (seule branche, des deux côtés).
- **Reclone frais** : `.git/config` ne voyage pas → recréer les remotes avec les tokens (complets dans le `.git/config` du serveur ou les UI Gitea/GitHub) :
  `git remote add origin https://prox4u:<token Gitea>@git.prox4u.com/prox4u/prox4u.git` + `git remote add github https://prox4u:<token GitHub>@github.com/prox4u/prox4u.git`.

## 3. Workflow (commit + push)
- **Commit explicite après chaque tâche** (message `type(scope): description` en FR) + **push `origin master` PUIS `github master`** (mirror, §7) — le travail ne doit jamais rester « non commité » localement (règle skill `general` §10).
- **Rien de sensible dans l'historique** : `.env`, `data/`, `node_modules/` sont gitignorés (`.gitignore` racine). ⚠️ Mais l'historique est **public via GitHub** (§6) — ne committer aucun secret complet (token, mot de passe prod).
- **Vérifier le push** : `git ls-remote origin master` ET `git ls-remote github master` doivent égaler `git rev-parse master` (le Gitea MCP n'a pas d'outil lecture branche/commit).

## 4. Auto-backup quotidien (cron)
- **Cron** (user `opencode`) : `0 3 * * * /home/opencode/projet/prox4u/scripts/backup-gitea.sh >> /home/opencode/backups/prox4u/backup.log 2>&1`
- **Script** `scripts/backup-gitea.sh` (`set -euo pipefail`) :
  1. `git add -A` + auto-commit `backup: auto-commit YYYYMMDD HHMM` (seulement si diff) + `git push origin master` **puis `git push github master`** (mirror, §7 — chaque échec → **WARN non bloquant**).
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
- **Push en échec du cron** = réseau/Gitea indispo : le tar reste fait (WARN dans le log) — au prochain run, le push rattrape (idem pour le mirror GitHub).
- **Restart du serveur ≠ git** : voir skill `operations` (PIDs exacts via `ss -tlnp`).
- **GitHub = PUBLIC** : tout ce qui est commité (y compris l'historique) est visible par tous. Secrets exposés à ce jour : token Gitea complet (commit `31d2994`, §1 → rotater) + mot de passe du compte de test `test-admin` (`STATUS.md` § comptes de test). Avant de committer : `git grep` les secrets ; un secret dans l'historique public ne se retire qu'en **révoquant/rotant** (ou rewrite d'historique, à éviter).

## 7. GitHub — mirror public (en place depuis 2026-11-19)
**Décision** : le git prox4u sur GitHub est un **mirror public** de Gitea.
- **Repo** : **https://github.com/prox4u/prox4u** — **public**, compte `prox4u` (Jérôme ROBERT, plan free), créé 2026-11-16 (vide) ; branche par défaut passée de `main` à **`master`** (API `PATCH /repos/… {default_branch}`) pour être identique à Gitea.
- **Token** : `ghp_aDun…gQlkP` (PAT classique) — token **complet** dans `.git/config` du serveur (URL du remote `github`) ou GitHub UI → Settings → Developer settings → Tokens.
- **Direction** : **Gitea → GitHub, unidirectionnel** — Gitea (`origin`) reste **source de vérité** ; **ne jamais pull/merge depuis GitHub** (le mirror ne doit pas diverger ni remonter).
- **Synchro** : push explicite après chaque tâche (`git push origin master` puis `git push github master`, §3) + **cron quotidien** (`scripts/backup-gitea.sh`, §4) qui rattrape tout oubli.
- **Exposition publique (2026-11-19)** : token Gitea complet dans l'historique (`31d2994`) → **rotation recommandée** (§1) ; mot de passe `test-admin` dans `STATUS.md` ; IPs internes `192.168.x.x` (mineur).
- **Vérifier le mirror** : `git ls-remote github master` = `git rev-parse master` ; côté API : `GET /repos/prox4u/prox4u/commits/master`.
