---
name: operations
description: Runbook production de Prox4u — kit de déploiement autonome (deploiement/), pointage INFLUX_URL vers un InfluxDB externe, agent Telegraf sur les nœuds PVE (60-telegraf-nodes.sh, 16 tables, DEPLOY.md §10), systemd/server.sh, logs, dépannage (WS, repli InfluxDB→RRD, TLS SAN, tokens PVE). Use when deploying, updating, or troubleshooting the app in production.
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
| `prox4u.service` | systemd | Unit (`Restart=always`, user `proxmox`) |

Ordre : tokens PVE → tarball → install `/opt/prox4u` + `pnpm install --prod` → 30 → 40 → (50 si besoin) → `clusters.json` + `sites.json` + `overcommit.json` → `./up.sh` → **60 sur chaque nœud PVE** (indépendant, peut être fait après).

- **`sites.json`** (mapping nœuds → bâtiments, requis PRA) : template `sites.example.json` (JSON strict, multi-endpoints/multi-bâtiments) + guide de remplissage champ par champ dans `deploiement/DEPLOY.md` §6. Mapper **tous** les nœuds (sinon « nœuds non mappés » hors PRA) ; PRA seulement si nœuds répartis sur ≥ 2 sites.

## 3. Pointage InfluxDB externe (décision actée)
- `.env` : `INFLUX_URL=https://<influx-prod>:8181`, `INFLUX_TOKEN=<token>`, `INFLUX_CA_CERT=<cert CA>` (auto-signé → chemin du CA).
- `INFLUX_TOKEN` vide → InfluxDB désactivé, **repli RRD Proxmox automatique** (l'app marche, sans historique long terme).
- Bases `raw` (rétention 31 j) et `consolidated` (∞, agrégats 5 min) créées au démarrage ; consolidateur toutes les 5 min (état `data/consolidation-state.json`, backfill par tranches d'un jour après long arrêt).
- Après pointage : la courbe « Disque » (`storage_metrics`) s'accumule depuis le 1er tick — 7 jours pour une vue complète.

## 4. Démarrage + vérification
```bash
cd /opt/prox4u
./up.sh                                # InfluxDB (Docker, dev local) + Explorer + application
curl -k https://localhost:8080/api/health   # → {"status":"ok",...}
tail -n 50 logs/server.log
```
Attendu : `/api/health` 200 · log `InfluxDB prêt : bases raw (31 j) + consolidated (∞)` (ou « repli RRD ») · navigateur → badge **LIVE**, endpoints en sidebar, Health Score calculé · un tick par endpoint sans erreur d'auth PVE.

## 5. Persistance au boot
```bash
./server.sh stop                       # libérer le port 8080
sudo cp deploiement/prox4u.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now prox4u
systemctl status prox4u
```
Conteneurs Docker éventuels : `restart: unless-stopped`.

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
