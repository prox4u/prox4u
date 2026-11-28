---
name: operations
description: Runbook production de Prox4u — kit de déploiement autonome (deploiement/), pointage INFLUX_URL vers un InfluxDB externe, agent Telegraf sur les nœuds PVE (60-telegraf-nodes.sh, 16 tables, DEPLOY.md §10), setup Centreon pour le module Alarmes & Centreon (70-centreon-setup.sh : groupe + compte admin global + token API + mdp NSCA + user de monitoring non-admin (console, ACL + topologie menu), DEPLOY.md §11), systemd/server.sh, logs, dépannage (WS, repli InfluxDB→RRD, TLS SAN, tokens PVE), activation Phase 1 du sharding multi-InfluxDB par endpoint (GitHub #18 : instances par endpoint + reconfig Telegraf par nœud + migration historique). Use when deploying, updating, or troubleshooting the app in production, or activating InfluxDB sharding.
---

# Prox4u — Runbook production

> Procédure complète : `deploiement/DEPLOY.md` (FR) + `deploiement/DEPLOY.en.md` (EN) — ce skill est le condensé de référence et de dépannage.

## 1. Architecture cible
- Serveur applicatif (hors infra Proxmox) : `/opt/prox4u`, app Node.js sur **:8080** (HTTPS si `TLS_CERT` défini), user système `proxmox`.
- N serveurs Proxmox VE : API PVE sur **:8006** (sortant depuis le serveur applicatif). Token lecture seule `manager@pve` (rôle `ManagerReader` — `DA.Read` + `*Audit`, **dont `VM.GuestAgent.Audit`** pour l'occupation disque réelle des VMs QEMU via l'agent invité `get-fsinfo`, un graphe par partition dans le Monitor).
- **InfluxDB = service externe en prod** : l'app pointe dessus via `.env` (`INFLUX_URL`, `INFLUX_TOKEN`, `INFLUX_CA_CERT`). **Ne pas déployer/pousser InfluxDB avec l'app.** Le `docker-compose.yml` à la racine (influxdb + explorer) est du dev local uniquement.
- Réseau : sortant TCP 8006 vers chaque PVE · entrant TCP 8080 depuis les postes utilisateurs.

## 2. Kit de déploiement `deploiement/` (autonome)
On déplace **tout le dossier** sur la cible et on déploie depuis lui :

| Script | Où | Rôle |
|---|---|---|
| `10-proxmox-token.sh` | chaque PVE (root) | Idempotent + auto-test : rôle `ManagerReader`, user `manager@pve`, token. La valeur du token est affichée **une seule fois** (`--dry-run` pour l'aperçu) |
| `20-package-release.sh` | machine de dev | Build + tarball `releases/prox4u-<date>.tar.gz` (source + dist pré-buildé, **aucun secret** — garde-fou intégré) |
| `30-env-setup.sh <dir> <user>` | serveur applicatif | Crée `.env` depuis le template (remplit INFLUX_UID/GID, EXPLORER_SESSION_KEY) |
| `40-tls-init.sh <dir>` | serveur applicatif | Certificats auto-signés (app + InfluxDB) ; `TLS_SAN_EXTRA="IP:<ip>"` pour l'accès distant |
| `50-influxdb-init.sh <dir>` | serveur applicatif | Token admin InfluxDB (met à jour `.env`) — seulement si l'app gère son propre InfluxDB |
| `60-telegraf-nodes.sh` | chaque nœud PVE (root) | Agent Telegraf : 16 tables (SMART, capteurs, ZFS, systemd, I/O, réseau, quorum, reboot, updates) — idempotent, `--dry-run`, self-test. Env : `TELEGRAF_INFLUX_TOKEN` (requis), `INFLUX_URL`/`INFLUX_BUCKET`/`INFLUX_ORG` (défauts labo). Détail : `deploiement/DEPLOY.md` §10 |
| `70-centreon-setup.sh` | central Centreon (root) | Module « Alarmes & Centreon » : groupe `groupeprox4u` + compte `prox4u` (admin global, CLAPI `CONTACT`) + **token API** (SQL `security_token`) + mdp **NSCA** (`nsca.cfg`) + **user monitoring non-admin** (console : CLAPI `CONTACT` `admin=0` + ACL groupe `ALL` + topologie menu `Monitoring` lecture seule + `centAcl.php` — mdp saisi, vide = sauté) — idempotent, `--dry-run`/`--remove`/`--rotate-token`/`--rotate-nsca`, 100 % interactif (crédos admin saisies par l'admin), auto-vérif + récap Page 3. Env : `CENTRON_URL`, `NSCA_PORT`, `NSCA_CFG_PATH`, `MON_USER_LOGIN`/`MON_GROUP`/`MON_TOPO_NAME`. Détail : `deploiement/DEPLOY.md` §11 |
| `prox4u.service` | systemd | Unit système (`Restart=always`, user `proxmox`) — architecture cible |
| `prox4u.user.service` | systemd user | Unit **user** (sans sudo, labo) — même comportement, scope utilisateur, exécute le build depuis le repo |

Ordre : tokens PVE → tarball → install `/opt/prox4u` + `pnpm install --prod` → 30 → 40 → (50 si besoin) → `clusters.json` + `sites.json` + `overcommit.json` → `./up.sh` → **60 sur chaque nœud PVE** (indépendant, peut être fait après) → **70 sur le central Centreon** (seulement si le module Alarmes & Centreon est utilisé, indépendant).

- **`sites.json`** (mapping nœuds → bâtiments, requis PRA) : template `sites.example.json` (JSON strict, multi-endpoints/multi-bâtiments) + guide de remplissage champ par champ dans `deploiement/DEPLOY.md` §6. Mapper **tous** les nœuds (sinon « nœuds non mappés » hors PRA) ; PRA seulement si nœuds répartis sur ≥ 2 sites.

## 3. Pointage InfluxDB externe (décision actée)
- `.env` : `INFLUX_URL=https://<influx-prod>:8181`, `INFLUX_TOKEN=<token>`, `INFLUX_CA_CERT=<cert CA>` (auto-signé → chemin du CA).
- `INFLUX_TOKEN` vide → InfluxDB désactivé, **repli RRD Proxmox automatique** (l'app marche, sans historique long terme).
- Bases `raw` (rétention 31 j) et `consolidated` (∞, agrégats 5 min) créées au démarrage ; consolidateur toutes les 5 min (état `data/consolidation-state.json`, backfill par tranches d'un jour après long arrêt).
- Après pointage : la courbe « Disque » (`storage_metrics`) s'accumule depuis le 1er tick — 7 jours pour une vue complète.

### 3bis. Sharding multi-InfluxDB par endpoint (GitHub #18) — activation Phase 1
Le code de la **Phase 0 est dormant** : sans shard configuré, tout reste sur l'instance globale (`INFLUX_URL`). L'activation est une **étape de déploiement** (pas un simple clic) :
1. **Déployer une instance InfluxDB par endpoint** (ou un sous-ensemble) — mêmes exigences que l'instance globale (`--query-file-limit=10000`, TLS, token).
2. **Configurer les shards** via l'UI admin (onglet **Shards InfluxDB**) ou `data/influx-shards.json` : `{ endpointId, url, token?, rawDb?, aggDb?, rrdDb?, caCert? }` (vide = hérité du global). Le routeur se recharge **à chaud** (sans restart).
3. **Reconfigurer Telegraf sur chaque nœud PVE** pour qu'il écrive dans le shard de son endpoint : `60-telegraf-nodes.sh` avec `INFLUX_URL`/`TELEGRAF_INFLUX_TOKEN` pointant vers le shard (les tables Telegraf n'ont **pas de tag endpoint** — le routage passe par la destination, pas par un tag).
4. **Décision migration historique** : les données pré-sharding restent dans le global ; les lectures sont en fan-out (global + shards) donc **complètes** tant que le global conserve ses données.

> Les **écritures** du poller (métriques API PVE, tag `cluster`) sont routées automatiquement par endpoint dès qu'un shard est configuré ; les **lectures** sont toujours en fan-out. Consolidator/archiver tournent per-client (shards → sous-dossier `/<endpointId>/`). Détail : skill `general` §4.5bis + `docs/plan-limites-influxdb3.md` § Hors périmètre.

## 4. Démarrage + vérification
```bash
cd /opt/prox4u
./up.sh                                # InfluxDB (Docker, dev local) + Explorer + application
curl -k https://localhost:8080/api/health   # → {"status":"ok",...}
tail -n 50 logs/server.log
```
Attendu : `/api/health` 200 · log `InfluxDB prêt : bases raw (31 j) + consolidated (∞)` (ou « repli RRD ») · navigateur → badge **LIVE**, endpoints en sidebar, Health Score calculé · un tick par endpoint sans erreur d'auth PVE.

## 5. Persistance au boot (service systemd SYSTÈME)
```bash
pnpm --filter @prox4u/server build     # le service exécute dist, pas la source
sudo ./deploiement/install-service.sh  # en root : libère le port 8080, copie l'unit, enable + start
systemctl status prox4u
```
- L'unit `deploiement/prox4u.service` : `User=opencode`, `WorkingDirectory=/home/opencode/projet/prox4u`, `ExecStart=/usr/local/bin/node packages/server/dist/index.js`, `Restart=always`, `WantedBy=multi-user.target` → **boot sans login** + redémarrage auto.
- Le script `install-service.sh` (idempotent) arrête d'abord le service user `prox4u` (variante §5.1) + le dev tsx pour libérer le port 8080.
- **Après tout changement serveur** : `pnpm --filter @prox4u/server build && sudo systemctl restart prox4u` · logs `journalctl -u prox4u -f`.
Conteneurs Docker éventuels : `restart: unless-stopped`.

### 5.1 Variante sans sudo — service systemd USER (alternative)
Pour les environnements **sans sudo** : unit user `deploiement/prox4u.user.service` → `~/.config/systemd/user/prox4u.service` (exécute le build depuis le repo, `Restart=always`, `WantedBy=default.target`).
- Installation : `mkdir -p ~/.config/systemd/user && cp deploiement/prox4u.user.service ~/.config/systemd/user/prox4u.service && systemctl --user daemon-reload && systemctl --user enable --now prox4u`.
- Gestion : `systemctl --user {status|stop|restart} prox4u` · logs `journalctl --user -u prox4u -f`.
- **Limite** : démarre au **login** de l'user, pas au boot froid — `sudo loginctl enable-linger $USER` (1×) pour le boot sans session.
- Le script `install-service.sh` (service système, §5) **désactive et arrête** ce service user automatiquement (conflit port 8080).

**Historique labo (2026-11-28)** : le labo tournait sous **cron** (`* * * * * server.sh start` + `@reboot`) qui relançait le dev tsx — retiré au profit du service (les deux mécanismes se battaient sur le port 8080). Le service user a été un passage intermédiaire avant le service système.

**Piège `server.sh`** : `server.sh status` ne voit que l'instance **dev** (grep `index.ts` dans le cmdline) — « non en cours » ne veut pas dire que le service est arrêté. Dev (hot-reload) : `systemctl stop prox4u && npm run dev`, puis `systemctl start prox4u` pour revenir au service.

## 6. Opérations courantes (day-2)
| Opération | Commandes |
|---|---|
| **Mise à jour** | `20-package-release.sh` (dev) → scp tarball → `tar -xzf … -C /opt/prox4u` → `pnpm install --prod` → chown `proxmox:proxmox` → `systemctl restart prox4u` |
| **Rotation token PVE** | sur le PVE : `pveum user token del manager@pve manager && pveum user token add manager@pve manager --privsep 0` → mettre à jour `clusters.json` → restart |
| **Supprimer un endpoint** | retirer le bloc de `clusters.json` (+ son site dans `sites.json`) → restart |
| **Logs** | `logs/server.log` (app) · `docker compose logs influxdb` |
| **Sauvegarde** | `data/` + `.env` + `clusters.json` + `sites.json` (tout l'état y est) |

## 7. Dépannage
- **WS qui ne met pas à jour** (`/ws`) : le serveur pousse un snapshot toutes les 5 s ; vérifier les erreurs poller dans `logs/server.log`. Le web se reconnecte en backoff exponentiel (1 s → 30 s) et retombe sur `/api/dashboard` si le WS échoue.
- **InfluxDB indisponible** : chaque endpoint lourd logge `… InfluxDB indisponible → repli RRD` et répond `source: "rrd"`. Vérifier `INFLUX_URL`/token/CA. L'app ne plante jamais dessus.
- **Certificat refusé par le navigateur** : SAN manquant → régénérer avec `TLS_SAN_EXTRA="IP:<ip>" ./40-tls-init.sh` (les utilisateurs arrivent via l'IP/hostname, pas `localhost`).
- **Erreur d'auth PVE à chaque tick** : token révoqué/expiré → rotation (§6) ; re-tester avec l'auto-test de `10-proxmox-token.sh`.
- **Courbe disque vide / null** : `storage_metrics` sans série encore (s'accumule depuis le 1er tick) ; bucket sans série → `null` (gap ECharts), ce n'est pas une erreur.
- **Graphe « Occupation disque » vide (VMs QEMU)** : l'agent invité ne répond pas (VM arrêtée, `qemu-guest-agent` non installé, ou PVE sans l'endpoint). C'est attendu — le graphe « démarre plus tard », pas d'erreur. Vérifier `agent/get-fsinfo` à la main avec le token.
- **Inventaire vide (0 VM) alors que les VMs sont up** : le token a perdu `VM.Audit` → `/cluster/resources` ne liste plus les VMs. Cause typique : `pveum acl modify /vms --user <u> --role <R>` avec un `<R>` sans `VM.Audit` **remplace** le rôle de lecture. Correction : `pveum role modify <R> --privs "VM.Audit,VM.GuestAgent.Audit,VM.GuestAgent.Unrestricted"` (ou `pveum acl add`, qui ajoute sans remplacer).
- **Contrainte PVE 9.1.1** : les endpoints REST agent `agent/fs-info` (« not implemented ») et `agent/exec` (HTTP 596 « Broken pipe ») sont cassés sur cette build — seul **`agent/get-fsinfo`** fonctionne (c'est celui que l'app utilise). Sur une version où `agent/exec` marche, rien ne change côté app.
- **Tuer un processus** : tuer par PID extrait de `ss -tlnp` — un pattern `pkill -f node` matche sa propre ligne.
- **« Compte verrouillé — contactez un administrateur » au login** : l'utilisateur est verrouillé (`active: false` — bouton cadenas *Administration → Utilisateurs*) ; un admin le déverrouille. Les sessions d'un user verrouillé sont invalidées immédiatement (401 au prochain appel).
- **« Trop de tentatives échouées » (429) au login** : throttle anti-brute-force — 5 échecs / 15 min par identifiant. Le compteur est **en mémoire** du processus : un `systemctl restart prox4u` (dev : relancer le serveur) lève le blocage immédiatement, sans attendre la fenêtre de 15 min.

## 8. Variables d'environnement clés (`.env`, gitignoré)
`PVE_URL/PVE_USER/PVE_TOKEN_ID/PVE_TOKEN_VALUE` (1 endpoint si `clusters.json` absent) · `TLS_REJECT_UNAUTHORIZED=false` · `MOCK=0|1` (+ `MOCK_SCENARIO`) · `PORT=8080` · `INFLUX_URL/TOKEN/RAW_DB/AGG_DB/UID/GID` · `TLS_KEY/TLS_CERT/INFLUX_CA_CERT` · `EXPLORER_SESSION_KEY`.
