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
| Grille dashboard | `react-grid-layout` **^2.2.4** (drag/resize ; v2 API — voir piège RGL §10) |
| Graphe réseau | `@xyflow/react` (React Flow) |
| État | zustand (`store/theme`, `store/layout`, `store/user-config`, `core/data/dashboard`) |
| i18n | i18next + ressources dans `@proxmox/shared` (fr/en), persisté localStorage |
| Historique | InfluxDB 3 Core (**externe en prod**) — repli RRD Proxmox si pas de token |
| Licence | **Apache 2.0** (2026-11-19) — texte officiel dans `LICENSE` (racine), champ `license: Apache-2.0` dans les 4 package.json, section README ; copyright Jérôme ROBERT |

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
- Exemples livrés : `vm-view_v2` = v1 + bouton « Console web » (lien UI PVE) + détail nœud (voir skill `vm-inventory`) ; `hypervision_v2` (v0.2.0) = Vue d'ensemble en grille personnalisable (§12) ; `vm-view_v3` (v0.3.0) = monitors VM + nœud en grilles personnalisables (§12, voir skill `vm-inventory`) ; `hypervision_v3` (v0.3.0) = Vue d'ensemble + widget « Températures — par nœud » (voir skill `hypervision` §10) ; `vm-view_v4` (v0.4.0) = Monitor nœud + 6 widgets (températures chips/SMART, santé SMART, ZFS ARC, charge, swap — référence ProxMenux, voir skill `vm-inventory` §11).

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
│   │       └── modules/ #   dashboard/routes.ts, supervision/routes.ts, auth/ (§11),
│   │                  #   userconfig/ (perso. d'interface par user, §12), index.ts
│   └── web/             # Vite + React SPA
│       ├── public/      #   assets branding (favicon, images WebP — §5 Design system)
│       └── src/
│           ├── core/    #   plugin/ (contrat), api/, data/ (store WS), widgets/ (grilles
│           │            #   personnalisables, §12), config/features.ts, ui/
│           ├── plugins/ #   hypervision/ (+_v2,_v3), vm-view/ (+_v2,_v3,_v4), network/, storage/,
│           │            #   proxmox-inventory/, node-sensors/, centreon-nsca/  ← TOUT le métier
│           ├── components/  # layout/ (sidebar, topbar) + ui/ (design system)
│           ├── store/   #   theme.ts, layout.ts (grilles persistées v1), user-config.ts (§12)
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
| `/api/user-config` (GET/PUT/DELETE) | personnalisation d'interface **par user** (§12) — session requise, `userId` = session (jamais l'URL) |

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
- **Branding Prox4u (2026-11-14)** : assets WebP dans `packages/web/public/` (servis par Vite) — `favicon.png` + `apple-touch-icon.png` (emblème bouclier, alpha), `images/logo-emblem.webp` (emblème, alpha propre 256×256), `images/logo-wordmark.webp`, `images/robot-analyst.webp`, `images/robot-cosy-sidebar.webp` (480×480, image **en entier** — pas de recadrage). **Page de login** (`pages/login.tsx` + `components/auth/login-form.tsx`) : **split-screen** (formulaire à gauche + robot analyste `object-cover` à droite, masqué `< lg`), **mode sombre forcé localement** (classe `.dark` sur le wrapper — indépendant du thème utilisateur), bandeau **wordmark** en tête de carte (remplace l'ancienne icône Server indigo). **Sidebar** (`components/layout/sidebar.tsx`) : emblème sur **fond blanc** (`bg-white` — l'alpha seul est illisible sur fond sombre) + mascotte cosy complète sous le menu, au-dessus de LIVE. Sources PNG : `images/` à la racine du repo (commitées). La capture README (`docs/screenshots/login.png`) reflète ce nouveau login.

## 6. i18n
- Ressources dans `@proxmox/shared` (fr/en), initialisation `web/src/i18n.ts` ; langue persistée localStorage (`lang`), défaut `DEFAULT_LANG`.
- Préfixes de clés : `nav.*`, `overview.*`, `endpoint.*`, `node(s).*`, `kpi.*`, `metrics.*`, `health.*`, `risk.*`, `overcommit.*`, `alerts.*`, `topo.*`, `storage.*`, `vm.*`, `common.*`, `topbar.*`.
- Les alertes sont des clés i18n + paramètres (`messageKey`/`params`) — calculées côté serveur, traduites côté client.

## 7. Politique overcommit (source unique de vérité)
- `overcommit.json` à la racine du repo (hot-reload via `reloadOvercommitConfig`, poussée au web en WS).
- Defaults : `shared/overcommit.ts` → `DEFAULT_OVERCOMMIT_CONFIG` : usage warn 70 % / crit 90 %, `hostRamProvisionPct: 10`, CPU ok ≤ ×2 / warn ≤ ×4, échelles RAM/disque.
- Stockages thin : `THIN_STORAGE_TYPES = ['lvmthin','zfs','rbd']` (taille virtuelle > espace réel possible).
- **Hiérarchie iSCSI → LVM + dédoublonnage (inversé)** : une cible iSCSI (le **LUN**, volume physique de référence) sur laquelle reposent des VG LVM est remontée par PVE **deux fois** (datastore `iscsi` + datastore(s) `lvm` dont le champ `base` = « {iscsi}:… ») — c'est le **même volume**. `getStorage()` pose `duplicateOf` **sur le LUN** = la **liste** de ses VG enfants (helper pur **`iscsiHostVgs`**, plusieurs VG possibles) ; le LUN « utilisé » = **Σ tailles des VG (engagé)**, total = Σ VG = **borne basse**. Le poller **compte le LUN et exclut les VG enfants** (l'ensemble des valeurs `duplicateOf`) des sommes `storageTotalBytes`/`storageUsedBytes` — c'est l'**inverse** de l'ancien dédoublonnage (qui comptait le VG et écartait le LUN). Un LUN sans taille connue reste une borne basse ; `storage-volumes.json` (`lunSizes`) donne la vraie taille. **Ce dédoublonnage ne s'applique qu'aux sommes KPI** — les **séries d'occupation par datastore** (`datastore_metrics`, écrites par `writeInflux`) couvrent **toutes les vues à capacité connue, VG enfants compris** (le VG est la vue où sont les disques VM, son graphique est le plus utile) ; les y soustraire priverait les VG de tout historique (« aucun graphique »).
- **Cartographie stockage — `buildStorageVolumes(storages, alloc, config, lunSizes?)`** (fonction pure shared, testée) : construit l'**arbre iSCSI → LVM** (le LUN est le parent, ses VG LVM les enfants, un LUN peut porter plusieurs VG), capacité du LUN comptée **une fois** (`lunSizes[nom]` si connue sinon Σ VG = borne basse, `totalSource='lun'|'vg-sum'`), classe thin (sur-allocation) / thick (usage), et produit le **ratio disk correct** : sur-allocation = disques **sur thin** / capacité thin, **n/a si aucun disque sur un thin** (corrige le faux 916 %). Le poller en dérive `diskThinAllocatedBytes`/`diskThinTotalBytes` (KPI, en aplatissant l'arbre) et pousse `storageVolumes` dans le snapshot ; le panneau `/storage` « Volumes physiques » (skill `storage` §4B) le lit du snapshot WS (source unique, avec la config LUN).
- Fonctions pures : `computeOvercommit`, `usageSeverity`, `overcommitTone`, `riskSeverity`, `buildStorageVolumes`.

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
- **Fastify 5 : `return { statusCode: 400, … }` ne set PAS le code HTTP** (le body est renvoyé tel quel, status 200) — utiliser `reply.code(400).send(…)` (convention du codebase, ex. PUT sensor-thresholds).
- **Historique git** : repo poussé sur **`https://git.prox4u.com/prox4u/prox4u.git`** (remote `origin`, Gitea privé, token dans l'URL du remote ; branche `master`, auto-backups + commits explicites — le travail y est commité et poussé, ne plus écrire « non commité » dans les sections Fait). Aucun artefact sensible dans l'historique (`.env`, `clusters.json`, `data/` sont gitignorés). Détail complet (instance, tokens, cron backup, Gitea MCP, mirror GitHub public) : **skill `git`**.
- **Ne pas toucher `/home/opencode/projet/proxmox/`** (ancienne app, référence en lecture seule).
- **Double-comptage du SAN iSCSI/LVM (hiérarchie, dédoublonnage inversé)** : une cible iSCSI (le LUN) sur laquelle reposent des VG LVM est remontée par PVE **deux fois** (datastore `iscsi` + datastore(s) `lvm` dont le champ `base` = « {iscsi}:… ») — **même volume physique**. Le signal robuste n'est **pas** une heuristique de taille (total/used identiques) mais le **champ `base`** : le VG lvm pointe vers la cible iSCSI. `getStorage()` (prox4u-client) pose `duplicateOf` **sur le LUN** = la liste de ses VG enfants via le helper pur **`iscsiHostVgs`** (plusieurs VG possibles) ; le poller **compte le LUN** (capacité physique) et **exclut les VG enfants** (l'ensemble des valeurs `duplicateOf`) des sommes `storageTotalBytes`/`storageUsedBytes` — c'est l'**inverse** de la 1ʳᵉ version du correctif (qui comptait le VG et écartait le LUN). On ne réintroduit **ni** une heuristique « même total + même used = doublon » (fragile, faux sur du vrai matériel : deux baies identiques ≠ même volume) **ni** le dédoublonnage à l'envers (compter le VG + écarter le LUN) : le volume physique de référence est le **LUN**, le VG n'en est qu'une vue (et un LUN peut porter plusieurs VG).
- **react-grid-layout est en v2 (^2.2.4), pas 1.5** — la v2 API (`dragConfig`/`resizeConfig`/`gridConfig`) diffère de la v1 flat. **Sauvegarde fantôme** : RGL v2 rappelle `onLayoutChange` à TOUT changement de layout interne, y compris un **reflow de breakpoint** — toute variation de largeur du conteneur (ex. un panneau latéral inline qui ouvre) peut faire basculer lg(12 col) → md(8 col) : le layout 12 col est clampé/compacté vers 8 col et **enregistré** comme config user → grille décalée au reload. Double garde du socle (`core/widgets/widget-grid.tsx`) : (1) `breakpoint="lg"` **épinglé** (design 12 col, plus de reflow) ; (2) sauvegarde **uniquement** via `onDragStop`/`onResizeStop` (1ᵉʳ arg = layout final post-compaction), jamais sur `onLayoutChange` brut ; les changements parent-dressés (ajout/retrait/reset) appellent le store directement. Le type `Layout` est **`readonly LayoutItem[]`** (TS2345 si typé mutable).

## 11. Authentification & autorisation (portée de l'ancienne app)
- **Stack** : comptes locaux **argon2id** (npm `argon2` ^0.45.1 — Node 24 n'a pas d'argon2id natif), sessions **cookie httpOnly** `pvm_session` (TTL 12 h défaut, `AUTH_SESSION_TTL_HOURS`), rôles `admin | user`, groupes + visibilité par module.
- **État** : `data/auth.json` (gitignoré, chmod 600) — users/groups/modules/userGroups/userModules/groupModules. Seed au 1er démarrage : `admin`/`proX4u` avec changement forcé ; le store **réconcilie le catalogue au chargement, au niveau famille** (les entrées de version `<famille>_vN` d'une famille connue sont conservées, ainsi que leurs préférences). Le catalogue tient **une entrée par version** (v1 = id de famille, vN = `<famille>_vN`), chacune avec SON `globallyEnabled` — provisionnées par `syncModuleCatalog(ids)` via `PUT /api/auth/catalog-sync` (appelé au boot et après login depuis le web ; héritage de l'état de la famille, idempotent). Les préférences (`userModules`) peuvent viser une version précise (`<famille>_vN`) — validées par famille côté serveur.
- **Serveur** (`packages/server/src/modules/auth/`) : `store.ts` (persistance + réconciliation), `routes.ts` (`/api/auth/*` public = login uniquement ; `/api/admin/*` rôle admin ; throttle login 5 échecs/15 min → 429), `index.ts` (registerAuth, fastifyCookie, **guard en premier** : tout `/api/*` sauf `/api/auth/login` + `/api/health` exige une session).
- **WS protégé** : `ws-hub.attach(server, { verifyClient })` — rejet sans cookie de session valide ; le flux E2E Playwright doit donc d'abord faire un login HTTP pour obtenir le cookie.
- **Web** (`packages/web/src/`) : `store/auth.ts` (zustand — ne stocke que ce que le serveur autorise), `lib/auth-api.ts`, `core/plugin/catalog-sync.ts` (sync web→serveur au boot + après login), `pages/login|profile|admin`, `components/auth/*` (ProtectedRoute, ModuleRoute, forms), `components/admin/*` (user/group/catalog).
- **Visibilité des modules, par version** : le catalogue serveur tient une entrée par version ; une version est **autorisée** si activée globalement OU si sa famille est attribuée à un groupe de l'utilisateur ; **visible** = autorisée ∩ sélectionnée par son id EXACT. `authorizedModules` (`/me`) = entrées autorisées au niveau VERSION (`authorizedModuleEntries`) — les lignes de Mon profil → Modules, qui **ré-hydrate `/me` à chaque ouverture** de la rubrique (`ModuleSelector` → `refresh()` au mount) : un changement de catalogue admin s'y voit immédiatement, sans action préalable. `/me` renvoie aussi `visibleVersionIds` (ids exacts — filtre menu PluginMenu + versions rendues sur les routes partagées) et `visibleModuleIds` (familles dérivées — ModuleRoute + liste d'endpoints du sidebar, famille `hypervision`). Après un toggle admin, le store re-hydrate `/me` (sidebar à jour immédiatement).
- **Forçage mdp** : `mustChangePassword` → seule `/profile?tab=password` accessible jusqu'au changement.
- **Garde-fous admin** : un admin ne peut pas se désactiver ni se dégrader lui-même (UI + refus serveur `self-modification`).
- **Verrouillage de comptes (cadenas)** : bouton « Verrouiller / Déverrouiller » (icône cadenas `Lock`/`LockOpen`) dans *Administration → Utilisateurs* (`user-manager.tsx`) — patche `active: false`. Effets : login refusé en **403 `disabled`** (message « Compte verrouillé — contactez un administrateur ») **ET sessions actives invalidées immédiatement** (guard : `!user.active` → 401 `no-session` + session détruite au prochain appel API). État visible : badge « Verrouillé » (crit) dans la colonne État.
- **Comptes de test dédiés — RÈGLE : ne JAMAIS modifier les mots de passe des utilisateurs existants** (`admin`, `jerome`, …) pour tester. Les mdp sont hachés **argon2id (un seul sens)** et `data/auth.json` n'a **pas de backup** : un mdp écrasé pour un test est **perdu** (incident 2026-11-14 : les mdp d'origine d'`admin`/`jerome` ont été écrasés par des tests Playwright — irrécupérables). Pour toute vérification automatisée (Playwright/curl), utiliser :
  - **`test-admin`** — rôle `admin`, mdp `Prox4u-TestAdmin-2026`
  - **`test-user`** — rôle `user`, mdp `Prox4u-TestUser-2026`
  
  Les deux ont `mustChangePassword=false` (créés via `POST /api/admin/users` + flag passé à false dans `data/auth.json` + restart — `createUser` force `mustChangePassword=true`, sans endpoint pour le lever). Si un compte de test doit être recréé : même procédure. Le verrouillage cadenas sert aussi de **bac à sable** : on peut verrouiller `test-user` sans toucher aux comptes réels.
- **Throttle login (à connaître)** : 5 échecs / 15 min par identifiant → **429** « Trop de tentatives échouées » — compteur **en mémoire** du processus : un restart du service lève le blocage immédiatement (pas d'attente).

## 12. Personnalisation d'interface par utilisateur (grilles v2)

Chaque utilisateur personnalise les pages de graphiques (Vue d'ensemble `/` = `hypervision_v2`/`_v3`/`_v4`, **page cluster `/e/:endpointId` + page nœud `/e/:endpointId/n/:nodeId` = `hypervision_v4`** (scope `endpointView`/`nodePage`), onglets Monitor VM / Monitor nœud = `vm-view_v3`/`_v4` — les versions v3/v4 **partagent les mêmes scopes** que v2/v3 : un layout sauvegardé est commun aux versions d'une même page) : **drag/resize** des cartes, **retirer** (→ bibliothèque de la page, réinsérable), **réinitialiser** la disposition — **persisté par compte** côté serveur. Règle « présents ET futurs » : un widget ajouté au code apparaît en bas du layout (taille défaut) ; un widget retiré du code bascule dans la bibliothèque — jamais de layout cassé. Nom de la VM / du nœud en **sous-titre** de chaque carte ; données toujours fetchées par identifiants stables (vmid / nom de nœud), jamais par libellé.

- **Shared** (`packages/shared/src/user-config.ts`, 27 tests) : types `UserConfig { schemaVersion, pages, lastUpdated }`, `PageConfig { layout[], library[] }`, `WidgetItem { widgetId,x,y,w,h }` ; `parseUserConfig` (stricte → 400 `bad-config`) ; **`mergePageConfig`** = la règle ci-dessus + clamp (w 1..12, h 1..40) ; scopes ; `defaultStackLayout` (piles de largeur 12), `addWidget` (append en bas), `removeWidget` (→ `library`), `clearScopePage`.
- **Scopes** : `overview` = layout unique ; `vmView` = **`"<endpointId>/<vmid>"`** ; `nodeView` = **`"<endpointId>/<nomDuNœud>"`** (un renommage de nœud remet le layout à zéro — accepté, documenté) ; `endpointView` = **`"<endpointId>"`** (dashboard cluster, hypervision_v4) ; `nodePage` = **`"<endpointId>/<nomDuNœud>"`** (page nœud unifiée, hypervision_v4 — **catalogue distinct de `nodeView`** → scope séparé pour ne pas polluer les bibliothèques).
- **Serveur** (`modules/userconfig/`) : **un fichier par user** `data/user-configs/<userId>.json` (écriture atomique tmp+rename, corrompu → `null` au read) ; `GET/PUT/DELETE /api/user-config` — session obligatoire (guard global), `userId` = `req.authUser.id` (jamais de l'URL), aucun rôle requis.
- **Socle web** (`core/widgets/`) : `types.ts` (`CoreWidgetDef` = `WidgetDef` shared + `render`, `widgetIdFrom` libellé→id stable, `layoutsEqual`) ; `widget-grid.tsx` = `ResponsiveGridLayout` + **`WidgetFrame`** (handle drag `.drag-handle`, titre `<h3>` + sous-titre `<p>` VM/nœud, bouton retirer, slot `extra` ex. export CSV) ; `widget-library.tsx` (panneau latéral `w-64 inline` : retirés + « Afficher ») ; `widget-toolbar.tsx` (Bibliothèque + compteur, Réinitialiser avec confirmation, indicateur de sauvegarde du store) ; `customizable-page.ts` (drapeau zustand — masque le bouton de reset v1 de la topbar quand une page personnalisable est montée, cf. statut de `useLayout`) ; `export-csv-button.tsx`.
- **Store web** (`store/user-config.ts`, zustand) : load au boot ; **PUT débordé 800 ms + flush `pagehide` (keepalive)** ; flag `dirty` garde contre le load tardif ; `updatePage`/`clearPage`/`resetAll` ; invalidation multi-onglets.
- **Garde RGL v2 (cf. piège §10)** : `breakpoint="lg"` épinglé + sauvegarde uniquement sur `onDragStop`/`onResizeStop` ; le parent garde `layoutsEqual` en backstop (drop sans déplacement).
- **Pages** : `hypervision_v2/pages/overview.tsx` (catalogue 12 widgets, dont `ep-<endpoint>` dynamiques) ; `vm-view_v3/components/{vm,node}-monitor.tsx` (catalogues dynamiques `diskio-<device>`, `fs-<mountpoint>`, `net-<iface>`, `netif-<iface>` — les ids sont stables pendant la refetch grâce à un gate `ready` qui garde les données en cours) ; `hypervision_v3/pages/overview.tsx` (+ widget `temp-nodes`, §10 skill `hypervision`) ; `vm-view_v4/components/node-monitor.tsx` (+ 6 widgets jauges hôte, §11 skill `vm-inventory`) ; **`hypervision_v4/pages/{endpoint,node}.tsx`** (page cluster 20 widgets — 17 blocs + 3 métriques unitaires CPU/RAM/réseau — scope `endpointView` + page nœud unifiée KPIs/table/graphiques scope `nodePage` — §11 skill `hypervision`). Les corps de carte sont des composants réutilisables exportés (`CpuCoresBody`, `NodeSystemStatsGrid`, `FwDecodeBlock`…) — la frame fournit l'en-tête, le corps remplit la cellule (`min-h` + `flex-1`, ECharts ResizeObserver). Détail par skill : `hypervision` (overview v2/v3) et `vm-inventory` (monitors v3/v4).
- **Piège `mergePageConfig` (nouvel utilisateur)** : `mergePageConfig(null, …)` renvoie **uniquement le `defaultLayout`** — l'ajout des widgets manquants du catalogue (règle « présents ET futurs ») ne s'exécute que quand un layout est **déjà sauvegardé** (`stored` non nul). Conséquence : un widget absent du `defaultLayout` est **invisible pour un nouvel utilisateur** tant qu'il n'a rien sauvegardé. Deux écoles selon la page : le Monitor nœud/VM construit son default layout **depuis le catalogue** (`defaultStackLayout(catalog)` — tout y figure, aucun problème) ; la Vue d'ensemble a un default layout **codé en dur** (design validé) → un widget d'une nouvelle version doit être **ajouté dans `overviewDefaultLayout` de cette version** (fichier local au plugin), sinon il n'apparaît que pour les users ayant un layout sauvegardé (skill `hypervision` §10).
- **Piège REBUILD SHARED + RESTART SERVEUR (règle générale, bug rencontré)** : le serveur (et le web) consomment `@prox4u/shared` **depuis le dist** (`main: ./dist/index.js`), chargé **au démarrage** (pas de hot-reload). Après TOUT changement de `packages/shared/src/` : (1) `pnpm --filter @prox4u/shared build` (rebuild du dist — sinon le typecheck web échoue sur les nouveaux types), (2) **redémarrer le serveur en cours** (sinon il garde l'ancien code en mémoire). Symptôme typique sur user-config : l'ancien `parseUserConfig` **jette silencieusement** une clé de page inconnue (ex. `endpointView` ajoutée sans restart) → le PUT a le bon corps mais le serveur répond `pages: {}` vide → le client adopte la réponse vide (`saveNow` → `set({ config: res.config })`) → la grille repasse aux défauts. (Rappel : les sessions auth sont **en mémoire** → un restart du serveur déconnecte tout le monde, re-login.)
