---
name: general
description: Base de connaissance générale de Prox4u — architecture plugin (host/loader/registry), monorepo, flux de données Proxmox→poller→InfluxDB→API/WS, design system, i18n, politique overcommit, déploiement. Use when working on the proxmox-plugin-arch project overall, the plugin host, adding a new plugin, the server (poller, InfluxDB, REST API, WebSocket), the design system, i18n, overcommit policy, or deployment.
---

# Prox4u — Base de connaissance générale

Application web d'**hypervision multi-endpoints** pour Proxmox VE : dashboard vCenter-like pour managers/DSI (KPIs, Health Score, PRA N-1, capacity planning, surallocation) + supervision (topologie réseau, inventaire stockage). Cible : managers et DSI → impact visuel, synthèse, code couleur, zéro log « ingénieur » à l'écran d'accueil.

**Architecture plugin** : le host est minimal (routing, menu, données WS, design system) ; tout le métier vit dans des plugins auto-contenus sous `packages/web/src/plugins/`.

> Ce skill couvre l'**architecture globale et les conventions transverses**. Chaque module a son skill dédié : `hypervision`, `network`, `storage`, `vm-inventory`.

## 1. Stack validée (ne pas changer sans accord utilisateur)

| Couche | Choix |
|---|---|
| Monorepo | pnpm workspaces — `packages/shared` (TS pur, testé), `packages/server` (Fastify), `packages/web` (Vite+React) |
| Backend | Node 20 + Fastify + TypeScript strict, WebSocket (`ws`), undici, zod |
| Frontend | Vite + React 18 SPA + TypeScript strict, Tailwind CSS, composants style shadcn/ui (`components/ui/`) |
| Graphiques | ECharts (hook `hooks/use-echart.ts` + thème `lib/chart-theme.ts`) |
| Grille dashboard | `react-grid-layout` (drag/resize, persistée) |
| Graphe réseau | `@xyflow/react` (React Flow) |
| État | zustand (`store/theme`, `store/layout`, `core/data/dashboard`) |
| i18n | i18next + ressources dans `@proxmox/shared` (fr/en), persisté localStorage |
| Historique | InfluxDB 3 Core (**externe en prod**) — repli RRD Proxmox si pas de token |

## 2. Architecture plugin (cœur de l'app)

### 2.1 Contrat — `packages/web/src/core/plugin/types.ts`
- `PluginManifest` : `{ id, name, version, routes?, menu?, dependencies? }`, validé par **zod** (`pluginManifestSchema`). L'id suit `PLUGIN_ID_RE` (shared) : minuscules/chiffres/tirets + suffixe `_vN` optionnel (§2.5).
- `PluginRoute` : `{ path, element }` — injectée dans le `<Routes>` du host.
- `PluginMenuItem` : `{ id, to, labelKey, icon?, order? }` — entrée sidebar (tri par `order`, défaut 100).
- `PluginContext` : `{ api, eventBus, logger }` — client API partagé (`core/api/apiClient`), bus d'événements inter-plugins typé, logger dédié `[plugin:<id>]`.
- `Plugin` : `{ manifest, init(ctx), dispose?, Component? }`.

### 2.2 Câblage du host
- **Bootstrap** (`main.tsx`) : `loadPlugins(PLUGINS, createPluginContext())` s'exécute **avant le premier rendu** ; le registry est ensuite statique.
- **Loader** (`core/plugin/loader.ts`) : les plugins sont **groupés par famille** (`groupPluginFamilies`, shared) ; **toutes les versions sont initialisées** — validation zod du manifeste → enregistrement → dépendances (famille requise = une version de la famille initialisée) → `init(ctx)` dans un try/catch. La version la plus récente de chaque famille (`defaultPluginVersion(famille, ids)`) passe en statut `active` (canonique) ; les autres en `available` (A/B + rollback). Un échec marque le plugin `failed` et **le host continue** (ne plante jamais).
- **Registry** (`core/plugin/registry.ts`) : singleton, statuts `registered | active | available | failed`. `active()` = version canonique de chaque famille (la plus récente) ; `initialized()` = canoniques + disponibles (A/B) — c'est cette liste qui alimente routes et menu.
- **Routes + menu** (`app.tsx`, `core/ui/PluginMenu.tsx`, `core/ui/VersionSwitch.tsx`) : la sidebar est 100 % fournie par les plugins, **une entrée par version visible pour l'utilisateur** (autorisée ∩ sélectionnée — `visibleVersionIds` du `/me`, §11 ; badge `vN` — v1 neutre, vN+ accentué). La version canonique (la plus récente) porte le lien canonique (`/vms`) ; les autres pointent vers `?v=<id de plugin>` et la route est un `VersionSwitch` qui rend la version demandée (défaut = canonique) — comparaison A/B sans changer l'URL canonique. Chaque famille est enveloppée dans un `ModuleRoute` (familles visibles = dérivées des versions visibles) ; sur une route multi-versions, seules les versions visibles sont rendues. Les routes de repli rendent `ModuleDisabled` (feature flag OFF).
- **Extension point** (`core/ui/PluginSlot.tsx`) : rend le `Component` d'un plugin actif ou un fallback.
- **Event bus** (`core/plugin/eventBus.ts`) : interface typée `PluginEvents` (**volontairement vide pour l'instant**) ; y ajouter les événements transverses quand deux plugins en ont besoin. Un handler en échec est loggé sans bloquer les autres.

### 2.3 Feature flags (disjoncteurs) — `core/config/features.ts`
- `VITE_USE_PLUGIN_HYPERVISION`, `VITE_USE_PLUGIN_NETWORK`, `VITE_USE_PLUGIN_STORAGE`, `VITE_USE_PLUGIN_VM_INVENTORY` — **défaut ON** (`!== 'false'`), opt-out.
- Flag OFF → module proprement désactivé : pas d'entrée de menu, pas de route morte, écran `ModuleDisabled`.
- Usage : `VITE_USE_PLUGIN_STORAGE=false pnpm dev`.

### 2.4 Ajouter un nouveau plugin (workflow)
1. Créer `packages/web/src/plugins/<id>/` : `index.ts` (manifest + `init`), `pages/`, `components/`. **Chaque page respecte la convention titre de page** (§5) : `h1` à gauche + ligne d'aide.
2. Manifest : id stable (`PLUGIN_ID_RE`), version semver, routes, menu (`labelKey` = clé i18n à ajouter dans `@proxmox/shared`).
3. L'inscrire dans `core/plugin/plugins.ts` + ajouter le flag `VITE_USE_PLUGIN_<ID>` dans `features.ts`.
4. Données : utiliser `ctx.api` (client REST partagé) et le store WS du host (`core/data`) — ne jamais ouvrir son propre WebSocket.
5. Valider : typecheck + tests + A/B Playwright vs version précédente.

### 2.5 Versionnement des modules (règle `_vN`)
**Toute modification d'un module existant crée un NOUVEAU plugin `<id>_vN+1` — on ne modifie jamais une version en place.** La v1 reste intacte = rollback immédiat.

- **Famille** : id sans le suffixe `_vN` (`vm-inventory_v2` → famille `vm-inventory`, v1 = id sans suffixe). Fonctions pures testées dans `@proxmox/shared` (`module-versions.ts`) : `parsePluginVersion`, `defaultPluginVersion`, `groupPluginFamilies`, regex `PLUGIN_ID_RE`.
- **Toutes les versions sont disponibles, sans activation admin** (décision utilisateur 2026-10-25) : la version la plus récente de chaque famille est la version canonique par défaut sur l'URL partagée (règle calculée, rien à configurer ni à persister) ; les versions antérieures restent accessibles dans le menu et via `?v=<id>`. Le catalogue admin (**Administration → Catalogue des modules**) liste une carte par version (badge `vN` + semver) — **ni tag « Active » ni bouton « Activer »**. Le toggle « pour tout le monde » est **par version** : le catalogue serveur tient une entrée par version (v1 = id de famille, vN = `<famille>_vN`), chacune avec SON `globallyEnabled` — activer v1 n'a aucun effet sur v2. Les entrées de version sont provisionnées par **sync web→serveur** (`PUT /api/auth/catalog-sync`, appelée au boot et après login ; le serveur ne connaît pas les versions, seul le registry web le sait) : héritage de l'état de la famille, idempotent.
- **Workflow de modification d'un module** :
  1. Copier `plugins/<id>/` → `plugins/<id>_vN+1/` (ex. `vm-inventory` → `vm-inventory_v2`).
  2. Adapter le manifest : `id: '<id>_vN+1'`, bump de la version semver ; routes/menu identiques (même famille = même surface).
  3. L'inscrire dans `core/plugin/plugins.ts` **côte à côte** avec les versions précédentes (même feature flag de famille).
  4. Développer + valider (typecheck, tests, A/B navigateur) — les versions précédentes restent disponibles en prod pendant tout le développement.
  5. À la mise en prod, la nouvelle version devient **automatiquement canonique** (la plus récente) sur l'URL partagée ; les versions précédentes restent accessibles via `?v=<id>` et le menu (rollback = naviguer vers la version précédente).
- **Comparaison A/B dans la sidebar** : chaque version d'une famille est une entrée du menu de gauche avec son badge `vN` — l'utilisateur choisit quelles versions voir dans **Mon profil → Modules** (une case par version) ; bascule à la volée via `?v=<id>`. La version canonique (la plus récente) est la référence : lien canonique, défaut du `VersionSwitch`, cible des deep-links.
- **Les routes respectent la sélection du profil** (`app.tsx`) : sur une route multi-versions, seules les versions SÉLECTIONNÉES sont rendues — « cocher la V1 et non la v2 » → `/vms` sert la v1 (défaut = canonique si sélectionnée, sinon première sélectionnée) ; un `?v=` pointant vers une version non sélectionnée retombe sur le défaut.
- **Feature flags restent au niveau famille** (disjoncteur env, pas par version).
- Exemple livré : `vm-inventory_v2` = v1 + bouton « Console web » (lien UI PVE, voir skill `vm-inventory`).

## 3. Arborescence monorepo

```
proxmox-plugin-arch/
├── packages/
│   ├── shared/          # TS pur : types, i18n (fr/en), fonctions pures testées
│   │   └── src/         #   types.ts, overcommit.ts, network.ts, storage-inventory.ts, i18n/…
│   ├── server/          # Fastify : poller multi-endpoints, InfluxDB, API REST + WS
│   │   └── src/
│   │       ├── core/    #   poller.ts, influx.ts, influx-consolidator.ts, proxmox-client.ts,
│   │       │            #   mock-source.ts, data-source.ts, ws-hub.ts, config.ts
│   │       └── modules/ #   dashboard/routes.ts, supervision/routes.ts, index.ts
│   └── web/             # Vite + React SPA
│       └── src/
│           ├── core/    #   plugin/ (contrat), api/, data/ (store WS), config/features.ts, ui/
│           ├── plugins/ #   hypervision/, network/, storage/, vm-inventory/  ← TOUT le métier
│           ├── components/  # layout/ (sidebar, topbar) + ui/ (design system)
│           ├── store/   #   theme.ts, layout.ts (grilles persistées)
│           ├── hooks/ lib/  # use-echart, chart-theme, utils
│           └── app.tsx main.tsx i18n.ts
├── skills/              # bases de connaissance (trackées, livrées en prod) ← ce dossier
├── deploiement/         # scripts + DEPLOY.md + unit systemd
├── server.sh up.sh      # démarrage service / démarrage complet local
├── docker-compose.yml   # influxdb + explorer (DEV LOCAL uniquement)
└── .env                 # gitignoré — réglé au déploiement
```

## 4. Flux de données

### 4.1 Serveur (`packages/server`)
- `index.ts` : charge la config (`clusters.json` multi-endpoints, ou env `PVE_URL` si absent = 1 endpoint), crée par endpoint un `ProxmoxClient` (cluster réel) ou `MockSource` (démo déterministe), `InfluxClient`, `InfluxConsolidator`, `Poller`, `WsHub` ; enregistre les modules (`modules/index.ts` : dashboard, supervision).
- **Poller** (`core/poller.ts`) : tick 5 s par endpoint → API PVE (cluster/resources, statut nœuds, RRD, réseau, stockage, config VMs) → fonctions pures `@proxmox/shared` (KPIs, Health Score, PRA, alertes) → écriture InfluxDB + broadcast WS. Un endpoint en échec ne bloque pas les autres (`ok: false, error`).
- **InfluxDB** (`core/influx.ts`) : client HTTP InfluxDB 3 Core, line protocol par lots (200 lignes / file 1000 / coalescence 25 ms). `INFLUX_TOKEN` vide → désactivé, **repli RRD Proxmox**. Le mode mock n'écrit jamais.
- **Consolidator** (`core/influx-consolidator.ts`) : agrégations raw → base consolidée (5 min par nœud/VM, dont `node_net` et `storage_metrics`).

### 4.2 Mesures InfluxDB (base raw)
| Mesure | Tags | Champs |
|---|---|---|
| `storage_metrics` | cluster | used_bytes, total_bytes — **stockage VM au niveau endpoint** (série de référence des graphiques « Disque », pondérée par capacité à la lecture) |
| `node_metrics` | cluster, node | cpu_pct, ram_pct, disk_pct (rootfs) — **sans net depuis PVE ≥ 9** (voir piège §4.6) |
| `node_net` | cluster, node | net_in_bps, net_out_bps (bits/s) — trafic nœud = **somme des VMs en marche** (PVE 9 ne renvoie plus netin/netout dans `/nodes/{n}/status`) |
| `vm_metrics` | cluster, node, vmid, name | cpu_pct, mem_bytes (VMs running uniquement) |

### 4.3 API REST (cache 5 min pour les endpoints lourds)
| Endpoint | Rôle |
|---|---|
| `/api/health` | healthcheck (server.sh) |
| `/api/dashboard` | snapshot multi-endpoints initial (repli WS) |
| `/api/capacity?endpoint=` | capacity planning + prévision (`buildForecast`) |
| `/api/trends?endpoint=` | tendances 7 j + répartition OS |
| `/api/metrics?timeframe=&endpoint=` | historique (hour/day/week/month) — InfluxDB ou repli RRD ; disque = `storage_metrics` pondérée Σused/Σtotal, `null` si bucket sans série, repli rootfs seulement si la série est absente au total |
| `/api/overcommit-risk?endpoint=` | risque dynamique (pire cas p95 7 j) |
| `/api/network-topology?endpoint=` | topologie réseau auto-découverte (supervision) |
| `/api/storage-inventory?endpoint=` | inventaire stockage → VMs (supervision) |

### 4.4 WebSocket + store web
- `WsHub` (`/ws`) : pousse `{type:'snapshot', data: MultiDashboardSnapshot}` toutes les 5 s + un au connect.
- `core/data/use-snapshot-stream.ts` : WS avec reconnexion exponentielle (1 s → 30 s max).
- **Store** `core/data/dashboard.ts` (zustand) : `multi` (snapshot courant), `wsConnected`, par endpoint : `capacity`, `trends`, `risk`, `spark` (ring buffer 60 pts ≈ 5 min) ; actions `loadHeavy(id)`, `loadRisk(id)` (au montage puis toutes les 5 min).
- Hooks (`core/data/use-endpoint.ts`) : `useMulti()`, `useEndpoint(id?)`, `useOvercommitConfig()` (overcommit.json poussée en WS, defaults avant le 1er push).

### 4.5 InfluxDB en production = service externe
- **Décision actée** : l'app pointe sur un InfluxDB déjà en production via `INFLUX_URL` (+ `INFLUX_TOKEN`, `INFLUX_CA_CERT`) dans `.env` (gitignoré, réglé au déploiement). **Ne pas déployer/pousser InfluxDB avec l'app.**
- `docker-compose.yml` (influxdb 3.11.5-core + explorer) = dev local uniquement.
- Après pointage prod : la courbe « Disque » s'accumule depuis le 1er tick (historique `storage_metrics` à zéro ; 7 jours pour une vue complète).

### 4.6 Pièges InfluxDB 3 Core (vérifiés sur 3.11.5)
- **Pas de DELETE** (« DML not supported: Delete ») : les lignes ne se corrigent pas, on change de mesure ou on cesse de lire le champ concerné (ex. `node_metrics` historique à net=0 → réseau lu depuis `node_net`).
- **`--query-file-limit` défaut 432** ≈ 72 h de données (1 fichier Parquet / 10 min / table) : toute requête 30 j échoue (`Query would scan N Parquet files, exceeding the file limit`). Le service InfluxDB doit démarrer avec `--query-file-limit=10000` (dans `docker-compose.yml`).
- **`cluster` = mot-clé DuckDB** : en SELECT/GROUP BY il faut `"cluster"` avec guillemets (nu → `ParserError`) ; à l'intérieur d'un appel de fonction (`COALESCE(cluster, …)`) ça passe.
- **Écritures à timestamps anciens + recreate du conteneur** : les points non encore snapshotés dans Parquet peuvent être perdus au `docker compose up -d` (WAL). Après un backfill, ne pas recréer le conteneur InfluxDB ; vérifier la persistance avant de considérer le backfill terminé.
- **Rétention raw 31 j** : les points écrits avec un timestamp > 31 j sont purgés — l'historique long vit dans `consolidated` (∞) via le consolidateur, pas dans raw.

## 5. Design system
- Thème dark/light (zustand persisté `proxmox-theme`, classe `.dark` sur `<html>`, appliqué avant le premier rendu — pas de flash).
- Tokens Tailwind : sévérités `bg-ok` / `bg-warn` / `bg-crit`, `primary`, `muted-foreground`, `secondary`… ; sévérité `ok | warn | crit | na`.
- Composants style shadcn/ui dans `components/ui/` (Card, Badge, Table, Progress…) ; en-têtes de Card draggables via la classe `.drag-handle`.
- ECharts : thème `lib/chart-theme.ts`, hook `use-echart` (init/dispose).
- Formatage : `formatBytes`, `formatUptime`, `cn` (`lib/utils.ts`).
- **Convention titre de page (obligatoire)** : **chaque page a un titre `h1` aligné à gauche** en tête de contenu — `<h1 className="text-lg font-semibold tracking-tight">{t('…')}</h1>` — **suivi d'une ligne d'aide (commentaire)** `<p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t('…hint')}</p>` qui décrit ce que montre la page. Les **pages de détail** (endpoint, nœud…) ajoutent un **bouton retour (←)** à gauche du titre. Toute nouvelle page/plugin doit respecter ce pattern (rappelé dans le workflow « ajouter un plugin » §2.4).

## 6. i18n
- Ressources dans `@proxmox/shared` (fr/en), initialisation `web/src/i18n.ts` ; langue persistée localStorage (`lang`), défaut `DEFAULT_LANG`.
- Préfixes de clés : `nav.*`, `overview.*`, `endpoint.*`, `node(s).*`, `kpi.*`, `metrics.*`, `health.*`, `risk.*`, `overcommit.*`, `alerts.*`, `topo.*`, `storage.*`, `vm.*`, `common.*`, `topbar.*`.
- Les alertes sont des clés i18n + paramètres (`messageKey`/`params`) — calculées côté serveur, traduites côté client.

## 7. Politique overcommit (source unique de vérité)
- `overcommit.json` à la racine du repo (hot-reload via `reloadOvercommitConfig`, poussée au web en WS).
- Defaults : `shared/overcommit.ts` → `DEFAULT_OVERCOMMIT_CONFIG` : usage warn 70 % / crit 90 %, `hostRamProvisionPct: 10`, CPU ok ≤ ×2 / warn ≤ ×4, échelles RAM/disque.
- Stockages thin : `THIN_STORAGE_TYPES = ['lvmthin','zfs','rbd']` (taille virtuelle > espace réel possible).
- Fonctions pures : `computeOvercommit`, `usageSeverity`, `overcommitTone`, `riskSeverity`.

## 8. Déploiement & opérations
- `.env` (gitignoré) — voir `.env.example` : credentials/token PVE, `MOCK`, `PORT=8080`, InfluxDB (`INFLUX_URL/TOKEN/RAW_DB/AGG_DB`), TLS.
- `server.sh {start|stop|restart|status}` : service applicatif (logs `logs/`, PID file ; HTTPS si `TLS_CERT` défini).
- `up.sh` : démarrage complet local (InfluxDB Docker + app).
- `deploiement/` : `10-proxmox-token.sh`, `20-package-release.sh`, `30-env-setup.sh`, `40-tls-init.sh`, `50-influxdb-init.sh`, `DEPLOY.md`, unit systemd `prox4u.service`.
- `clusters.json` (gitignoré) : config multi-endpoints ; absent → 1 endpoint via `PVE_URL`.

## 9. Build / test / typecheck
- `pnpm install` à la racine ; **build `@proxmox/shared` avant le typecheck web** (`dist/` gitignoré).
- Typecheck : `pnpm exec tsc -b --noEmit` · Build : `pnpm build` · Tests : `pnpm test` (vitest, à la racine).

## 10. Pièges transverses
- **Clé i18n absente → la clé brute s'affiche** : le web importe les ressources i18n depuis le **`dist` buildé** de `@proxmox/shared`, pas la source. Après ajouter/modifier une clé dans `packages/shared/src/i18n/`, **il faut rebuild du shared** (`pnpm --filter @proxmox/shared build`) puis rebuild web, sinon l'UI affiche la clé brute (ex. `overview.hint`) au lieu de la traduction. Le typecheck ne détecte pas une clé manquante (les `t('…')` sont des chaînes libres).
- **Horodatages InfluxDB** : l'API renvoie l'UTC en ISO sans fuseau → forcer le `Z` avant `Date.parse` (`influxTsToUnix`).
- **Sémantique disque** : `storage_metrics` (stockage VM, pondéré) ≠ `disk_pct` (rootfs nœud, santé nœud). Bucket sans série → `null` (gap ECharts), ne pas mélanger avec le rootfs ; la vue nœud (`?node=`) est exclue de la fusion.
- **Feature flags opt-out** : défaut ON ; OFF = désactivation propre (pas de code mort).
- **`.opencode/` est gitignoré** — outils d'agent locaux ; les bases de connaissance vivent dans `skills/` à la racine (trackées, livrées en prod).
- **Historique git** : sources destinées à un GitHub public → aucun artefact sensible dans l'historique (`.env`, `clusters.json`, `data/` sont gitignorés).
- **Ne pas toucher `/home/opencode/projet/proxmox/`** (ancienne app, référence en lecture seule).

## 11. Authentification & autorisation (portée de l'ancienne app)
- **Stack** : comptes locaux **argon2id** (npm `argon2` ^0.45.1 — Node 24 n'a pas d'argon2id natif), sessions **cookie httpOnly** `pvm_session` (TTL 12 h défaut, `AUTH_SESSION_TTL_HOURS`), rôles `admin | user`, groupes + visibilité par module.
- **État** : `data/auth.json` (gitignoré, chmod 600) — users/groups/modules/userGroups/userModules/groupModules. Seed au 1er démarrage : `admin`/`proX4u` avec changement forcé ; le store **réconcilie le catalogue au chargement, au niveau famille** (les entrées de version `<famille>_vN` d'une famille connue sont conservées, ainsi que leurs préférences). Le catalogue tient **une entrée par version** (v1 = id de famille, vN = `<famille>_vN`), chacune avec SON `globallyEnabled` — provisionnées par `syncModuleCatalog(ids)` via `PUT /api/auth/catalog-sync` (appelé au boot et après login depuis le web ; héritage de l'état de la famille, idempotent). Les préférences (`userModules`) peuvent viser une version précise (`<famille>_vN`) — validées par famille côté serveur.
- **Serveur** (`packages/server/src/modules/auth/`) : `store.ts` (persistance + réconciliation), `routes.ts` (`/api/auth/*` public = login uniquement ; `/api/admin/*` rôle admin ; throttle login 5 échecs/15 min → 429), `index.ts` (registerAuth, fastifyCookie, **guard en premier** : tout `/api/*` sauf `/api/auth/login` + `/api/health` exige une session).
- **WS protégé** : `ws-hub.attach(server, { verifyClient })` — rejet sans cookie de session valide ; le flux E2E Playwright doit donc d'abord faire un login HTTP pour obtenir le cookie.
- **Web** (`packages/web/src/`) : `store/auth.ts` (zustand — ne stocke que ce que le serveur autorise), `lib/auth-api.ts`, `core/plugin/catalog-sync.ts` (sync web→serveur au boot + après login), `pages/login|profile|admin`, `components/auth/*` (ProtectedRoute, ModuleRoute, forms), `components/admin/*` (user/group/catalog).
- **Visibilité des modules, par version** : le catalogue serveur tient une entrée par version ; une version est **autorisée** si activée globalement OU si sa famille est attribuée à un groupe de l'utilisateur ; **visible** = autorisée ∩ sélectionnée par son id EXACT. `authorizedModules` (`/me`) = entrées autorisées au niveau VERSION (`authorizedModuleEntries`) — les lignes de Mon profil → Modules, qui **ré-hydrate `/me` à chaque ouverture** de la rubrique (`ModuleSelector` → `refresh()` au mount) : un changement de catalogue admin s'y voit immédiatement, sans action préalable. `/me` renvoie aussi `visibleVersionIds` (ids exacts — filtre menu PluginMenu + versions rendues sur les routes partagées) et `visibleModuleIds` (familles dérivées — ModuleRoute + liste d'endpoints du sidebar, famille `hypervision`). Après un toggle admin, le store re-hydrate `/me` (sidebar à jour immédiatement).
- **Forçage mdp** : `mustChangePassword` → seule `/profile?tab=password` accessible jusqu'au changement.
- **Garde-fous admin** : un admin ne peut pas se désactiver ni se dégrader lui-même (UI + refus serveur `self-modification`).
