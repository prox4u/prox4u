---
name: hypervision
description: Base de connaissance du plugin Hypervision de Prox4u — vue d'ensemble du parc multi-endpoints, détail endpoint (dashboard 17 blocs), détail nœud ; KPIs, graphiques ressources 7 jours (dont stockage VM), Health Score, PRA N-1, capacity planning, surallocation, alertes ; hypervision_v2 = vue d'ensemble en grille personnalisable par user (drag/resize/bibliothèque, persistance /api/user-config) ; hypervision_v3 = + widget « Températures — par nœud » (max capteurs + max disques SMART, live /api/node-sensors) ; hypervision_v4 = bibliothèque de graphiques étendue à TOUTES les pages (page cluster 17 blocs + page nœud unifiée KPIs/table VMs/graphiques, KPIs et table aussi déplaçables/retraitables, réemploi cross-plugin des corps du Monitor nœud vm-view_v4) + graphiques métriques unitaires du cluster (CPU / RAM / Réseau — 1 série, export CSV) et tooltip date/heure (et non timestamp unix brut) + page nœud : cartes « Détails hôte » (identification hôte + matériel CPU/DMI via /api/node-hardware) et « Capacité et utilisation » (barres used vs capacité CPU/Mémoire/Stockage) + vue d'ensemble production multi-clusters : sélecteur de cluster sur les 3 graphiques 7 j (« Tous les clusters »/[cluster] — courbes, valeur courante et ligne d'allocation suivent le cluster, /api/metrics?endpoint= déjà supportée, 100 % frontend) + carte « Nœuds — tous les clusters » (matrice : une ligne par nœud groupés par cluster, État/CPU/RAM/Disque/VMs, teintes usageSeverity overcommit.json, clic → page nœud, snapshot WS zéro API). Use when working on the hypervision plugin (packages/web/src/plugins/hypervision/, hypervision_v2/, hypervision_v3/ ou hypervision_v4/), the /, /e/:endpointId or /e/:endpointId/n/:nodeId routes, or its components (resource-chart, kpi-row, metrics-panel, pra-panel, capacity-chart, overcommit-card, system-nodes-card, temp-nodes-card, node-widgets…).
---

# Hypervision — Base de connaissance

Plugin principal de Prox4u : **vue d'ensemble du parc** (multi-endpoints), **détail endpoint**, **détail nœud**. Migrated from legacy (Strangler Fig, étape 2).

> Architecture globale (contrat plugin, flux de données, design system) : voir le skill `general`.

## 1. Manifest (`index.tsx`)
- id `hypervision`, version 0.1.0, aucune dépendance.
- Routes : `/` → OverviewPage · `/e/:endpointId` → EndpointPage · `/e/:endpointId/n/:nodeId` → NodePage.
- Menu : `nav.overview` (icône LayoutDashboard), order 10 — première entrée de la sidebar. **Porte le sous-menu Proxmox** : `submenu: <ProxmoxNavTree />` (arbre endpoints→nœuds, replié par défaut, chevron dédié) + `statusDot: EndpointFleetDot` (pastille de santé agrégée de tous les endpoints, visible même repliée). L'ancienne section « PROXMOX » du sidebar a été supprimée — l'arbre vit maintenant sous « Vue d'ensemble ».
- `init()` : log uniquement (les données transitent par le store WS du host + le client API partagé).
- **Le manifest est en `.tsx`** (pas `.ts`) : il contient du JSX (`submenu: <ProxmoxNavTree />`). Renommé depuis `index.ts` quand le sous-menu a été ajouté — l'import par dossier (`import … from '../../plugins/hypervision'`) sans extension est sans impact.

## 2. Arborescence (18 fichiers)
```
hypervision/
├── index.tsx                    # manifest (JSX : submenu + statusDot) + init
├── pages/
│   ├── overview.tsx             # vue d'ensemble multi-endpoints (titre + grille dynamique)
│   ├── endpoint.tsx             # détail cluster : titre + retour + dashboard 17 blocs
│   └── node.tsx                 # détail nœud : titre + stats, métriques, VMs
└── components/                  # 13 fichiers
    ├── proxmox-nav-tree.tsx     # ProxmoxNavTree (sous-menu sidebar) + EndpointFleetDot (pastille agrégée)
    ├── resource-chart.tsx       # graphiques ressources 7 j (ECharts)
    ├── kpi-row.tsx              # exporte 5 composants : Sparkline, KpiNodesCard,
    │                            #   KpiCpuRamCard, KpiStorageCard, KpiVmsCard
    ├── metrics-panel.tsx        # historique par timeframe (+ scope nœud)
    ├── health-gauge.tsx         # jauge Health Score
    ├── pra-panel.tsx            # PRA N-1 par site
    ├── capacity-chart.tsx       # prévision de capacité
    ├── storage-card.tsx         # stockage + barres d'usage
    ├── network-card.tsx         # trafic cluster rx/tx + spark
    ├── alerts-list.tsx          # alertes endpoint
    ├── top-consumers.tsx        # top VMs + pools
    ├── nodes-table.tsx          # nœuds (sévérité, lien détail)
    ├── overcommit-card.tsx      # rapport surallocation + risque dynamique
    └── system-nodes-card.tsx    # carte « Système — par nœud » (cross-node, Telegraf)
```

## 3. OverviewPage (`/`) — parc multi-endpoints
- **Titre de page** (convention §5 du skill `general`) : `h1` « Vue d'ensemble » (`nav.overview`) + ligne d'aide (`overview.hint`) en tête, au-dessus de la grille.
- `ResponsiveGridLayout` (breakpoints lg 1200 / md 800 / sm 400, cols 12/8/4, rowHeight 90, margin 16).
- Layout par défaut : graphes ressources en tête (`res-cpu`/`res-ram`/`res-storage` w4 h3), rangée KPIs (w3 h2 ×4), **rangée système** (`sys-nodes` **w12 h5** : carte « Système — par nœud » cross-node, agent hôte Telegraf — load/iowait/swap/uptime ; les vues I/O par device et CPU par cœur sont dans le Monitor du nœud de la Vue VM v2, skill `node-sensors` §3.3), cartes endpoints (w4 h3, 3/rangée), puis alertes (w5) + table endpoints (w7).
- **Layout persisté** (`store/layout`, `overviewLayout.lg`) : les positions drag/resize utilisateur priment ; les nouveaux endpoints reprennent leur emplacement calculé. Clé de memo = ids des endpoints (stable entre deux pushes WS).
- **Compteur « agents PVE » sur la carte VMs** (`KpiVmsCard`) : sous-ligne de la carte « VMs & conteneurs » — **rouge « N VM(s) sans agent PVE »** si `vmsAgentDown > 0` (VMs QEMU en cours sans QGA, critique), sinon « agents PVE OK ». Agrégé par `aggregateKpis` (`sum(k => k.vmsAgentDown ?? 0)`). Pas de nouvelle carte (le layout persisté l'aurait masquée) — sous-ligne dans la carte existante.
- Données : `useMulti()` (WS). Agrégats locaux : `aggregateKpis` (pondération par capacité), `overallRisk` (la sévérité la plus forte gagne, `na` ignorée).
- **EndpointHealthCard** : score de santé, badge nominal/degraded/critical, lien `/e/:id` ; état d'erreur si endpoint down.
- **EndpointsTable** : état, nœuds x/y, VMs, CPU/RAM/disque % (teinte `usageSeverity`), ratios surallocation ×N.N (`computeOvercommit`), risque dynamique (badge, `loadRisk` au montage + toutes les 5 min), score de santé.
- **OverviewAlerts** : alertes inter-endpoints, crit d'abord.

## 4. EndpointPage (`/e/:endpointId`) — dashboard 17 blocs
- **Titre de page** : bouton retour (←) vers la Vue d'ensemble + `h1` = **nom du cluster** (`ep.name`) + ligne d'aide (`endpoint.hint`).
- Grille identique à l'overview ; layout persisté dans `store/layout.layout`.
- Données lourdes : `loadHeavy(id)` + `loadRisk(id)` au montage puis toutes les 5 min (capacity, trends, risque dynamique).
- Blocs : `res-cpu`/`res-ram`/`res-storage` (`ResourceChart` avec endpointId → historique 7 j), `kpi-nodes`/`kpi-cpu`/`kpi-storage`/`kpi-vms` (avec sparklines), `metrics` (`MetricsPanel`), `health` (`HealthGauge`), `pra` (`PraPanel`), `capacity` (`CapacityChart`), `storage` (`StorageCard`), `network` (`NetworkCard` + spark trafic), `alerts` (`AlertsList`), `top` (`TopConsumers` VMs+pools), `nodes` (`NodesTable` → lien détail nœud), `overcommit` (`OvercommitCard`).
- Endpoint inconnu → `Navigate /` ; endpoint stale (`!ep.ok`) → bannière d'avertissement.

## 5. NodePage (`/e/:endpointId/n/:nodeId`)
- **En-tête** : bouton retour (←) vers le cluster + **titre `h1`** (nom du nœud, convention §5 du skill `general`) + badge online/offline + badges ratios surallocation CPU/RAM (RAM inclut `hostRamProvisionPct`) ; sous-titre IP · version PVE · uptime.
- 4 cartes stats : CPU (% + cœurs utilisés/total), RAM (utilisée/total), **disque = rootfs %** (`nodes.disk`, sous-titre `node.kpi.rootfs`), load (loadavg 1/5/15).
- `MetricsPanel` scopé au nœud (prop `node`) — **exclu de la fusion stockage VM** (métrique d'endpoint, voir §9).
- Table VMs : vmid, nom, KVM/LXC, état, CPU %, RAM utilisée/max.

## 6. Données consommées
- Store WS : `useMulti`, `useEndpoint`, `useOvercommitConfig` (`core/data`).
- REST : `fetchCapacity`, `fetchTrends`, `fetchMetrics(timeframe, endpoint)`, `fetchOvercommitRisk` (`core/api/apiClient`).
- Fonctions pures shared : `computeOvercommit`, `usageSeverity`, `overcommitTone`.
- InfluxDB (via `/api/metrics`) : `node_metrics` (cpu/ram/disk rootfs) + `node_net` (trafic réseau = somme des VMs en marche — PVE ≥ 9 ne renvoie plus netin/netout dans `/nodes/{n}/status`), `storage_metrics` (stockage VM used/total).

## 7. i18n
Préfixes : `nav.overview`, `overview.*`, `endpoint.*`, `node.*`, `nodes.*`, `kpi.*`, `metrics.*`, `health.*`, `risk.*`, `overcommit.*`, `alerts.*`, `common.*`, `topbar.*`.

## 8. Décisions & pièges
- **Sous-menu Proxmox sous « Vue d'ensemble » (menu déroulant)** : l'ancienne section « PROXMOX » du sidebar (endpoints→nœuds) a été **supprimée** et transformée en **sous-menu repliable** niché sous l'item « Vue d'ensemble ». Mécanique générique sur `PluginMenuItem` : `submenu` (ReactNode) + `statusDot` (composant pastille) — validées zod (`pluginMenuItemSchema`). **Chevron dédié** à droite du label : clic sur le **label** = navigation (inchangé), clic sur le **chevron** = repli/dépliage sans naviguer. **État persisté** `navTreeExpanded` dans `store/layout` (replié par défaut, mémorisé — même mécanique que le layout drag&drop). `EndpointFleetDot` = pastille de santé **agrégée** de tous les endpoints (la sévérité la plus forte gagne : crit > warn > ok > neutre) — l'alerte reste visible même sous-menu replié. Liens du sous-menu = les mêmes routes que l'ancienne sidebar (`/e/:endpointId`, `/e/:endpointId/n/:nodeId`), zéro changement de route.
- **Manifest en `.tsx` (piège)** : ajouter `submenu: <ProxmoxNavTree />` (du JSX) dans le manifest exige de **renommer `index.ts` → `index.tsx`**, sinon `tsc` : `error TS1005: '>' expected`. L'import par dossier sans extension est sans impact.
- **`agentActive` / `vmsAgentDown` (colonne + alerte + compteur agent PVE)** : la vivacité de l'agent invité QEMU est capturée **dans le réchauffage agent déjà existant du poller** (`refreshAgentData`) — **zéro appel API additionnel**. `EndpointState.agentActive: Map<vmid, boolean>` : `true` = QGA répond (`fs !== null`, y compris `[]`) · `false` = VM QEMU en cours, agent inactif (**critique**) ; LXC/arrêtée/template → clé purgée (`null` = n/a ou inconnu au démarrage). Le snapshot expose `agentActive` sur chaque `VmSummary` et `vmsAgentDown` dans `KpiSummary` (compté avant la construction des `vmSummaries`). La route inventaire dérive le sien de `fs !== null` qu'elle reçoit déjà dans le bundle. Voir skill `proxmox-inventory` §7 pour la sémantique complète.
- **Courbe disque (corrigée)** : le graphique « Disque — 7 jours » traçait l'usage rootfs des nœuds (`disk_pct`) au lieu de l'usage du stockage VM. Correction : série `storage_metrics` écrite par le poller, lecture pondérée Σused/Σtotal ; bucket sans série → `null` (gap) ; repli rootfs seulement si la série est absente au total. Après pointage sur l'InfluxDB prod, la courbe s'accumule depuis le 1er tick (7 jours pour une vue complète).
- **Courbe réseau nœud (corrigée, PVE ≥ 9)** : `/nodes/{n}/status` ne renvoie plus `netin`/`netout` → graphique à zéro. Le trafic nœud = somme des VMs en marche, écrit dans la mesure dédiée `node_net` (bits/s) ; `metricsFromInflux` fait 2 requêtes (`node_metrics` + `node_net`) jointes par `(bucket, nœud)`. Les lignes `node_metrics` historiques à net=0 restent en base (pas de DELETE en InfluxDB 3 Core) mais ne sont plus lues pour le réseau.
- **Timeframe `month` = base `consolidated`** : requête 30 j → le service InfluxDB doit tourner avec `--query-file-limit=10000` (défaut 432 ≈ 72 h, voir skill general §4.6).
- **Nœuds de test pas toujours allumés** : les trous de données quand un nœud est éteint sont attendus (pas un défaut du pipeline) ; le repli RRD ne sert que si InfluxDB est indisponible.
- La vue nœud (`?node=`) est exclue de la fusion stockage (métrique d'endpoint).
- Grilles : layout persisté par vue (overview vs endpoint) ; `key={gridVersion}` force le remontage au reset.
- Rafraîchissement des données lourdes toutes les 5 min — ne pas ajouter de polling par seconde (le WS fournit déjà le temps réel).

## 9. `hypervision_v2` (v0.2.0) — Vue d'ensemble personnalisable par user

Copie de la v1 (`plugins/hypervision_v2/`, mêmes 3 routes + même menu — même famille = même surface, rule `_vN` du skill `general` §2.5). La v1 reste en rollback A/B (`/?v=hypervision` ; v2 = `/?v=hypervision_v2` ou canonique). Socle de grille : skill `general` §12.

- **Manifest** : id `hypervision_v2`, version `0.2.0`.
- **OverviewPage (`/`) = `WidgetGridLayout`** (framework `core/widgets`), **catalogue 12 widgets** (2 endpoints en prod) :
  - `res-cpu` / `res-ram` / `res-storage` (w4 h3) — `ResourceChartBody` (graphe 7 j seul, sans carte)
  - `kpi-nodes` / `kpi-cpu` / `kpi-storage` / `kpi-vms` (w3 h2, minW 2) — `KpiNodesBody` / `KpiCpuRamBody` / `KpiStorageBody` / `KpiVmsBody`
  - `sys-nodes` (w12 h5, minW 6) — `SystemNodesBody` (Système par nœud, Telegraf)
  - `ep-<endpointId>` (**dynamique**, un par endpoint, w4 h3) — `EndpointHealthBody` (copié local de la carte v1)
  - `alerts` (w5 h3) — `OverviewAlertsBody` · `table` (w7 h3) — `EndpointsTableBody`
- **Extraction des corps** : la v2 exporte des `*Body` (contenu sans `Card`/en-tête) dans `resource-chart.tsx`, `kpi-row.tsx`, `system-nodes-card.tsx` — c'est la **frame du socle** (`WidgetFrame`) qui fournit l'en-tête (handle drag, titre, bouton retirer) ; le corps remplit la cellule (`min-h` + `flex-1`). Les pages endpoint/nœud v2 gardent les cartes complètes v1.
- **Toolbar + bibliothèque** : `WidgetToolbar` (Bibliothèque + compteur, Réinitialiser avec confirmation, indicateur de sauvegarde) + `WidgetLibraryPanel` (`w-64` inline). Le bouton de reset v1 de la topbar est **masqué** sur cette page (drapeau `useCustomizablePage`) — sinon deux « Réinitialiser la disposition » dont l'un no-op.
- **Persistance** : `store/user-config` (zustand) → `GET/PUT/DELETE /api/user-config`, scope **`overview`** (layout unique, pas de scope). Merge « présents et futurs » : un nouveau widget du code est **ajouté en bas** du layout au chargement ; un widget retiré du code bascule dans la **bibliothèque** ; jamais de layout cassé. Drag/resize persistés uniquement en fin d'interaction (cf. piège RGL v2, skill `general` §10).
- **Endpoint/Node pages** : identiques à la v1 (layout persisté `store/layout`, pas de personnalisation user) — la topbar v1 y reste visible et active.
- **Validation livrée** : Playwright stage 1 (36 assertions) — 12 widgets, aucune sauvegarde fantôme au montage ni à l'ouverture/fermeture du panneau bibliothèque, drag/resize/retrait/réinsertion/reload/reset persistés, A/B v1 sans toolbar.

## 10. `hypervision_v3` (v0.3.0) — + widget « Températures — par nœud »

Copie de la v2 (`plugins/hypervision_v3/`, manifest id `hypervision_v3`, version `0.3.0`,
export `hypervisionPluginV3`, enregistré dans `core/plugin/plugins.ts`). v1/v2 intactes →
rollback A/B (`/?v=hypervision_v2` / `?v=hypervision`). Un seul ajout : le widget
**`temp-nodes`** (bibliothèque complétée, référence ProxMenux — la jauge « Température » du
dashboard ProxMenux, en vue parc).

- **Composant** : `components/temp-nodes-card.tsx` → `TempNodesBody` (+ helpers locaux
  `nodeChipsMax` / `nodeDisksMax`). Tableau (UI `Table`) : une ligne par **nœud connu**
  (`data.nodes` de `/api/node-sensors`), colonnes « Capteurs (max) » + « Disques (max) » —
  valeur max + **compteur en discret** (`· 20`, tooltip `{{n}} capteur(s)`).
  - **Capteurs** : max `tempInput` des `SensorReading` du nœud ; **ton = le pire** parmi les
    capteurs (un capteur critique colore la cellule même si le max vient d'un autre) via
    `effectiveSensorThreshold` (perso ≤ firmware) + `tempTone` (repli 80/60 °C) — helpers
    partagés, même sémantique que la page `/node-sensors`.
  - **Disques** : max `tempC > 0` (0 °C = pas de capteur, exclu), seuils **fixes 80/60 °C**.
  - Nœud sans mesure → « — » (jamais de valeur inventée) ; aucun nœud avec temp → état vide
    `overview.tempNodes.none`.
- **Hook** `useNodeSensors` dans `overview.tsx` (fetch `/api/node-sensors`, tick 60 s — cache
  serveur 1 min), hoisté au niveau page comme `useNodeSystem`.
- **Catalogue** : entrée `temp-nodes` (w12 h4, minW 6, minH 3) après `sys-nodes` ; deps du
  `useMemo` mises à jour (`sensorsData`, `sensorsLoading`).
- **Layout par défaut** : **`temp-nodes` est DANS `overviewDefaultLayout` v3** (rangée pleine
  largeur h4 après `sys-nodes`, `epY` décalé) — PIÈGE : `mergePageConfig(null, …)` ne renvoie
  que le `defaultLayout` pour un **nouvel utilisateur** (l'ajout des widgets manquants ne
  s'exécute qu'avec un layout **déjà sauvegardé**) → un widget absent du default layout serait
  invisible tant que l'user n'aurait rien sauvegardé. Les layouts v2 déjà sauvegardés reçoivent
  le widget **en bas par le merge** (scope user-config inchangé entre v2 et v3).
- **i18n** : `overview.tempNodes{,.hint,.chips,.disks,.count,.none}` (fr/en) ; le reste réutilise
  `topbar.nodes`.
- **Validation livrée** : Playwright — carte présente dans le default layout (nouvel user),
  valeurs réelles (proxmox ≈ 81 °C/20 capteurs — amdgpu junction — 39 °C/3 disques ;
  ProxSite1/2 « — »), A/B v2 (carte absente).

## 11. `hypervision_v4` (v0.4.0) — Bibliothèque de graphiques sur TOUTES les pages

Copie de la v3 (`plugins/hypervision_v4/`, manifest id `hypervision_v4`, version `0.4.0`,
export `hypervisionPluginV4`, enregistré dans `core/plugin/plugins.ts`). v1/v2/v3 intactes →
rollback A/B (`/?v=hypervision_v3` etc.). La vue d'ensemble est initialement inchangée
(identique à la v3) — voir **§11.7** pour l'évolution production multi-clusters (sélecteur de
cluster sur les graphiques 7 j + matrice nœuds tous clusters). La nouveauté : la
**Bibliothèque de graphiques** (grille personnalisable drag/resize/bibliothèque/persistance par
user — socle `core/widgets`, skill `general` §12) est étendue à **deux pages supplémentaires** :

- **Page CLUSTER** (`/e/:endpointId`) : les **17 blocs** du dashboard deviennent des widgets
  déplaçables/retraitables. Persistance par compte, scope user-config **`endpointView`**
  (un layout par cluster, clé = `endpointId`).
- **Page NŒUD** (`/e/:endpointId/n/:nodeId`) : **grille unifiée** — les **4 KPIs** d'état
  courant + la **table VMs** + **TOUS les graphiques du Monitor nœud** (système, CPU par cœur,
  I/O par disque, réseau par interface, températures, SMART, ZFS ARC, charge, swap) sont
  déplaçables/retraitables — **KPIs et table aussi** (exigence explicite). Persistance par
  compte, scope **`nodePage`** (un layout par `endpointId/nomDuNœud`).

### 11.1. Nouveaux scopes user-config (shared)
- `UserConfigPage` += `'endpointView' | 'nodePage'` ; `UserConfig.pages` +=
  `endpointView?: Record<string, PageConfig>` + `nodePage?: Record<string, PageConfig>`.
- `parseUserConfig` : la boucle de validation passe de `['vmView','nodeView']` à
  `['vmView','nodeView','endpointView','nodePage']`. `getScopePage` / `setScopePage` /
  `clearScopePage` gèrent les deux nouvelles clés (même mécanique que vmView/nodeView).
- **Pas de bump `USER_CONFIG_SCHEMA_VERSION`** (rétro-compatible : une config sans ces clés
  est valide, une config avec est acceptée).
- **PIÈGE MAJEUR (bug rencontré)** : le serveur charge `@prox4u/shared` **depuis le dist**
  (`main: ./dist/index.js`) **au démarrage** (pas de hot-reload). Après avoir ajouté
  `endpointView`/`nodePage` à shared, il faut **rebuild shared** (`pnpm --filter @prox4u/shared
  build`) **ET redémarrer le serveur en cours** — sinon l'ancien `parseUserConfig` (sans ces
  clés) **jette silencieusement la page** au PUT → le serveur répond `pages: {}` vide → le
  client adopte la réponse vide (`saveNow` fait `set({ config: res.config })`) → la grille
  repasse aux défauts. Symptôme : le PUT a le bon corps mais la réponse/le GET suivant sont
  vides. (Le web consomme aussi le dist shared → rebuild obligatoire avant le typecheck web.)

### 11.2. Page cluster — 17 widgets (scope `endpointView`)
- `pages/endpoint.tsx` convertie en `WidgetGridLayout` (framework `core/widgets`).
- **Catalogue 20 widgets** = les 17 blocs v1/v3, dans l'ordre de `DEFAULT_LAYOUT`
  (`store/layout.ts`) : `res-cpu`/`res-ram`/`res-storage`, `kpi-nodes`/`kpi-cpu`/`kpi-storage`/
  `kpi-vms`, `metrics`, `health`, `pra`, `capacity`, `storage`, `network`, `alerts`, `top`,
  `nodes`, `overcommit` **+ 3 graphiques métriques unitaires** `metrics-cpu`/`metrics-ram`/
  `metrics-net` (voir §11.5).
- **Layout par défaut** = `ENDPOINT_DEFAULT_LAYOUT` = `DEFAULT_LAYOUT.map(i → widgetId)`
  (les `i` de `DEFAULT_LAYOUT` correspondent exactement aux ids de widgets). `mergePageConfig`
  gère le catalogue vide (cas `!snapshot`) → grille non rendue avant le snapshot.
- **Données inchangées** : snapshot WS (5 s) + `loadHeavy`/`loadRisk` (5 min).
- **Extraction des 10 corps** : chaque composant a un `*Body` exporté (contenu sans
  `Card`/en-tête) ; la version carte est **refactorisée pour wrapper le corps** (zéro
  duplication) : `MetricsPanelBody`, `HealthGaugeBody`, `PraPanelBody`, `CapacityChartBody`,
  `StorageCardBody`, `NetworkCardBody`, `AlertsListBody`, `TopConsumersBody`,
  `NodesTableBody`, `OvercommitCardBody`. (+ `ResourceChartBody` / `Kpi*Body` déjà présents
  depuis la v2.) Badges/compteurs d'en-tête → **slot `extra`** du widget (ex. badge Health
  Score, sévérité PRA, compteur stockage, « 5 min » réseau, « données insuffisantes »
  surallocation, valeur courante % des `res-*`).
- `MetricsPanelBody` est **autonome** (son propre état de timeframe + fetch `fetchMetrics`) —
  le switcher 1h/24h/7j/30j + le badge source vivent dans le corps (l'en-tête de carte ne
  porte que le titre).
- **Règle des hooks** : TOUS les hooks avant les early returns — le snapshot est lu avec guard
  optionnel (`ep?.snapshot`), le catalogue renvoie `[]` si `!snapshot || !ep`.

### 11.3. Page nœud — grille unifiée (scope `nodePage`)
- `pages/node.tsx` : grille **unifiée** — 4 KPIs + table VMs + tous les graphiques du Monitor
  nœud, **tous déplaçables/retraitables**.
- **Réemploi cross-plugin (vm-view_v4)** : les corps de graphiques du Monitor nœud sont
  **importés statiquement** de `vm-view_v4/components/node-monitor.tsx` (28 exports :
  `TIMEFRAMES`, `ALL_COLS`, 7 hooks `useNode*`, 9 exports CSV, 10 corps `*Body`) +
  `CpuCoresBody` (`cpu-cores-card.tsx`) + `FwDecodeBlock` (`node-net-card.tsx`). **Pas de
  `dependencies: ['vm-view']` dans le manifest** : le loader évalue les dépendances à
  l'initialisation (ordre sensible — hypervision se charge avant vm-view → échouerait) ;
  l'import statique est **bundlé** → fonctionne quel que soit l'état de vm-view. **Piège
  versionnement** : un fix futur de ces corps → vm-view_v5 + hypervision_v5.
- **Corps KPIs/table/cartes locaux** : `components/node-widgets.tsx` → `StatBody` (KPI),
  `VmTableBody` (table VMs), `CapacityBody` + `CapacityRow` (barres used vs capacité),
  `HostDetailsBody` (+ helper `pveVersionLabel`), `nodeDefaultLayout` (rangée 4 KPIs w3 h2
  + rangée `host-details`/`capacity` w6 h4 côte à côte + table VMs w12 h4 + graphiques
  empilés w12, ordre catalogue — voir §11.6).
- **Titres KPIs différenciés des graphiques** : nouvelles clés i18n
  `node.kpi.{cpuLive,ramLive,diskLive,loadLive}` (fr « … (instantané) » / en « … (live) ») —
  évite la collision « CPU » (KPI) vs « CPU » (graphe historique) dans la bibliothèque.
- **Compteur VMs** : le « N en marche sur M » de l'en-tête v3 de la table est porté par le
  **slot `extra`** du widget `vms`.
- **Layout par défaut calculé seulement quand `ready`** : la grille ne se monte qu'après le
  **premier chargement `node-net`** (`netDone`) — les ids dynamiques `netif-*` (un widget par
  interface hôte) ne sont connus qu'à ce moment. `defaultLayout`/`merged` = `[]`/`null` avant.
- **Règle des hooks (bugs corrigés)** : `EChartsOption` importé de **`'echarts'`** (pas
  `@prox4u/shared`) ; TOUS les useMemos **avant** les early returns (dérivés snapshot avec
  guards `ep?.snapshot?.…`).

### 11.4. Validation livrée
- Playwright : page cluster 17 widgets (bons titres), toolbar (Bibliothèque + Réinitialiser),
  retrait→bibliothèque→réinsertion→reset persistés, **persistance après restart serveur**,
  A/B v3 (page cluster sans toolbar/boutons retirer, page nœud = ancien design statique sans
  grille). Page nœud : 21 widgets (4 KPIs + table VMs + 13 graphiques + 3 `netif-*`
  dynamiques), KPIs/table avec données réelles, retrait persisté (scope `nodePage`).
- typecheck (shared+server+web) + tests (shared 303, server 215) + vite build OK.

### 11.5. Évolution v4 (en place) — graphiques métriques unitaires + tooltip date/heure
Modification de la v4 **en place** (dérogation à la règle `_vN` — pas de v5 ; la v4 reste la
version courante, rollback A/B `?v=hypervision_v3`). Deux ajouts sur `MetricsPanelBody`
(`components/metrics-panel.tsx`, local à hypervision — pas de couplage cross-plugin) :

- **Graphiques métriques unitaires du cluster** : `MetricsPanelBody` reçoit une prop
  `metric: 'all' | 'cpu' | 'ram' | 'net'` (défaut `'all'` = combiné, comportement inchangé).
  - `'cpu'` / `'ram'` → une seule série, axe unique en % (0–100).
  - `'net'` → rx/tx, axe unique en o/s (`formatBps` : Ko/s, Mo/s, Go/s).
  - `'all'` → combiné (CPU + RAM + réseau, double axe) — inchangé.
  - Séries/axes construits conditionnellement (`LineSeriesOption[]`, `yAxis[]`) ; `grid.right`
    56 seulement en combiné (axe droit), 40 sinon.
  - **3 nouveaux widgets** au catalogue `endpoint.tsx` : `metrics-cpu` / `metrics-ram` /
    `metrics-net` (w4 h3, minW 3, minH 2), titres i18n `metrics.titleCpu` / `titleRam` /
    `titleNet` (fr « Métriques du cluster — CPU/RAM/Réseau » / en « Cluster metrics — … »).
    **Pas dans `DEFAULT_LAYOUT`** → nouvel utilisateur : dans la **bibliothèque** ; utilisateur
    existant : ajoutés **en bas de grille par le merge** (comportement `mergePageConfig` §3).
- **Export CSV (unitaires uniquement)** : bouton `ExportCsvButton` (slot du corps, à côté du
  switcher de timeframe) + fonction locale `exportClusterCsv` via `downloadCsvFile`
  (`lib/monitor-charts.ts` — **pas** d'import cross-plugin de `exportNodeCsv`). Fichier
  `cluster-metrics-<endpointId>-<metric>-<tf>-<date>.csv`, header `timestamp,<colonnes>`
  (cpu_pct / ram_pct / net_in_bps+net_out_bps). Le combiné (`'all'`) n'a **pas** de bouton
  export (exigence : unitaires uniquement).
- **Tooltip date/heure** (fix) : `tooltip.formatter` (remplace `valueFormatter`) — en-tête =
  `tooltipTimeLabel` (1h/24h → `JJ/MM/AAAA HH:MM`, 7j/30j → `JJ/MM/AAAA`) **au lieu du
  timestamp unix brut** ; valeurs formatées **par série** (CPU/RAM en %, RX/TX en o/s via
  `formatBps` — corrige le bug du combiné qui affichait le réseau en %). Pattern identique au
  `tooltipFormatter` du Monitor nœud vm-view_v4.
- **Piège canvas ECharts après resize de viewport** : si un widget est ajouté puis le viewport
  redimensionné, le canvas peut rester à la taille initiale (23 px) — le `ResizeObserver` du
  hook `useEChart` propage le resize, mais un **re-navigation** (remontage) garantit la bonne
  taille. Vérifier la taille du canvas avant de tester le tooltip au survol.
- **Validation livrée** : Playwright — 3 widgets unitaires dans la bibliothèque, ajout→grille,
  rendu (CPU % bleu, RAM % violet, Réseau o/s Ko/s RX vert/TX jaune), **tooltip date/heure**
  (`19/11/2026 12:23` + `CPU : 16.9 %` ; combiné : CPU/RAM en % + RX/TX en Ko/s), export CSV
  (`cluster-metrics-proxmox-cpu-hour-*.csv`, 60 lignes), combiné inchangé (4 séries, double
  axe, sans export), 0 erreur console, page nœud v4 intacte. typecheck + tests (shared 303,
  server 215) + vite build OK.

### 11.6. Évolution v4 (en place) — « Détails hôte » + « Capacité et utilisation » (page nœud)
Deux cartes inspirées d'une capture vCenter, sur la **page nœud** (`/e/:endpointId/n/:nodeId`),
implémentées **en place** dans `hypervision_v4` (dérogation à la règle `_vN`).

- **2 nouveaux widgets** au catalogue `node.tsx` : `host-details` + `capacity` (w6 h4,
  minW 4, minH 3) **côte à côte** après les KPIs (y2) ; `vms` décalé y6, graphiques depuis
  y10 dans `nodeDefaultLayout` (`TOP_IDS` mis à jour). Nouvel user → position défaut ; user
  existant → ajout en bas par le merge `mergePageConfig`.
- **`HostDetailsBody`** : identification hôte (hyperviseur, IP, état, uptime, cœurs, NIC,
  VMs) + empreinte matérielle (modèle CPU + DMI : product/vendor/board). La version PVE brute
  `pve-manager/9.1.1/42dba46cf33dac83` est parsée en **« Proxmox VE 9.1.1 »** par le helper
  `pveVersionLabel` (le champ `version` du snapshot est la valeur brute de `pveversion`).
  Contenu aligné en haut (`content-start`).
- **`CapacityBody`** + `CapacityRow` : 3 barres used vs capacité — CPU en **cœurs** (pas de
  fréquence collectée), Mémoire + Stockage **rootfs** en octets — tons `usageSeverity`
  (seuils `overcommit.json`). Données 100 % snapshot nœud (PVE), aucune requête supplémentaire.
- **Données manquantes (Phase 2)** : modèle CPU + modèle matériel DMI collectés par Telegraf
  (script `exec` `prox4u-telegraf-hw-info.sh` → table quasi-statique `node_hardware`) et servis
  par **`GET /api/node-hardware`** (dernier point par nœud, fenêtre 1 h, cache 5 min,
  `strOrNull` mappe `unknown` → null). `source: 'empty'` si la table est absente (agent pas
  encore (re)déployé) → les modèles s'affichent « — ». Voir skill `node-sensors`.
- **`NodeHealth`** : `rootfsUsedBytes`/`rootfsTotalBytes` ajoutés (requis `number | null`) +
  mapping poller → la barre Stockage = rootfs (disque système).
- **i18n** : `node.capacity.*` (10 clés) + `node.hostDetails.*` (10 clés) fr/en.
- **Validation livrée** : Playwright — 2 widgets présents et bien positionnés (après KPIs,
  avant table VMs), 0 erreur console ; Détails hôte (IP, ● en ligne, Uptime, Cœurs 24, NIC 13,
  VMs 7, « Proxmox VE 9.1.1 », modèles « — ») + Capacité (CPU 6.3/24 cœurs, Mémoire 34.7/126 Go,
  Stockage 13.9/93.9 Go, barres teintées). typecheck + tests (shared 303, server 217) + vite
  build OK.

### 11.7. Évolution v4 (en place) — Vue d'ensemble production multi-clusters (sélecteur de cluster + matrice nœuds)
La vue d'ensemble (`/`) est adaptée à la production **multi-clusters multi-nœuds** : les 3
graphiques 7 j agrégés perdaient leur sens (moyenne de clusters hétérogènes — la ligne
« allocation 150 % » agrégée ne correspond à aucun cluster réel). Deux ajouts, **100 %
frontend** (zéro nouvelle API, zéro changement serveur) :

- **A — Sélecteur de cluster sur les graphiques 7 j** : `Select` (ui/input) dans l'**en-tête
  de page** (à côté de `WidgetToolbar`), label `overview.cluster` — options « Tous les
  clusters » (`'all'`) + un item par endpoint. État **page** `resEndpointId` (non persisté —
  la personnalisation user-config ne stocke que le layout) :
  - `resEp = eps.find(e => e.id === resEndpointId)` → **fallback auto** « Tous » si
    l'endpoint disparaît (le select redébarque sur `'all'` au rendu suivant) ;
  - `resKpis = resEp ? (resEp.snapshot?.kpis ?? null) : kpis` (agrégat pour `'all'`) → les 3
    widgets `res-*` passent `endpointId={resEp?.id}` + `kpis={resKpis}` à
    `ResourceChartBody` : les **courbes** (`/api/metrics?endpoint=<id>` déjà supportée), la
    **valeur courante** (slot `extra`) et la **ligne d'allocation** suivent le cluster choisi ;
  - `ResourceChartBody.kpis` devient **optionnel** (`KpiSummary | null | undefined`) :
    cluster sans snapshot (endpoint en erreur) → pas de valeur courante / pas de ligne
    d'allocation, couleur neutre (jamais de valeur inventée).
  - **Les KPIs restent agrégés** (par design — le sélecteur ne pilote que les 3 graphiques 7 j).
- **C — Matrice nœuds tous clusters** (`components/node-matrix-card.tsx` →
  `NodeMatrixBody`) : une ligne par nœud, **groupés par cluster** (clusters ET nœuds triés
  par nom, le nom du cluster n'est affiché que sur la **première ligne** du groupe), colonnes
  Cluster · Nœud (**lien** `/e/:endpointId/n/:nodeId`) · État (● `nodes.online` / badge crit
  `nodes.offline`) · CPU · RAM · Disque (teintes `usageSeverity` — seuils d'usage
  `overcommit.json`) · VMs (en marche/total depuis `snapshot.vms` filtrées par nœud). Nœud
  hors ligne → cellules « — ». `overflow-y-auto` (production : 50+ nœuds). **Données :
  snapshot WS uniquement** (`NodeHealth` + `VmSummary`) — zéro requête supplémentaire.
- **Layout par défaut** : `nodes-matrix` (w12 h4, minW 6, minH 3) inséré à **y5** (après la
  rangée KPIs — la vue « qui chauffe en ce moment ») ; `sys-nodes`/`temp-nodes`/endpoints/
  alertes/table décalés de 4. User existant → ajout **en bas par le merge** (comportement
  inchangé, cf. piège §10/§11.3).
- **i18n** : `overview.allClusters`, `overview.cluster`, `overview.nodesMatrix{,.hint,.none}`
  (fr/en) ; le reste réutilise `topbar.nodes`, `common.state`, `metrics.disk`, `nodes.online`,
  `nodes.offline`.
- **Validation livrée** : Playwright (2 endpoints, 3 nœuds) — sélecteur présent (3 options),
  bascule sur ClusterProxmox → valeurs courantes = celles du cluster (CPU 1 %/RAM 10 %/
  Disque 98 % = table endpoints) + courbes du cluster (disque 98 % rouge, allocation 42 %
  CPU/20 % RAM au lieu de l'agrégat) ; retour « Tous » → agrégat ; matrice : 3 lignes groupées
  (nom de cluster sur 1re ligne du groupe), teintes (89 % disque ProxSite1 warn), VMs
  6/7·0/1·0/1, clic → `/e/proxmox/n/proxmox` ; 0 erreur console. typecheck + tests
  (shared 303, server 217) + vite build OK.
