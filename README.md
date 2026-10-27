# Prox4u — Dashboard de supervision

Dashboard web de supervision pour cluster **Proxmox VE 9** : vue DSI/manager (KPIs, Health Score, PRA multi-bâtiments, capacity planning) et vue exploitation (métriques historiques, topologie réseau, stockage, alarmes).

> Web dashboard for a **Proxmox VE 9** cluster: management view (KPIs, Health Score, multi-site PRA, capacity planning) and operations view (historical metrics, network topology, storage, alarms).

---

## Documentation / Documentation

| Document | Rôle |
|---|---|
| [`skills/`](./skills/) | **Base de connaissance** pour la reprise (humain ou IA) : 7 skills par module (architecture, plugins, API, shared, opérations…) + [inventaire et règles de maintenance](./skills/README.md) |
| [`STATUS.md`](./STATUS.md) | État d'avancement : jalons livrés, pièges corrigés, points en attente |
| [`deploiement/DEPLOY.md`](./deploiement/DEPLOY.md) | Procédure de déploiement sur un nouveau serveur (FR/EN) |

*Knowledge base for handover (human or AI): 7 per-module skills + [inventory and maintenance rules](./skills/README.md) · Progress status: delivered milestones, fixed pitfalls, pending items · Deployment procedure on a new server (FR/EN).*

## Fonctionnalités / Features

- **Multi-cluster / nœuds autonomes** : plusieurs endpoints Proxmox déclarés dans `clusters.json` (un par cluster ou nœud autonome) ; vue d'ensemble agrégée + un dashboard complet par endpoint, navigation dans la barre latérale. Un endpoint en panne n'impacte pas les autres.
  *Multi-cluster / standalone nodes: multiple Proxmox endpoints declared in `clusters.json` (one per cluster or standalone node); aggregated overview + a full dashboard per endpoint, navigable from the sidebar. One failing endpoint does not affect the others.*
- **Snapshot temps réel** (WebSocket, tick 5 s) : KPIs cluster, Health Score, PRA par site/bâtiment, top consommateurs VM/pools, alarmes.
  *Real-time snapshot (WebSocket, 5 s tick): cluster KPIs, Health Score, per-site PRA, top VM/pool consumers, alarms.*
- **Métriques historiques** avec double source : **InfluxDB 3 Core** (natif) et repli automatique sur les **RRD Proxmox**. Un badge dans le panneau « Métriques » indique la source active.
  *Historical metrics with dual source: **InfluxDB 3 Core** (native) with automatic fallback to **Proxmox RRD**. A badge in the Metrics panel shows the active source.*
- **Capacity planning** : prévisions de saturation CPU/RAM/disque (30 j) + tendance 7 j.
  *Capacity planning: CPU/RAM/disk saturation forecasts (30 d) + 7-day trend.*
- **Mode démo** (`MOCK=1`) : cluster simulé multi-bâtiments, sans Proxmox.
  *Demo mode (`MOCK=1`): simulated multi-site cluster, no Proxmox required.*

## Architecture / Architecture

```
Proxmox VE 9 (API) × N endpoints ──► Poller (5 s, parallèle par endpoint) ──► Snapshot multi ──► WebSocket ──► UI
                                                        │
                                                        ├─► InfluxDB 3 Core : base raw (rétention 31 j, échantillons 5 s, tag cluster)
                                                        │        │
                                                        │        └─► Consolidateur (5 min, par cluster) ─► base consolidated (∞, buckets 5 min)
                                                        │
                                                        └─► Repli historique : RRD Proxmox (si InfluxDB absent/indisponible)

API HTTP : /api/dashboard · /api/endpoints · /api/metrics?timeframe=hour|day|week|month&endpoint=<id> · /api/capacity · /api/trends · /api/health
```

Monorepo pnpm : `packages/shared` (types + calculs + i18n), `packages/server` (Fastify, poller, client PVE, InfluxDB), `packages/web` (React + ECharts).

*pnpm monorepo: `packages/shared` (types + computations + i18n), `packages/server` (Fastify, poller, PVE client, InfluxDB), `packages/web` (React + ECharts).*

## Prérequis / Prerequisites

- Node.js ≥ 20, pnpm ≥ 9
- Proxmox VE 9 avec un **API token** en lecture seule — à créer **par commandes, sans GUI** : `deploiement/10-proxmox-token.sh` sur chaque serveur Proxmox (rôle `ManagerReader` + user dédié + token + auto-test)
- Docker (optionnel) pour InfluxDB 3 Core

> **Déploiement sur un autre serveur** : procédure complète dans [deploiement/DEPLOY.md](./deploiement/DEPLOY.md) — tarball via `deploiement/20-package-release.sh` (sans git), tokens par commandes, systemd au boot.
> *Deployment on another server: full procedure in [deploiement/DEPLOY.md](./deploiement/DEPLOY.md) — tarball via `deploiement/20-package-release.sh` (no git), tokens by commands, systemd at boot.*

## Démarrage rapide / Quickstart

```bash
git clone <repo> && cd Prox4u
cp .env.example .env          # puis éditer INFLUX_URL / tokens (ou clusters.json pour le multi-endpoints)
pnpm install
pnpm build

# InfluxDB (optionnel mais recommandé) — scripts numérotés dans l'ordre d'exécution
./deploiement/40-tls-init.sh      # génère les certificats auto-signés (data/tls/)
./deploiement/50-influxdb-init.sh # génère le token admin + met à jour .env
sudo chown -R 1500:1500 data/influxdb   # user non-root du conteneur (voir note ci-dessous)

./up.sh                       # démarrage complet : InfluxDB (Docker) + application
# ou séparément :
# docker compose up -d influxdb
# ./server.sh start           # ou : pnpm dev (mode développement)
```

L'application est sur <https://localhost:8080> (certificat auto-signé : le navigateur demandera confirmation). Sans `INFLUX_TOKEN` (ou sans Docker), tout fonctionne en repli RRD Proxmox.

**Explorer** (UI officielle InfluxDB 3 : requêtes SQL + visualisations) est sur <https://localhost:8888> — connexion à InfluxDB préconfigurée (`data/explorer/config/config.json`). Optionnel : `docker compose up -d explorer` / `docker compose stop explorer`.

> **Note permissions (Docker)** — le conteneur tourne en non-root (`user: 1500:1500`, configurable via `INFLUX_UID`/`INFLUX_GID` dans `.env`) : le dossier `data/influxdb/` doit lui appartenir (`chown -R`). La doc officielle InfluxDB ne couvre pas ce point. Les clés TLS sont en 644 pour être lisibles par ce user (certificats auto-signés, déployement local).
>
> *Permissions note (Docker) — the container runs as a non-root user (`user: 1500:1500`, configurable via `INFLUX_UID`/`INFLUX_GID` in `.env`): the `data/influxdb/` directory must be owned by it (`chown -R`). Official InfluxDB docs don't cover this. TLS keys are 644 so that user can read them (self-signed certs, local deployment).*

## Configuration / Configuration

Variables dans `.env` (voir `.env.example`) :

| Variable | Défaut | Description |
|---|---|---|
| `PVE_URL` | `https://127.0.0.1:8006` | URL de l'API Proxmox |
| `PVE_USER` / `PVE_TOKEN_ID` / `PVE_TOKEN_VALUE` | — | Identifiants du token API (`user@realm!tokenid=value`) |
| `TLS_REJECT_UNAUTHORIZED` | `false` | `true` = refuser les certificats auto-signés |
| `MOCK` | `0` | `1` = données simulées (démo) |
| `MOCK_SCENARIO` | `nominal` | `nominal` \| `degraded` \| `critical` |
| `PORT` | `8080` | Port du serveur (HTTP ou HTTPS selon TLS) |
| `TLS_KEY` / `TLS_CERT` | *(vides)* | Paires de certificats de l'application — **vides = HTTP clair** |
| `INFLUX_URL` | `http://localhost:8181` | URL InfluxDB 3 Core (`https://…` en TLS) |
| `INFLUX_TOKEN` | *(vide)* | Token admin (`apiv3_…`) — **vide = InfluxDB désactivé** |
| `INFLUX_RAW_DB` | `raw` | Base brute (rétention 31 j) |
| `INFLUX_AGG_DB` | `consolidated` | Base consolidée (rétention infinie) |
| `INFLUX_CA_CERT` | *(vide)* | Certificat auto-signé InfluxDB à faire confiance (fetch app → InfluxDB) |

## Multi-cluster / Multi-cluster

Un fichier `clusters.json` à la racine déclare les endpoints Proxmox (un par cluster, ou un par nœud autonome). Copier `clusters.example.json`, remplir, puis `chmod 600 clusters.json` :

```json
{
  "endpoints": [
    { "id": "proxmox", "name": "Cluster principal", "url": "https://192.168.1.80:8006",
      "token": "user@pve!tokenid=xxxxxxxx" }
  ]
}
```

- **`clusters.json` est gitignored** (contient des tokens) ; le template `clusters.example.json` est commité.
  *`clusters.json` is gitignored (contains tokens); the `clusters.example.json` template is committed.*
- Sans ce fichier, l'app repasse en **mono-endpoint** `default` construit depuis `PVE_URL`/`PVE_USER`/`PVE_TOKEN_*` du `.env`.
  *Without this file, the app falls back to a single `default` endpoint built from the `.env` `PVE_*` variables.*
- Chaque site de `sites.json` se rattache à un endpoint via son champ `"endpoint"` (id).
  *Each site in `sites.json` is bound to an endpoint via its `"endpoint"` field (id).*
- L'historique InfluxDB est taggé par `cluster` ; les lignes écrites avant le multi-cluster (sans tag) sont attribuées à l'endpoint par défaut — aucun backfill nécessaire.
  *InfluxDB history is tagged by `cluster`; rows written before multi-cluster support (untagged) are attributed to the default endpoint — no backfill needed.*

## InfluxDB 3 Core / InfluxDB 3 Core

- **Deux bases** : `raw` (rétention native **31 jours**, échantillons toutes les 5 s) et `consolidated` (rétention **infinie**, agrégats 5 min). Les rétentions sont fixées à la création (immuable en Core) et recréées automatiquement au démarrage.
  *Two databases: `raw` (native **31-day** retention, 5 s samples) and `consolidated` (**infinite** retention, 5-minute aggregates). Retentions are set at creation (immutable in Core) and re-created automatically at boot.*
- **Consolidateur** : job interne toutes les 5 min (fenêtres complètes uniquement), avec reprise après arrêt via `data/influxdb/consolidation-state.json`.
  *Consolidator: internal 5-minute job (complete windows only), with resume-after-restart via `data/influxdb/consolidation-state.json`.*
- **Repli** : toute erreur ou réponse vide InfluxDB bascule automatiquement sur les RRD Proxmox ; le champ `source` (`influx` | `rrd`) est renvoyé par l'API et affiché dans l'UI.
  *Fallback: any InfluxDB error or empty response automatically switches to Proxmox RRD; the `source` field (`influx` | `rrd`) is returned by the API and shown in the UI.*

### Schéma des mesures / Measurement schema

| Base | Mesure | Tags | Champs / Fields |
|---|---|---|---|
| `raw` + `consolidated` | `storage_metrics` | `cluster` | `used_bytes`, `total_bytes` — stockage VM au niveau endpoint, série de référence des graphiques « Disque » (pondérée Σused/Σtotal à la lecture) |
| `raw` + `consolidated` | `node_metrics` | `cluster`, `node` | `cpu_pct`, `ram_pct`, `disk_pct` (rootfs), `net_in_bps`, `net_out_bps` |
| `raw` + `consolidated` | `vm_metrics` | `cluster`, `node`, `vmid`, `name` | `cpu_pct`, `mem_bytes` (VMs running uniquement) |

Lecture : `hour`/`day`/`week` sur `raw` (buckets 1 min / 5 min / 1 h), `month` + capacity + trends sur `consolidated`.
*Reads: `hour`/`day`/`week` from `raw` (1 min / 5 min / 1 h buckets), `month` + capacity + trends from `consolidated`.*

## TLS / TLS

HTTPS pour l'application **et** InfluxDB, avec certificats auto-signés générés localement (aucun CA externe).

*HTTPS for the application **and** InfluxDB, with locally generated self-signed certificates (no external CA).*

```bash
./deploiement/40-tls-init.sh   # génère data/tls/{app,influxdb}-{key,cert}.pem (10 ans)
```

- **Application** : `TLS_KEY` + `TLS_CERT` dans `.env` → le serveur écoute en HTTPS sur `PORT`, WebSocket en `wss`. Sans ces variables, HTTP clair.
  *Application: set `TLS_KEY` + `TLS_CERT` in `.env` → the server listens on HTTPS on `PORT`, WebSocket over `wss`. Without them, plain HTTP.*
- **InfluxDB** : le conteneur démarre avec `--tls-cert/--tls-key` (montés en lecture seule depuis `data/tls/`) ; `INFLUX_URL=https://…` et `INFLUX_CA_CERT` permettent à l'app de faire confiance au certificat auto-signé.
  *InfluxDB: the container starts with `--tls-cert/--tls-key` (read-only mounted from `data/tls/`); `INFLUX_URL=https://…` and `INFLUX_CA_CERT` let the app trust the self-signed certificate.*

Options du script : `TLS_DAYS` (validité, défaut 3650) et `TLS_SAN_EXTRA` (SAN supplémentaires, ex. `DNS:proxmox.local,IP:192.168.1.50`) pour accéder via un hostname/IP autre que `localhost`.

*Script options: `TLS_DAYS` (validity, default 3650) and `TLS_SAN_EXTRA` (extra SANs, e.g. `DNS:proxmox.local,IP:192.168.1.50`) to reach the app by a hostname/IP other than `localhost`.*

## API / API

| Endpoint | Description |
|---|---|
| `GET /api/health` | Statut du serveur |
| `GET /api/dashboard` | Snapshot multi-endpoints (KPIs agrégés, santé + PRA + alarmes par endpoint) |
| `GET /api/endpoints` | Liste compacte des endpoints (id, nom, état, score) — alimente la sidebar |
| `GET /api/metrics?timeframe=hour\|day\|week\|month&endpoint=<id>` | Points métriques d'un endpoint + `source` |
| `GET /api/capacity?endpoint=<id>` | Prévisions de saturation 30 j + `source` |
| `GET /api/trends?endpoint=<id>` | Tendance 7 j + répartition OS + `source` |
| `GET /api/overcommit-risk?endpoint=<id>` | Risque de surallocation dynamique (pire cas p95 7 j par VM) |
| `GET /api/network-topology` | Topologie réseau auto-découverte par endpoint (switches → nœuds → ponts → segments → VMs) |
| `GET /api/storage-inventory` | Inventaire stockage → VMs par endpoint (datastores + VMs avec leur datastore) |
| `WS /ws` | Push du snapshot multi-endpoints (5 s) |

## Lancement & développement / Running & development

### Mode standard — API + frontend sur un seul port (recommandé)

```bash
pnpm build                 # build du frontend → packages/web/dist
./server.sh start          # ou : stop | restart | status — logs dans logs/
```

Le serveur sert **l'API et le frontend pré-buildé** sur `https://localhost:8080` (HTTPS si `TLS_KEY`/`TLS_CERT` sont définis dans `.env`, sinon HTTP clair). Après tout changement de code côté web, refaire `pnpm build` pour que le 8080 reflète les modifications.

*The server serves the **API and the pre-built frontend** on a single port (HTTPS when `TLS_KEY`/`TLS_CERT` are set in `.env`, plain HTTP otherwise). After any web code change, re-run `pnpm build` so port 8080 reflects it.*

### Mode développement — Vite + HMR sur le port 5173

```bash
./server.sh start          # backend seul (ou `pnpm dev` : serveur tsx watch + vite en parallèle)
cd packages/web
VITE_API_PROXY=https://localhost:8080 VITE_WS_PROXY=wss://localhost:8080 pnpm dev --host 0.0.0.0
```

Le proxy Vite vise par défaut `https://localhost:8080` ; `VITE_API_PROXY`/`VITE_WS_PROXY` permettent de pointer un autre backend (ex. mock).

*The Vite proxy targets `https://localhost:8080` by default; `VITE_API_PROXY`/`VITE_WS_PROXY` point it elsewhere (e.g. a mock).*

### Démarrage automatique / Auto-start

| Contexte | Mécanisme |
|---|---|
| **Production** | service systemd `deploiement/prox4u.service` (`Restart=always`, boot + crash) — procédure : [deploiement/DEPLOY.md](./deploiement/DEPLOY.md) §8 |
| **Machine de dev** | cron watchdog, `start` étant idempotent (« déjà en cours » → exit 0) : `@reboot …/server.sh start` + `* * * * * …/server.sh start` |

### Commandes utilitaires / Utility commands

```bash
pnpm test         # vitest (shared + server)
pnpm typecheck    # tsc --noEmit sur les 3 packages
pnpm build        # build production (shared → server → web)
./up.sh           # démarrage complet : InfluxDB (Docker) + application
```

## Structure / Layout

```
├── deploiement/              # LIVRABLE de déploiement — autonome : on déplace le dossier entier sur la cible et on déploie depuis lui ; porte d'entrée : DEPLOY.md
│   ├── DEPLOY.md             # procédure de déploiement sur un nouveau serveur (FR/EN)
│   ├── 10-proxmox-token.sh   # SUR CHAQUE PVE : compte + token API Proxmox lecture seule (idempotent, --dry-run)
│   ├── 20-package-release.sh # MACHINE DE DEV : build + tarball de l'application → releases/ (sans secrets)
│   ├── releases/             # tarball de l'application (produit par 20, gitignored) — le kit contient l'app
│   ├── 30-env-setup.sh       # SERVEUR APP : .env auto-rempli (INFLUX_UID/GID, EXPLORER_SESSION_KEY) — arg : [dossier-install]
│   ├── 40-tls-init.sh        # SERVEUR APP : certificats auto-signés app + InfluxDB (SAN) — arg : [dossier-install]
│   ├── 50-influxdb-init.sh   # SERVEUR APP : token admin InfluxDB + sync .env (idempotent) — arg : [dossier-install]
│   └── prox4u.service  # unit systemd du serveur applicatif (boot + restart auto)
├── docker-compose.yml        # InfluxDB 3 Core (8181) + Explorer UI (8888), secret token
├── clusters.json             # endpoints Proxmox multi-cluster (600, gitignored) — template : clusters.example.json
├── sites.json                # topologie des sites/bâtiments (PRA), rattachement par endpoint
├── overcommit.json           # politique de surallocation + seuils d'usage (hot-reload, source unique du code couleur)
├── skills/                   # base de connaissance (7 SKILL.md + README.md) — reprise humain ou IA
├── STATUS.md                 # état d'avancement : jalons livrés, pièges corrigés, points en attente
├── up.sh                     # démarrage complet : InfluxDB (Docker) + application
├── server.sh                 # start/stop/restart/status de l'app seule
└── packages/
    ├── shared/               # types, calculs (PRA, health, prévisions), i18n FR/EN
    ├── server/               # Fastify : poller multi-endpoints, client PVE, InfluxDB, routes API
    └── web/                  # React + ECharts : host applicatif + plugins métier (voir « Architecture plugin »)
```

## Architecture plugin / Plugin architecture

Le frontend (`packages/web`) est un **host** qui charge des **plugins** métier. Les trois modules d'origine (hypervision, network, storage) sont des plugins ; le host fournit le layout, le router, le store temps réel et les services partagés.

*The frontend is a **host** that loads business **plugins**. The three original modules (hypervision, network, storage) are plugins; the host provides the layout, the router, the real-time store and the shared services.*

```
packages/web/src/
├── core/                     # HOST — ne contient aucun code métier de module
│   ├── plugin/               # contrat + runtime : types (zod), registry, loader, eventBus, logger
│   ├── config/features.ts    # feature flags VITE_USE_PLUGIN_*
│   ├── api/                  # client REST partagé (/api/*)
│   ├── data/                 # store WS (zustand) + hooks
│   └── ui/                   # PluginSlot, PluginMenu, ModuleDisabled
├── plugins/                  # PLUGINS — un dossier par module métier
│   ├── hypervision/          # routes /, /e/:endpointId, /e/:endpointId/n/:nodeId (menu order 10)
│   ├── network/              # route /topology (menu order 20)
│   └── storage/              # route /storage (menu order 30)
├── components/               # layout (sidebar, topbar) + primitives UI partagées
├── store/ · hooks/ · lib/    # état host (layout, thème), hook ECharts, utilitaires
└── app.tsx · main.tsx        # bootstrap : loadPlugins() avant le premier rendu
```

### Contrat / Contract

Un plugin est un objet `Plugin` exporté par `plugins/<id>/index.ts` :

```ts
export const storagePlugin: Plugin = {
  manifest: {
    id: 'storage',            // stable, /^[a-z][a-z0-9-]*$/
    name: 'Storage',
    version: '0.1.0',         // semver
    routes: [{ path: '/storage', element: StoragePage }],
    menu: [{ id: 'storage-inventory', to: '/storage', labelKey: 'nav.storage', icon: HardDrive, order: 30 }],
    dependencies: [],         // ids de plugins requis (optionnel)
  },
  init(ctx) { /* ctx.api, ctx.eventBus, ctx.logger */ },
  dispose() { /* cleanup optionnel */ },
};
```

- **Manifest** : validé au chargement par un schéma **zod** (`pluginManifestSchema`) — un manifest invalide fait échouer le plugin proprement (try/catch par plugin dans le loader), jamais l'app.
- **Routes** : injectées dans le `<Routes>` du host ; **menu** : rendu par `PluginMenu` (tri par `order`).
- **Contexte** (`init(ctx)`) : `api` (client REST partagé — le frontend ne parle jamais directement à Proxmox/InfluxDB), `eventBus`, `logger`. Les données temps réel transitent par le store WS du host (`core/data`).
- **Loader** : tableau statique d'imports explicites (`core/plugin/plugins.ts`) — pas de chargement dynamique asynchrone, chaque plugin est isolé par try/catch.

### Feature flags / Feature flags

Chaque plugin a un flag `VITE_USE_PLUGIN_<ID>` (défaut **ON**). Les flags sont des **disjoncteurs** : `=false` désactive proprement le module (écran de repli `ModuleDisabled`, pas de route morte) — utile en production si un plugin pose problème.

*Each plugin has a `VITE_USE_PLUGIN_<ID>` flag (default **ON**). The flags are circuit breakers: `=false` gracefully disables the module (fallback screen, no dead routes).*

```bash
VITE_USE_PLUGIN_STORAGE=false pnpm dev   # désactive le module stockage
```

### Ajouter un plugin / Adding a plugin

1. Créer `plugins/<id>/` avec `index.ts` (manifest + `init`) et les pages/composants du module.
2. L'ajouter au tableau `core/plugin/plugins.ts` (import explicite + gating par flag).
3. Déclarer le flag dans `core/config/features.ts`.
4. Les routes et l'entrée de menu sont automatiques (manifest).
