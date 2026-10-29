# Déploiement sur un nouveau serveur / Deployment on a new server

Procédure bout-en-bout pour déployer l'application sur un serveur dédié, **hors infrastructure Proxmox**, sans git (transfert du kit `deploiement/` — l'application voyage dans son tarball) et sans interface graphique (comptes et tokens créés par commandes).

*End-to-end procedure to deploy the application on a dedicated server, **outside the Proxmox infrastructure**, without git (transfer of the `deploiement/` kit — the application travels in its tarball) and without any GUI (accounts and tokens created by commands).*

> **Ce dossier `deploiement/` est le livrable de déploiement — tout y est, autonome. On déplace le dossier entier sur la cible et on déploie depuis lui** :
> - `DEPLOY.md` — cette procédure ;
> - `10-proxmox-token.sh` — à exécuter **sur chaque serveur Proxmox** (§2) ;
> - `20-package-release.sh` — à exécuter **sur la machine de dev** pour produire le tarball dans `releases/` (§3) ;
> - `releases/prox4u-<date>.tar.gz` — **l'application elle-même** (produite par 20) ;
> - `30-env-setup.sh`, `40-tls-init.sh`, `50-influxdb-init.sh` — installation **sur le serveur applicatif**, numérotés dans l'ordre d'exécution, prennent le dossier d'installation en argument (§5) ;
> - `prox4u.service` — unit systemd du serveur applicatif (§8).
>
> *This `deploiement/` folder is the deployment deliverable — it is fully self-contained. Move the whole folder to the target and deploy from it: this procedure, the PVE token script (§2), the dev-machine packaging script (§3), the application tarball in `releases/`, the app-server installation scripts numbered in execution order taking the install directory as argument (§5) and the systemd unit (§8).*

```
Serveur cible (app)                Serveurs Proxmox VE × N
┌─────────────────────────┐        ┌──────────────────┐
│ /opt/prox4u    │  API   │ pveum (token     │
│  app Node.js :8080      │◄──────►│ lecture seule)   │
│  InfluxDB Docker :8181  │  8006  └──────────────────┘
│  Explorer Docker :8888  │
└─────────────────────────┘
```

**Réseau / Network** : sortant TCP **8006** depuis le serveur de l'app vers chaque Proxmox (API PVE ; 8007 pour PBS plus tard) · entrant TCP **8080** depuis les postes des utilisateurs.

---

## 1. Prérequis du serveur cible / Target server prerequisites

| Prérequis | Version | Installation |
|---|---|---|
| Node.js | ≥ 20 | paquet système recommandé (Nodesource) → `/usr/bin/node` |
| pnpm | ≥ 9 | `npm install -g pnpm` |
| Docker + plugin compose | récent | `docker compose version` doit répondre |

*Node.js ≥ 20 (system package recommended so that `/usr/bin/node` exists for systemd), pnpm ≥ 9, Docker with the compose plugin.*

## 2. Tokens Proxmox — par cluster, sans GUI / Proxmox tokens — per cluster, no GUI

Sur **chaque** serveur Proxmox, en root. Le script est idempotent et s'auto-teste :

*On **each** Proxmox server, as root. The script is idempotent and self-tests the API:*

```bash
# depuis la machine de développement (le script est dans le kit) :
scp deploiement/10-proxmox-token.sh root@<pve>:/tmp/
ssh root@<pve> /tmp/10-proxmox-token.sh
```

Le script crée, par commandes `pveum` (aucune GUI) :

*The script creates, via `pveum` commands (no GUI):*

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
>
> *Granting the role to an existing monitoring user (e.g. `supervision@pam`, already in `.env`/`clusters.json`): the granted role **must include `VM.Audit`** (VM listing) **and** `VM.GuestAgent.Audit` (per-partition disk usage). The kit's `ManagerReader` role already has both. If you use your own role, make sure it carries those two privileges — otherwise the inventory empties or QEMU disk stays blank.*

La valeur du token est affichée **une seule fois** — noter les trois champs :

*The token value is shown **once only** — note the three fields:*

```
"user"       : "manager@pve"
"tokenId"    : "manager"
"tokenValue" : "<valeur>"
```

Variables optionnelles du script : `PVE_APP_USER` (défaut `manager@pve`), `PVE_TOKEN_ID` (défaut `manager`), `PVE_COMMENT`. Mode d'aperçu : `./deploiement/10-proxmox-token.sh --dry-run`.

*Optional variables: `PVE_APP_USER` (default `manager@pve`), `PVE_TOKEN_ID` (default `manager`), `PVE_COMMENT`. Preview mode: `./deploiement/10-proxmox-token.sh --dry-run`.*

> ### Occupation disque réelle des VMs QEMU — agent invité / Real QEMU VM disk usage — guest agent
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
> *The Proxmox RRD `disk` only measures **LXC container** disk usage; for **QEMU VMs it is 0**. The app therefore reads real QEMU disk usage via the **guest agent**: `GET …/agent/get-fsinfo`, summing `used-bytes`/`total-bytes` of the filesystems backed by a VM disk (non-empty `disk` field) — network mounts have no `disk` field and are excluded. Only `VM.GuestAgent.Audit` is required (no `Unrestricted`). The agent is polled at most every 5 min per VM. LXC usage comes from `/cluster/resources` `disk`/`maxdisk`. If the agent is absent / VM stopped, the field is simply omitted.*
>
> **⚠️ Contrainte PVE 9.1.1** : sur cette build, les endpoints REST agent `agent/fs-info` (« not implemented ») et `agent/exec` (HTTP 596 « Broken pipe ») sont **cassés** — seul **`agent/get-fsinfo`** fonctionne. C'est pour cela que l'app utilise `get-fsinfo` (et non `fs-info`/`exec`). Sur les versions où `agent/exec` fonctionne, rien ne change côté app.
>
> *PVE 9.1.1 caveat: on that build the agent REST endpoints `agent/fs-info` (“not implemented”) and `agent/exec` (HTTP 596 “Broken pipe”) are **broken** — only **`agent/get-fsinfo`** works. That is why the app uses `get-fsinfo`.*
>
> **⚠️ Piège `pveum acl modify`** : `pveum acl modify <path> --user <u> --role <R>` **REMPLACE** le rôle de l'utilisateur sur ce path. Lancer `pveum acl modify /vms --user manager@pve --role <R>` avec un `<R>` qui n'inclut **pas** `VM.Audit` **supprime** le droit de liste des VMs → `/cluster/resources` ne renvoie plus aucune VM → **inventaire vide**. Pour ajouter un droit agent sans casser la lecture : soit le rôle inclut déjà `VM.Audit` (cas du `ManagerReader` du kit), soit utiliser l'ACL additive `pveum acl add <path> --user <u> --role <R>` (qui **ajoute** un path/rôle sans remplacer).
>
> *`pveum acl modify <path> …` **REPLACES** the user's role on that path. Running it on `/vms` with a role lacking `VM.Audit` **removes** VM listing → `/cluster/resources` returns no VMs → **empty inventory**. To add an agent right without breaking read access, use the additive `pveum acl add <path> …` (adds, does not replace).*

## 3. Transfert du kit / Kit transfer

Le dossier `deploiement/` est **autonome** (procédure + scripts + tarball de l'application + unit systemd) : on déplace **tout le dossier**, rien d'autre.

*The `deploiement/` folder is **self-contained** (procedure + scripts + application tarball + systemd unit): move the **whole folder**, nothing else.*

```bash
# machine de développement :
./deploiement/20-package-release.sh    # build + deploiement/releases/prox4u-<date>.tar.gz

# on déplace le kit entier sur la cible :
scp -r deploiement root@<cible>:/tmp/
```

Le tarball (dans `deploiement/releases/`) contient source + `dist/` pré-buildé ; il n'a aucun secret (`.env`, `clusters.json`, `data/`, `logs/` sont hors paquet — garde-fou intégré au script).

*The tarball (in `deploiement/releases/`) contains source + pre-built `dist/`; no secrets are included (`.env`, `clusters.json`, `data/`, `logs/` are excluded — with a built-in guard).*

## 4. Installation de l'application / Application installation

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

*A single user owns both the app and the data: the InfluxDB container will run with the same uid/gid (§5), avoiding any permission conflict on `data/`.*

## 5. Configuration locale / Local configuration

Les scripts sont **numérotés dans l'ordre d'exécution** — les lancer un par un, **depuis le kit**, avec le dossier d'installation en argument :

*The scripts are **numbered in execution order** — run them one at a time, **from the kit**, with the install directory as argument:*

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
>
> *The directory argument is optional: from the installed tree (`/opt/prox4u/deploiement/…`), the scripts default to their parent directory.*

Seule vérification manuelle restante dans `.env` : confirmer `TLS_KEY` / `TLS_CERT` / `INFLUX_CA_CERT` / `INFLUX_URL` (déjà pré-remplis avec les bonnes valeurs).

*The only manual check left in `.env`: confirm `TLS_KEY` / `TLS_CERT` / `INFLUX_CA_CERT` / `INFLUX_URL` (pre-filled with the right values).*

> Le SAN est important : les navigateurs des utilisateurs accèdent à l'app via l'IP/hostname du serveur (pas `localhost`) — sans SAN correspondant, le navigateur refuse le certificat.
>
> *The SAN matters: users' browsers reach the app via the server's IP/hostname (not `localhost`) — without a matching SAN, browsers reject the certificate.*

**InfluxDB : deux bases, créées et consolidées automatiquement** — `raw` (toutes les métriques brutes, rétention 31 j) et `consolidated` (métriques consolidées 5 min, rétention **infinie**, pour l'historique long terme). Les deux sont créées au démarrage de l'app ; le consolidateur tourne toutes les 5 min (reprise après arrêt via `data/consolidation-state.json`, backfill par tranches d'un jour après un long arrêt) ; la lecture bascule automatiquement sur `consolidated` pour les longues périodes. Repli RRD Proxmox si InfluxDB est indisponible.

*InfluxDB: two databases, created and consolidated automatically — `raw` (all raw metrics, 31-day retention) and `consolidated` (5-minute consolidated metrics, **infinite** retention, for long-term history). Both are created at app startup; the consolidator runs every 5 minutes (restart-safe via `data/consolidation-state.json`, backfill in one-day chunks after a long outage); reads automatically switch to `consolidated` for long timeframes. Fallback to Proxmox RRD if InfluxDB is unavailable.*

## 6. Endpoints surveillés / Monitored endpoints

```bash
cd /opt/prox4u
cp clusters.example.json clusters.json    # remplir un bloc par cluster (§2)
chmod 600 clusters.json
```

- **`sites.json`** (déjà dans le paquet) : adapter le mapping nœuds → bâtiments à la topologie réelle — requis pour le PRA.
- **`overcommit.json`** (déjà dans le paquet) : seuils de surallocation + code couleur d'usage ; défauts sains fournis, ajustable à chaud (hot-reload, pas de restart).

*`sites.json` (already in the package): adapt the node → building mapping to the real topology — required for PRA. `overcommit.json` (already in the package): overcommit thresholds + usage color code; sane defaults provided, hot-reloadable (no restart).*

## 7. Démarrage + vérification / Start + verification

```bash
cd /opt/prox4u
./up.sh                                # InfluxDB (Docker) + Explorer + application
curl -k https://localhost:8080/api/health
docker compose ps                      # influxdb → "healthy"
tail -n 50 logs/server.log
```

Vérifications attendues :

*Expected checks:*

- `/api/health` → `200` ;
- `docker compose ps` → conteneur InfluxDB **healthy** ;
- `logs/server.log` → ligne `InfluxDB prêt : bases raw (31 j) + consolidated (∞)` (ou « repli RRD » si InfluxDB désactivé) ;
- navigateur sur `https://<ip-du-serveur>:8080` (certificat auto-signé : accepter l'exception) → badge **LIVE**, endpoints listés dans la sidebar, Health Score calculé ;
- `logs/server.log` : un tick par endpoint sans erreur d'authentification PVE.

> Le port API InfluxDB 8181 est lié **localhost uniquement** (l'app se connecte en local) — l'API n'est pas exposée au réseau. Explorer (8888) reste accessible.
>
> *The InfluxDB API port 8181 is bound to **localhost only** (the app connects locally) — the API is not exposed to the network. Explorer (8888) stays reachable.*

## 8. Persistance au boot / Boot persistence

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

*InfluxDB and Explorer are Docker containers with `restart: unless-stopped` → they start with the Docker service at boot. The systemd unit restarts the app on crash (`Restart=always`) and at boot.*

## 9. Opérations courantes / Day-2 operations

| Opération | Commandes |
|---|---|
| **Mise à jour** / *Update* | `./deploiement/20-package-release.sh` (dev) → `scp deploiement/releases/prox4u-*.tar.gz cible:/tmp/` → `sudo tar -xzf /tmp/prox4u-*.tar.gz -C /opt/prox4u` → `pnpm install --prod` → `sudo chown -R proxmox:proxmox /opt/prox4u` → `sudo systemctl restart prox4u` |
| **Rotation d'un token PVE** / *PVE token rotation* | sur le PVE : `pveum user token del manager@pve manager && pveum user token add manager@pve manager --privsep 0` → mettre à jour `clusters.json` → `sudo systemctl restart prox4u` |
| **Supprimer un endpoint** / *Remove an endpoint* | retirer le bloc de `clusters.json` (+ son site dans `sites.json`) → restart |
| **Logs** / *Logs* | `logs/server.log` (app) · `docker compose logs influxdb` |
| **Sauvegarde** / *Backup* | tout l'état est dans `data/` (InfluxDB, état du consolidateur, certificats TLS, token admin) — copier `data/` + `.env` + `clusters.json` + `sites.json` |

> **PBS (phase 1B)** : le token Proxmox Backup Server se créera de la même façon par commandes (`pbs config add-user` + token via API) — procédure à compléter quand PBS sera déployé.
>
> *PBS (phase 1B): the Proxmox Backup Server token will be created the same way by commands (`pbs config add-user` + token via API) — procedure to be completed when PBS is deployed.*
