# Déploiement sur un nouveau serveur

Procédure bout-en-bout pour déployer l'application sur un serveur dédié, **hors infrastructure Proxmox**, sans git (transfert du kit `deploiement/` — l'application voyage dans son tarball) et sans interface graphique (comptes et tokens créés par commandes).

> English version: [DEPLOY.en.md](./DEPLOY.en.md)

> **Ce dossier `deploiement/` est le livrable de déploiement — tout y est, autonome. On déplace le dossier entier sur la cible et on déploie depuis lui** :
> - `DEPLOY.md` — cette procédure ;
> - `10-proxmox-token.sh` — à exécuter **sur chaque serveur Proxmox** (§2) ;
> - `20-package-release.sh` — à exécuter **sur la machine de dev** pour produire le tarball dans `releases/` (§3) ;
> - `releases/prox4u-<date>.tar.gz` — **l'application elle-même** (produite par 20) ;
> - `30-env-setup.sh`, `40-tls-init.sh`, `50-influxdb-init.sh` — installation **sur le serveur applicatif**, numérotés dans l'ordre d'exécution, prennent le dossier d'installation en argument (§5) ;
> - `prox4u.service` — unit systemd du serveur applicatif (§8).

```
Serveur cible (app)                Serveurs Proxmox VE × N
┌─────────────────────────┐        ┌──────────────────┐
│ /opt/prox4u    │  API   │ pveum (token     │
│  app Node.js :8080      │◄──────►│ lecture seule)   │
│  InfluxDB Docker :8181  │  8006  └──────────────────┘
│  Explorer Docker :8888  │
└─────────────────────────┘
```

**Réseau** : sortant TCP **8006** depuis le serveur de l'app vers chaque Proxmox (API PVE ; 8007 pour PBS plus tard) · entrant TCP **8080** depuis les postes des utilisateurs.

---

## 1. Prérequis du serveur cible

| Prérequis | Version | Installation |
|---|---|---|
| Node.js | ≥ 20 | paquet système recommandé (Nodesource) → `/usr/bin/node` |
| pnpm | ≥ 9 | `npm install -g pnpm` |
| Docker + plugin compose | récent | `docker compose version` doit répondre |

## 2. Tokens Proxmox — par cluster, sans GUI

Sur **chaque** serveur Proxmox, en root. Le script est idempotent et s'auto-teste :

```bash
# depuis la machine de développement (le script est dans le kit) :
scp deploiement/10-proxmox-token.sh root@<pve>:/tmp/
ssh root@<pve> /tmp/10-proxmox-token.sh
```

Le script crée, par commandes `pveum` (aucune GUI) :

1. le rôle **`ManagerReader`** — 100 % lecture seule, calibré sur les endpoints de l'app (`DA.Read` + permissions `*Audit`, **dont `VM.GuestAgent.Audit`** pour l'occupation disque réelle des VMs QEMU — voir encadré ci-dessous) ;
2. l'utilisateur dédié **`manager@pve`** (indépendant de LDAP/AD, révocable seul) ;
3. le **token API** `manager` + droits sur tout le datacenter ;
4. un **auto-test** (`GET /cluster/resources` + `/nodes/<n>/status`) qui confirme que les droits suffisent.

> **Accorder le rôle à un user de monitoring existant** (ex. `supervision@pam`, déjà utilisé dans `.env`/`clusters.json`) : le rôle accordé **doit inclure `VM.Audit`** (liste des VMs) **et** `VM.GuestAgent.Audit` (occupation disque par partition). Le rôle du kit `ManagerReader` l'inclut déjà ; pour l'accorder à un user existant :
>
> ```bash
> # accord du rôle sur tout le datacenter (le « / » propage à /vms, /nodes, …)
> pveum acl modify / --user supervision@pam --roles ManagerReader
> ```
>
> Si tu utilises **ton propre rôle** (pas `ManagerReader`), vérifie qu'il a les deux privilèges — sinon l'inventaire se vide ou le disque QEMU ne se remplit pas :
>
> ```bash
> pveum role modify <TonRole> --privs "DA.Read,DA.Audit,VM.Audit,VM.GuestAgent.Audit,Sys.Audit,SDA.Audit,SDI.Audit,SN.Audit"
> pveum acl modify / --user supervision@pam --roles <TonRole>
> ```

La valeur du token est affichée **une seule fois** — noter les trois champs :

```
"user"       : "manager@pve"
"tokenId"    : "manager"
"tokenValue" : "<valeur>"
```

Variables optionnelles du script : `PVE_APP_USER` (défaut `manager@pve`), `PVE_TOKEN_ID` (défaut `manager`), `PVE_COMMENT`. Mode d'aperçu : `./deploiement/10-proxmox-token.sh --dry-run`.

> ### Occupation disque réelle des VMs QEMU — agent invité
>
> Le RRD Proxmox `disk` ne mesure l'usage disque **que des conteneurs LXC** ; pour les **VMs QEMU il vaut 0** (PVE n'agrège l'usage disque QEMU qu'au niveau du datastore, jamais par VM). L'app lit donc l'occupation disque réelle des QEMU via l'**agent invité** (`qemu-guest-agent`) :
>
> - **Endpoint** : `GET /nodes/{n}/qemu/{vmid}/agent/get-fsinfo` — renvoie **un filesystem par partition** (point de montage + périphérique + `used-bytes`/`total-bytes`). Seuls les fs rattachés à un disque VM (champ `disk` non vide) sont retenus. Les vrais montages réseau (NFS/CIFS) n'ont pas de champ `disk` → automatiquement exclus.
> - **Graphe par partition** : l'onglet Monitor affiche **un graphe par filesystem** (ex. `/` sur `sda1`, `/NFS` sur `sda6`) — espace utilisé + taille du fs (allocation de la partition), avec légende. Les données sont stockées dans la mesure InfluxDB `vm_fs` (une série par point de montage) + un agrégat total dans `vm_metrics` (`disk_bytes`/`disk_alloc_bytes`).
> - **Privilège requis** : `VM.GuestAgent.Audit` **uniquement** (lecture agent). **Pas besoin** de `VM.GuestAgent.Unrestricted` (c'est le privilège d'exécution de commandes dans le guest, inutilisé ici). Le rôle `ManagerReader` du kit l'inclut déjà.
> - **Fréquence** : l'agent est interrogé **au plus toutes les 5 min** par VM (throttle côté poller) — l'usage disque change lentement, inutile de le relancer à chaque tick de 5 s.
> - **LXC** : pas d'agent — un seul filesystem rootfs, usage venu du champ `disk` (utilisé) / `maxdisk` (alloué) de `/cluster/resources`, déjà réel.
> - **Si l'agent est absent / VM arrêtée / PVE sans l'endpoint** : le champ est simplement omis (le graphe « démarre plus tard », comme l'I/O) — aucune erreur.
>
> **⚠️ Contrainte PVE 9.1.1** : sur cette build, les endpoints REST agent `agent/fs-info` (« not implemented ») et `agent/exec` (HTTP 596 « Broken pipe ») sont **cassés** — seul **`agent/get-fsinfo`** fonctionne. C'est pour cela que l'app utilise `get-fsinfo` (et non `fs-info`/`exec`). Sur les versions où `agent/exec` fonctionne, rien ne change côté app.
>
> **⚠️ Piège `pveum acl modify`** : `pveum acl modify <path> --user <u> --role <R>` **REMPLACE** le rôle de l'utilisateur sur ce path. Lancer `pveum acl modify /vms --user manager@pve --role <R>` avec un `<R>` qui n'inclut **pas** `VM.Audit` **supprime** le droit de liste des VMs → `/cluster/resources` ne renvoie plus aucune VM → **inventaire vide**. Pour ajouter un droit agent sans casser la lecture : soit le rôle inclut déjà `VM.Audit` (cas du `ManagerReader` du kit), soit utiliser l'ACL additive `pveum acl add <path> --user <u> --role <R>` (qui **ajoute** un path/rôle sans remplacer).

## 3. Transfert du kit

Le dossier `deploiement/` est **autonome** (procédure + scripts + tarball de l'application + unit systemd) : on déplace **tout le dossier**, rien d'autre.

```bash
# machine de développement :
./deploiement/20-package-release.sh    # build + deploiement/releases/prox4u-<date>.tar.gz

# on déplace le kit entier sur la cible :
scp -r deploiement root@<cible>:/tmp/
```

Le tarball (dans `deploiement/releases/`) contient source + `dist/` pré-buildé ; il n'a aucun secret (`.env`, `clusters.json`, `data/`, `logs/` sont hors paquet — garde-fou intégré au script).

## 4. Installation de l'application

```bash
# serveur cible, depuis le kit :
cd /tmp/deploiement
sudo useradd -r -s /usr/sbin/nologin proxmox
sudo mkdir -p /opt/prox4u
sudo tar -xzf releases/prox4u-*.tar.gz -C /opt/prox4u
cd /opt/prox4u
pnpm install --prod                  # dépendances runtime uniquement (dist est pré-buildé)
sudo chown -R proxmox:proxmox /opt/prox4u
```

Un utilisateur unique porte l'app **et** les données : le conteneur InfluxDB tournera avec le même uid/gid (§5), ce qui évite tout conflit de permissions sur `data/`.

## 5. Configuration locale

Les scripts sont **numérotés dans l'ordre d'exécution** — les lancer un par un, **depuis le kit**, avec le dossier d'installation en argument :

```bash
cd /tmp/deploiement

# .env : créé depuis le template, INFLUX_UID/GID (uid/gid de l'user proxmox)
# et EXPLORER_SESSION_KEY sont remplis automatiquement :
./30-env-setup.sh /opt/prox4u proxmox

# certificats auto-signés (app + InfluxDB) — ajouter le SAN si accès distant :
TLS_SAN_EXTRA="IP:<ip-du-serveur-app>" ./40-tls-init.sh /opt/prox4u

# token admin InfluxDB (met à jour .env automatiquement) :
./50-influxdb-init.sh /opt/prox4u

# ownership des données pour le conteneur non-root :
sudo chown -R proxmox:proxmox /opt/prox4u/data
```

> L'argument dossier est optionnel : depuis l'arborescence installée (`/opt/prox4u/deploiement/…`), les scripts opèrent sur leur dossier parent par défaut.

Seule vérification manuelle restante dans `.env` : confirmer `TLS_KEY` / `TLS_CERT` / `INFLUX_CA_CERT` / `INFLUX_URL` (déjà pré-remplis avec les bonnes valeurs).

> Le SAN est important : les navigateurs des utilisateurs accèdent à l'app via l'IP/hostname du serveur (pas `localhost`) — sans SAN correspondant, le navigateur refuse le certificat.

**InfluxDB : deux bases, créées et consolidées automatiquement** — `raw` (toutes les métriques brutes, rétention 31 j) et `consolidated` (métriques consolidées 5 min, rétention **infinie**, pour l'historique long terme). Les deux sont créées au démarrage de l'app ; le consolidateur tourne toutes les 5 min (reprise après arrêt via `data/consolidation-state.json`, backfill par tranches d'un jour après un long arrêt) ; la lecture bascule automatiquement sur `consolidated` pour les longues périodes. Repli RRD Proxmox si InfluxDB est indisponible.

### InfluxDB 3 Core — limites et gestion (cible 500 VMs 24/7)

InfluxDB 3 Core a des limites dures (5 bases / 2000 tables / 500 colonnes — sans impact ici)
et des limites de **temps** qui comptent : `--query-file-limit` (défaut 432 fichiers = 72 h ;
1 fichier Parquet / table / bloc de 10 min), **pas de compaction**, **pas de DELETE**,
rétention **immuable**. L'app gère ces manques sans dépendance (détail :
`docs/plan-limites-influxdb3.md`) :

- **Backpressure d'écriture** : file dimensionnée (`INFLUX_QUEUE_MAX`, défaut 20 000) +
  lots plus gros (`INFLUX_FLUSH_MAX_LINES`, défaut 1 000) + dead-letter après
  `INFLUX_FLUSH_MAX_RETRIES` (défaut 3) échecs consécutifs. Compteurs d'abandon exposés
  dans `/api/health` (section `influx`) + alertes.
- **Requêtes long terme chunkées** : les fenêtres > ~69 j sont découpées en tranches de
  `INFLUX_QUERY_CHUNK_DAYS` (défaut 30 j = 4 320 fichiers < `INFLUX_QUERY_FILE_LIMIT`) —
  la vue « 1 an » des historiques capteurs/SMART fonctionne.
- **Auto-monitoring** : `GET /api/influxdb` (état, compteurs d'écriture, stats lecture,
  headroom fichiers) + self-telemetry `influxdb_self` (1 ligne/tick) + alertes
  `influxdb-down` / `influxdb-write-drops` / `influxdb-file-limit`.
- **Archivage** : un archiver exporte `consolidated` au-delà de `INFLUX_ARCHIVE_AGE_DAYS`
  (défaut 90 j) vers des CSV (1 fichier / table / jour) dans `INFLUX_ARCHIVE_DIR`
  (défaut `data/influx-archive/`), toutes les `INFLUX_ARCHIVE_INTERVAL_HOURS` (défaut 6 h),
  avec reprise d'état (`data/archive-state.json`).
- **Module « InfluxDB » (vision + action)** : page `/influxdb` (KPIs, graphiques 24 h/7 j/30 j,
  bases, archivage) + widget de la vue d'ensemble. Les **actions** (flush, archivage,
  recréation/suppression de bases et tables — `POST /api/influxdb/actions/*`) sont réservées
  au rôle admin **ou** aux membres des groupes `INFLUX_ACTION_GROUPS` (défaut
  `Administrateurs,Exploitations`, noms séparés par `,` ; vide = admin seul). Chaque action
  est tracée dans l'audit admin (`influxdb.action`). Détail : `docs/plan-module-influxdb.md`.

**Stratégie de rétention** :

| Niveau | Rétention | Mécanisme |
|---|---|---|
| `raw` | 31 j | purge native InfluxDB (rétention immuable à la création) |
| `consolidated` | ∞ (surveillée) | buckets 5/15 min ; headroom fichiers suivi via `/api/influxdb` |
| `data/influx-archive/` | au-delà de 90 j | export CSV interrogeable hors InfluxDB (DuckDB/Excel) |

> Si la croissance de `consolidated` (∞) devient critique : la recréer à rétention finie
> (ex. 2 ans) — bouton « Recréer une base » du module InfluxDB (réservé aux groupes
> `INFLUX_ACTION_GROUPS`) — et s'appuyer sur l'archive CSV pour l'au-delà.

## 6. Endpoints surveillés

```bash
cd /opt/prox4u
cp clusters.example.json clusters.json    # remplir un bloc par cluster (§2)
chmod 600 clusters.json
```

- **`sites.json`** (déjà dans le paquet, modèle `sites.example.json`) : mapping nœuds → bâtiments, **requis pour le PRA** (bascule N-1 + PRA global cross-endpoints). Chaque site (bâtiment) se rattache à un endpoint via le champ `endpoint`.

  | Champ | Type | Rôle |
  |---|---|---|
  | `id` | string | Identifiant stable (slug) du site — utilisé dans les URLs, le tag InfluxDB et l'id de site du PRA. |
  | `name` | string | Nom d'affichage (le bâtiment). |
  | `endpoint` | string | Id de l'endpoint rattaché (cf. `clusters.json`). **Omis = par défaut** (le site s'applique à tous les endpoints). |
  | `nodes` | string[] | Noms des nœuds PVE appartenant à ce bâtiment (tels que dans Proxmox). |

  **Exemple** (`sites.example.json`) :
  ```json
  {
    "sites": [
      { "id": "batiment-a", "name": "Bâtiment A — datacenter", "endpoint": "cluster-prod", "nodes": ["pve-node1", "pve-node2"] },
      { "id": "batiment-b", "name": "Bâtiment B — annexe", "endpoint": "cluster-prod", "nodes": ["pve-node3"] },
      { "id": "site-agence", "name": "Site agence", "endpoint": "cluster-agence", "nodes": ["pve-agence1"] }
    ]
  }
  ```

  **Règles** :
  - **Mapper tous les nœuds** vers un bâtiment : un nœud non mappé apparaît dans l'encart « nœuds non mappés » de l'UI et n'est **pas couvert par le PRA**.
  - Le **PRA ne se calcule que si les nœuds sont répartis sur ≥ 2 sites** (cluster mono-nœud, ou tous les nœuds sur le même site → `na`).
  - Le **PRA global** (cross-endpoints) réutilise ce même mapping : si un bâtiment tombe, les autres bâtiments de **tous** les endpoints peuvent absorber (prérequis : stockage identique d'un site à l'autre — le disque est exclu du calcul).
  - Après modification de `sites.json` → **restart** de l'application.

- **`overcommit.json`** (déjà dans le paquet) : seuils de surallocation + code couleur d'usage ; défauts sains fournis, ajustable à chaud (hot-reload, pas de restart).

- **`health.json`** (déjà dans le paquet, modèle `health.example.json`) : **seuils + pénalités du Health Score et du PRA** ; défauts sains fournis, **ajustable à chaud (hot-reload, pas de restart)**. Fichier optionnel — absent → défauts intégrés.

  | Bloc | Champs | Rôle |
  |---|---|---|
  | `thresholds` | `warn`, `crit` | Usage CPU/RAM cluster : ≥ `warn` → pénalité warn, > `crit` → pénalité crit (%). |
  | | `praWarn`, `praCrit` | Absorption PRA : ≥ `praWarn` → warn, > `praCrit` → crit (%). |
  | | `healthNominal`, `healthDegraded` | Libellé du score : ≥ nominal → Nominal, ≥ degraded → Dégradé, sinon Critique. |
  | `penalties` | `nodeDown`, `quorumLost`, `qdeviceDown`, `cpuCrit`/`cpuWarn`, `ramCrit`/`ramWarn`, `diskCrit`/`diskWarn`, `praCrit`/`praWarn` | Points retirés à 100 pour chaque motif de pénalité. |

  **Règles** : `crit ≥ warn`, `praCrit ≥ praWarn`, `healthNominal ≥ healthDegraded` (validé au chargement). Après modification → **appliqué au tick suivant, sans restart**.

- **`audit.json`** (déjà dans le paquet, modèle `audit.example.json`) : **checks du score de configuration** (module Audit / best-practices) ; défauts sains fournis, **ajustable à chaud (hot-reload, pas de restart)**. Fichier optionnel — absent → défauts intégrés.

  | Bloc | Champs | Rôle |
  |---|---|---|
  | `penalties` | `crit`, `warn`, `info` | Points retirés à 100 par constat de chaque sévérité. |
  | `labelNominal`, `labelDegraded` | — | Libellé du score : ≥ nominal → Conforme, ≥ degraded → À améliorer, sinon À revoir. |
  | `checks` | un bloc par check (`enabled` + seuils) | Activer/désactiver chaque check + ajuster ses seuils (ex. `stuck_snapshots.maxAgeDays`, `disk_service_life.warnPct`/`critPct`, `zfs_arc_max.maxPctOfRam`). |

  **Règles** : chaque check peut être désactivé (`"enabled": false`) ; les seuils n'ont d'effet que si le check est activé. Après modification → **appliqué au tick suivant, sans restart**. Le catalogue complet des checks (pourquoi / comment / seuils) est dans le skill `audit`.

## 7. Démarrage + vérification

```bash
cd /opt/prox4u
./up.sh                                # InfluxDB (Docker) + Explorer + application
curl -k https://localhost:8080/api/health
docker compose ps                      # influxdb → "healthy"
tail -n 50 logs/server.log
```

Vérifications attendues :

- `/api/health` → `200` ;
- `docker compose ps` → conteneur InfluxDB **healthy** ;
- `logs/server.log` → ligne `InfluxDB prêt : bases raw (31 j) + consolidated (∞)` (ou « repli RRD » si InfluxDB désactivé) ;
- navigateur sur `https://<ip-du-serveur>:8080` (certificat auto-signé : accepter l'exception) → badge **LIVE**, endpoints listés dans la sidebar, Health Score calculé ;
- `logs/server.log` : un tick par endpoint sans erreur d'authentification PVE.

> Le port API InfluxDB 8181 est lié **localhost + `INFLUX_LAN_BIND`** (l'app se connecte en local via 127.0.0.1). `INFLUX_LAN_BIND` est auto-rempli par `30-env-setup.sh` avec l'IP du serveur : cela expose l'API au réseau interne **uniquement pour les agents Telegraf des nœuds Proxmox** (écriture des métriques locales : SMART, températures, ZFS…). Mettre `INFLUX_LAN_BIND=` à vide pour revenir à localhost-only. Explorer (8888) reste accessible.

## 8. Persistance au boot

```bash
cd /opt/prox4u

# arrêter l'instance manuelle (le port 8080 sera pris par systemd) :
./server.sh stop

# l'unit est dans le kit (copie installée dans l'arborescence, durable après reboot) :
sudo cp deploiement/prox4u.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now prox4u
systemctl status prox4u
```

InfluxDB et Explorer sont des conteneurs Docker avec `restart: unless-stopped` → ils démarrent avec le service Docker au boot. L'unit systemd redémarre l'app en cas de crash (`Restart=always`) et au boot.

## 9. Opérations courantes

| Opération | Commandes |
|---|---|
| **Mise à jour** | `./deploiement/20-package-release.sh` (dev) → `scp deploiement/releases/prox4u-*.tar.gz cible:/tmp/` → `sudo tar -xzf /tmp/prox4u-*.tar.gz -C /opt/prox4u` → `pnpm install --prod` → `sudo chown -R proxmox:proxmox /opt/prox4u` → `sudo systemctl restart prox4u` |
| **Rotation d'un token PVE** | sur le PVE : `pveum user token del manager@pve manager && pveum user token add manager@pve manager --privsep 0` → mettre à jour `clusters.json` → `sudo systemctl restart prox4u` |
| **Supprimer un endpoint** | retirer le bloc de `clusters.json` (+ son site dans `sites.json`) → restart |
| **Logs** | `logs/server.log` (app) · `docker compose logs influxdb` |
| **Sauvegarde** | tout l'état est dans `data/` (InfluxDB, état du consolidateur, **archive CSV `data/influx-archive/`**, certificats TLS, token admin) — copier `data/` + `.env` + `clusters.json` + `sites.json` |

> **PBS (phase 1B)** : le token Proxmox Backup Server se créera de la même façon par commandes (`pbs config add-user` + token via API) — procédure à compléter quand PBS sera déployé.

## 10. Agent des nœuds (Telegraf)

Optionnel mais recommandé : l'API PVE n'expose pas les **métriques locales** (SMART disques,
températures, ZFS ARC, unités systemd, I/O hôte, réseau par NIC, détail du quorum cluster,
reboot en attente, mises à jour de sécurité en attente). L'agent **Telegraf** les collecte sur
chaque nœud PVE et les pousse dans l'InfluxDB (base `raw`).

> Sans l'agent, l'application fonctionne en **mode dégradé** : pas de SMART/températures, pas
> d'I/O par disque ni de trafic par interface de VM, et les 5 checks d'audit fondés sur l'agent
> (`disk_errors`, `disk_service_life`, `failed_units`, `pending_reboot`, `security_updates`)
> restent silencieux.

### 10.1 Exécution

Sur **chaque nœud PVE** (bare-metal — pas dans une VM/CT), en **root**, avec le script du kit :

```bash
export TELEGRAF_INFLUX_TOKEN="<token admin InfluxDB>"   # = INFLUX_TOKEN du .env de l'app
bash 60-telegraf-nodes.sh            # ou --dry-run pour l'aperçu (rien n'est exécuté)
```

Le script est **idempotent et relançable** (redéploiement) : le `telegraf.conf` existant est
sauvegardé (`.bak.<ts>`), les scripts exec sont écrasés, Telegraf est (re)démarré. Si Telegraf
est déjà installé, il ne retélécharge **pas** la clé GPG InfluxData et ne relance pas `apt`
(le réseau LAN→internet peut être instable).

### 10.2 Variables d'environnement

| Variable | Requête | Défaut | Note |
|---|---|---|---|
| `TELEGRAF_INFLUX_TOKEN` | **oui** | — | token API InfluxDB (= `INFLUX_TOKEN` du `.env` de l'app). **Différent en prod** → passer le token de prod |
| `INFLUX_URL` | non | `https://192.168.1.180:8181` | adresse de l'InfluxDB — **à passer en prod** si différente (défaut = labo) |
| `INFLUX_BUCKET` | non | `raw` | base cible |
| `INFLUX_ORG` | non | `influxdb` | organisation (plugin `influxdb_v2`) |
| `PING_TARGET` | non | = host:port de `INFLUX_URL` | cible du ping (plugin actuellement désactivé — pas de `CAP_NET_RAW`) |
| `NODE_TAG` | non | `hostname` | tag `node` écrit dans InfluxDB — **doit correspondre au nom du nœud dans PVE** (sinon les données ne sont pas consommées par l'app) |

> La clé GPG InfluxData (empreinte `24C9…F927`) est la clé de signature **officielle du
> fournisseur** — identique dans tous les environnements, et plus téléchargée au redéploiement.

### 10.3 Vérification

Le script se **self-teste** en fin d'exécution (service actif + écriture InfluxDB confirmée).
Puis, depuis le serveur prox4u, confirmer que les tables sont alimentées :

```bash
cd prox4u && TOK=$(grep '^INFLUX_TOKEN=' .env | cut -d= -f2)
curl -sk https://localhost:8181/api/v3/query_sql -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d '{"db":"raw","q":"SELECT table_name FROM information_schema.tables WHERE table_name IN ('\''smart_device'\'','\''sensors'\'','\''zfs'\'','\''systemd_units'\'','\''disk'\'','\''diskio'\'','\''cpu'\'','\''mem'\'','\''system'\'','\''dm_names'\'','\''net'\'','\''net_if_mac'\'','\''node_hardware'\'','\''quorum_detail'\'','\''reboot_pending'\'','\''security_updates'\'')"}'
```

**16 tables** attendues (10 plugins natifs + 6 scripts exec). Les checks d'audit fondés sur
l'agent s'activent au tick suivant du poller (caches 5 min). Dépannage sur le nœud :
`journalctl -u telegraf -n 30 --no-pager`.

## 11. Centreon — compte, token API & NSCA (module « Alarmes & Centreon »)

Optionnel : le module « Alarmes & Centreon » (famille `centreon-nsca`) provisionne des
services passifs sur un **central Centreon** (versions **22 → 26**) et y envoie des trames
NSCA. Le script du kit prépare le central de façon **idempotente** :

1. groupe de permission `groupeprox4u` (CLAPI `ACLGROUP`) ;
2. compte `prox4u` (**admin global** : `contact_admin=1`) + rattachement au groupe. Le flag
   admin se pose via CLAPI `CONTACT -a setparam -v "prox4u;admin;1"` — **le paramètre CLAPI
   s'appelle `admin`, PAS `contact_admin`** (colonne DB ; l'autre nom est sans effet).
   **Obligatoire** : sans lui, la nouvelle API `/api/latest/` renvoie **403** sur toutes les
   ressources même avec un token valide (gotcha validé sur Centreon 26.10) ;
3. **token API** généré + inséré en base (`security_token` + `security_authentication_tokens`,
   schéma 21.10+ ; fallback table `token` ≤ 20.x) — affiché **une seule fois** — **seul accès DB**
   du script (pas d'équivalent CLAPI pour générer un token) ;
4. **mot de passe NSCA** généré + écrit dans `nsca.cfg` sur le **central** (le listener NSCA
   tourne sur la machine du central — best-effort, le daemon `nsca` est un add-on
   centreon-engine, à installer si absent) ;
5. **user de monitoring NON-ADMIN** (console Centreon, vision hosts/services) : compte
   (CLAPI `CONTACT`, `admin=0`) + rattachement au groupe ACL (défaut `ALL` = All Resources +
   Simple User) + **topologie menu « Monitoring »** (lecture seule — les tables `acl_topology*`
   sont vides par défaut en 26.10, sans elle le menu est vide et toutes les pages affichent
   « Perdu(e) dans l'espace ») + recalcul des ACL (`centAcl.php`). Mdp saisi au setup
   (**vide = pas de user créé**).

> **CLAPI d'abord** : groupe + comptes passent par CLAPI (`ACLGROUP`/`CONTACT`), la cible NSCA
> est le central lui-même (IP machine) — **pas de liste DB des pollers**. La DB est touchée
> pour le token **et** l'ACL du user monitoring (topologie + rattachement — pas d'API/CLAPI
> pour ça en 26.10), plus la rotation/suppression via `--rotate-token`/`--remove`.
>
> ⚠ **API legacy `/api/restapi` supprimée en 26.10** (404) : le transport REST v1 de l'app
> (`provision.ts`, Basic auth sur `/api/restapi/*`) ne fonctionne plus sur les versions récentes
> → refonte sur `/api/latest/` + `X-AUTH-TOKEN` (issue #8). Le NSCA (TCP 5668) est indépendant.

### 11.1 Marche à suivre (admin, sur le central)

Le script est **autonome** (un seul fichier, ~800 lignes) — dépendances `curl`, `python3`,
`openssl`, `mysql`, toutes présentes par défaut sur un central Centreon. Il doit tourner **en
root sur le central** (accès DB requis pour le token + l'ACL du user monitoring).

**Étape 1 — Amener le script sur le central.** Depuis la machine de dev (ou le serveur
Prox4u, où le kit vit dans `deploiement/`) :

```bash
scp deploiement/70-centreon-setup.sh root@<ip-central>:/root/
```

**Étape 2 — Aperçu (rien n'est exécuté, aucun prompt).** Sur le central, en root :

```bash
bash /root/70-centreon-setup.sh --dry-run
```

**Étape 3 — Exécution réelle (interactive).** L'admin saisit, au fil des prompts :

```bash
bash /root/70-centreon-setup.sh
```

1. **Identifiant admin** Centreon (défaut `admin`) + **mot de passe** (saisie masquée) ;
2. **Mot de passe du compte `prox4u`** (saisie + confirmation) ;
3. **Mot de passe du user monitoring** `noc` (saisie + confirmation — **vide = pas de user
   créé**) ;
4. **Mot de passe DB** (uniquement si l'accès auto échoue — repli : identifiants
   `centreon.conf.php`/`centreon`, puis root via socket unix).

Le script crée groupe (CLAPI) + compte admin (CLAPI) + user monitoring (CLAPI + ACL SQL) +
token (DB) + mdp NSCA (sur le central), puis **auto-vérifie** (token accepté par la nouvelle
API `/api/latest/` via l'en-tête `X-AUTH-TOKEN` + listener NSCA en TCP) et affiche un **récap**
en fin d'exécution.

**Étape 4 — Saisir le récap dans Prox4u.** Copier la config du récap dans
**Admin → Centreon (NSCA)** (cf. §11.3). Le token et le mdp NSCA n'y figurent **qu'une fois**
(§11.3).

**Étape 5 — Vérifier le daemon NSCA** (best-effort) : le script écrit `nsca.cfg` sur le central,
teste le listener (TCP) et redémarre le daemon `nsca` s'il tourne déjà (pour charger le nouveau
mdp). L'installation du daemon `nsca` (add-on centreon-engine) reste à la charge de l'admin
(avertissements à l'écran).

**Relance / maintenance** (idempotent — relançable sans effet de bord) :

| Flag | Effet |
|---|---|
| *(aucun)* | recrée ce qui manque, réutilise token/mdp NSCA existants |
| `--dry-run` | aperçu, rien n'est exécuté |
| `--rotate-token` | nouveau token API (l'ancien est révoqué) |
| `--rotate-nsca` | nouveau mdp NSCA (réécrit `nsca.cfg`) |
| `--remove` | nettoie groupe/compte/token/**user monitoring** (les services créés par le module sont **conservés**) |
| `--token-only` | **token seul**, non-interactif (pas de groupe/compte/NSCA) — voir §11.4 |

### 11.2 Variables d'environnement

| Variable | Défaut | Note |
|---|---|---|
| `CENTRON_URL` | `http://localhost/centreon` | base URL du central **pour le script** (il tourne sur le central → `localhost` OK) |
| `REST_URL_PROX4U` | calculée (IP central + chemin de `CENTRON_URL`) | URL REST à **saisir dans Prox4u** (joignable par le réseau, pas `localhost`) |
| `GROUP_NAME` | `groupeprox4u` | nom du groupe de permission |
| `USER_LOGIN` | `prox4u` | login du compte (admin global) |
| `USER_EMAIL` | `prox4u@localhost` | email du compte |
| `MON_USER_LOGIN` | `noc` | login du **user de monitoring non-admin** (console) |
| `MON_USER_EMAIL` | `noc@localhost` | email du user monitoring |
| `MON_GROUP` | `ALL` | groupe ACL de rattachement (défaut Centreon = All Resources + Simple User) |
| `MON_TOPO_NAME` | `Monitoring` | nom du groupe topologie (menu) créé/rattaché |
| `NSCA_PORT` | `5668` | port du listener NSCA |
| `NSCA_CFG_PATH` | `/etc/centreon/nsca.cfg` | chemin de `nsca.cfg` sur le central |
| `NSCA_CHECK_COMMAND` | `/usr/bin/centengine -c /etc/centengine/centengine.cfg --external-command` | soumission du check à centengine — **à vérifier** selon l'env |
| `DB_USER` / `DB_NAME` / `DB_PASS` | lus dans `/etc/centreon/centreon` puis `centreon.conf.php` | identifiants DB (token) — repli root via socket unix, sinon prompt |

### 11.3 Config Prox4u (Page 3 + `.env`)

Après exécution, renseigner dans Prox4u le récap affiché :
**Transport** REST (URL = **URL externe du central**, user = `prox4u`) + **NSCA** (serveur =
**IP du central**, port). Les **champs non-secrets** (URL, user, hôte, port) se saisissent dans
l'UI (Admin → Centreon (NSCA)).

**Les secrets (token / mots de passe) vont dans le `.env` du serveur Prox4u** — ils ne
transitent plus par l'interface :

```bash
# .env du serveur Prox4u (valeurs du récap du script)
CENTREON_REST_TOKEN="<token API du récap>"                # token API (REST)
CENTREON_NSCA_PASSWORD="<mdp NSCA du récap>"              # mdp NSCA
CENTREON_CLAPI_PASSWORD="<mdp admin>"                     # mdp CLAPI (si transport CLAPI)
```

> ℹ️ **Prévalence `.env`** : si une variable `CENTREON_*` est renseignée, elle **prévaut** sur
> la valeur saisie dans l'UI (stockée dans `data/centreon-nsca.json`). L'UI affiche alors
> « Fourni via .env ({{var}}) » sous le champ concerné. Les valeurs UI restent un repli si le
> `.env` est vide. Redémarrer le serveur après modification du `.env`.

> ⚠ **URL REST ≠ `localhost`** : le serveur Prox4u est sur une **autre machine** que le
> central → l'URL à saisir doit être joignable par le réseau (ex. `http://192.168.1.130/centreon`),
> **pas** `http://localhost/centreon`. Le script l'affiche dans le récap (`REST URL … ← à
> saisir`) — même scheme + chemin que `CENTRON_URL`, hôte = IP réelle du central. Surcharge :
> `REST_URL_PROX4U` (si le central est joint via un hostname/proxy).

> ⚠ Le token et le mdp NSCA ne sont affichés **qu'une fois** (et stockés en base). En cas de
> perte, relancer avec `--rotate-token` / `--rotate-nsca`.
>
> ⚠ **NSCA** : le daemon `nsca` (add-on centreon-engine) doit être installé + démarré sur le
> central. Le script écrit `nsca.cfg`, teste le listener (TCP) et redémarre le daemon s'il
> tourne déjà ; l'installation du daemon reste à la charge de l'admin (best-effort).

### 11.4 Token API seul — mode `--token-only`

Pour ne toucher **qu'au token** (sans recréer groupe/compte/NSCA), `70-centreon-setup.sh`
offre un mode **non-interactif** `--token-only` (à exécuter en root sur le central, comme le
§11.1 — seul l'accès DB est requis, pas d'identifiants admin à saisir). Il suppose que le
compte `prox4u` **existe déjà** (créé par le mode complet ou manuellement) ; sinon il s'arrête
avec un message clair.

```bash
bash /root/70-centreon-setup.sh --token-only                 # crée le token (ou réutilise l'existant)
bash /root/70-centreon-setup.sh --token-only --rotate-token  # régénère le token (l'ancien est révoqué)
bash /root/70-centreon-setup.sh --token-only --remove        # supprime le token
bash /root/70-centreon-setup.sh --token-only --dry-run       # aperçu, rien n'est exécuté
```

Le token est inséré en base (schéma 21.10+ `security_token` + `security_authentication_tokens`,
fallback table `token` ≤ 20.x), auto-vérifié contre la nouvelle API (`/api/latest/` + en-tête
`X-AUTH-TOKEN`) et affiché **une seule fois** en fin de script.

> Cas d'usage typique : token perdu ou compromis → `bash /root/70-centreon-setup.sh
> --token-only --rotate-token` sur le central, puis reporter le nouveau token dans Prox4u
> (Admin → Centreon (NSCA)).
