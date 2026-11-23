---
name: hypervision
description: Base de connaissance du plugin Hypervision de Prox4u — vue d'ensemble du parc multi-endpoints, détail endpoint (dashboard 17 blocs), détail nœud ; KPIs, graphiques ressources 7 jours (dont stockage VM), Health Score, PRA N-1, capacity planning, surallocation, alertes ; hypervision_v2 = vue d'ensemble en grille personnalisable par user (drag/resize/bibliothèque, persistance /api/user-config) ; hypervision_v3 = + widget « Températures — par nœud » (max capteurs + max disques SMART, live /api/node-sensors) ; hypervision_v4 = bibliothèque de graphiques étendue à TOUTES les pages (page cluster 17 blocs + page nœud unifiée KPIs/table VMs/graphiques, KPIs et table aussi déplaçables/retraitables, réemploi cross-plugin des corps du Monitor nœud vm-view_v4) + graphiques métriques unitaires du cluster (CPU / RAM / Réseau — 1 série, export CSV) et tooltip date/heure (et non timestamp unix brut) + page nœud : cartes « Détails hôte » (identification hôte + matériel CPU/DMI via /api/node-hardware) et « Capacité et utilisation » (barres used vs capacité CPU/Mémoire/Stockage) + vue d'ensemble production multi-clusters : sélecteur de cluster sur les 3 graphiques 7 j (« Tous les clusters »/[cluster] — courbes, valeur courante et ligne d'allocation suivent le cluster, /api/metrics?endpoint= déjà supportée, 100 % frontend) + carte « Nœuds — tous les clusters » (matrice : une ligne par nœud groupés par cluster, État/CPU/RAM/Disque/VMs, teintes usageSeverity overcommit.json, clic → page nœud, snapshot WS zéro API) + capacity planning par élément (3 widgets capacity-cpu/ram/disk 1 série + 1 projection + 1 badge, réemployés dans le détail VM vm-view_v4) + badge quorum cluster (page cluster + vue d'ensemble, pénalité Health Score −25, issue #3/P1, E2E validé — lit `quorate` PVE 9, note Qdevice) + badge failover « API via … » (nœud endpoint injoignable → bascule sur l'autre nœud du cluster, champ `apiVia`) + surveillance du Qdevice (état réel corosync via table Telegraf `quorum_detail`/`pvecm status`, repli déduction API `deriveQdeviceState`, badge 🟢/🔴 up/down + alerte warn `qdevice-down` + pénalité Health Score −10 si down, métrique Centreon `cluster_qdevice`, `cluster.quorumDetail` votes) + score de configuration audit (P3, issue #6) : colonne « Audit » du tableau overview + widget jauge « Score de configuration » du détail endpoint (lit `snapshot.audit` calculé par le poller, zéro API — moteur + page `/audit` + constats cliquables dans la skill `audit`) + PRA global cross-endpoints (niveau 3, widget `pra-global` de la vue d'ensemble — si un bâtiment tombe, les autres sites de TOUS les clusters peuvent absorber ; calcul serveur `computeGlobalPra()` poussé via WS `snapshot.globalPra`, sites préfixés par endpoint, condition ≥ 2 sites répartis sinon `na`, prérequis stockage ISO documenté). Use when working on the hypervision plugin (packages/web/src/plugins/hypervision/, hypervision_v2/, hypervision_v3/ ou hypervision_v4/), the /, /e/:endpointId or /e/:endpointId/n/:nodeId routes, or its components (resource-chart, kpi-row, metrics-panel, pra-panel, capacity-chart, overcommit-card, system-nodes-card, temp-nodes-card, node-widgets…).
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

### 11.8. Évolution v4 (en place) — Capacity planning par élément (page cluster) + réemploi dans le détail VM
Le graphe de capacité de la page cluster traçait **CPU + RAM + disque ensemble** (3 lignes
historiques + 3 projections + 3 badges) — illisible en production. Ajout de **3 graphiques
par élément** (un par métrique), **100 % frontend** (zéro nouvelle API — `CapacityResponse`
déjà chargée par `loadHeavy`), implémentés **en place dans `hypervision_v4`** (dérogation à
la règle `_vN`).

- **`CapacityChartBody`** (`components/capacity-chart.tsx`) reçoit une prop
  **`metric?: CapacityMetric`** :
  - **absente** → les 3 combinées (historique + projection, légende, 3 badges) —
    comportement **inchangé** (le widget `capacity` du layout par défaut reste tel quel) ;
  - **présente** → **UNE seule métrique** : 1 série historique + 1 projection en pointillés,
    1 couleur (`COLORS[metric]`), **pas de légende** (`grid.top` réduit 32→12), **1 seul
    badge** (« à 90 % dans ~N j » / « tendance stable ») + pente.
- **3 nouveaux widgets** au catalogue `endpoint.tsx` : `capacity-cpu` / `capacity-ram` /
  `capacity-disk` (w4 h3, minW 3, minH 2) — **pas dans `DEFAULT_LAYOUT`** (même pattern que
  `metrics-cpu`/`metrics-ram`/`metrics-net` §11.5) : nouvel user → **bibliothèque** ; user
  existant → ajoutés **en bas par le merge** `mergePageConfig`.
- **Réemploi cross-plugin dans le détail VM** (skill `vm-inventory`) : le corps est importé
  **statiquement** depuis `vm-view_v4/components/vm-detail.tsx`
  (`import { CapacityChartBody } from '../../hypervision_v4/components/capacity-chart'`) —
  même pattern que l'import inverse existant (`node.tsx` → `node-monitor.tsx`), **pas de
  cycle de modules** (modules distincts), bundlé au build → fonctionne quel que soit l'ordre
  de chargement des plugins. Voir skill `vm-inventory` § (détail VM — Capacité du cluster).
- **i18n** : `capacity.titleCpu` / `capacity.titleRam` / `capacity.titleDisk` (fr/en).
- **Validation livrée** : Playwright — page cluster : 3 widgets dans la grille (ajoutés en bas
  par le merge, user existant), chacun **1 série + 1 projection + 1 badge** (CPU « à 90 % dans
  ~49 j » pente +1.38 %/j, RAM « tendance stable » pente −0.59 %/j, Disque « à 90 % dans
  ~280 j » pente +0.21 %/j), widget combiné inchangé ; détail VM (LXC #103) : section
  « Capacité du cluster » dans l'onglet Résumé avec les 3 graphiques (données du cluster) ;
  0 erreur console. typecheck + tests (shared 303, server 217) + vite build OK.

### 11.9. Évolution v4 (en place) — Badge quorum cluster (issue #3 / P1)
Le quorum du cluster est désormais **collecté** (entrée cluster de `/cluster/status` via
`getNodes()` → `PveClusterStatus { nodes, quorum, quorumState }`) et **affiché** :

- **Champ snapshot** : `DashboardSnapshot.cluster` += `quorum: number | null` +
  `quorumState: 'ok' | 'lost' | null` (null = inconnu). **PVE 9 expose `quorate` (1/0) — c'est
  la vérité, lue en priorité** (spec officielle `PVE/API2/Cluster.pm` : `quorate` = « majority
  of nodes online to make decisions », `nodes` = « count, including offline nodes » ; pas de
  champ `quorum`/`quorum_state` en 9). Fallback : `quorum_state` ('ok'/'lost') sinon dérivé
  `en ligne < quorum → lost` (fonction pure `deriveQuorumState` dans shared, testée). Le mock
  force `quorumState: 'lost'` en scénario `critical`.
  - **Note Qdevice** : un cluster 2 nœuds + **Qdevice** a 3 votes (quorum=2). 1 nœud down seul
    **ne perd pas** le quorum (le Qdevice le maintient : 1 nœud + 1 Qdevice = 2 ≥ 2) ; il faut
    nœud down **+** Qdevice down (ou les 2 nœuds down). L'app lit `quorate` → comportement
    correct dans les deux cas. Le badge « Quorum X/Y » affiche le **nombre de nœuds** (pas les
    votes — l'API n'expose pas les votes), l'état ok/lost vient de `quorate`.
- **Badge page cluster** (`pages/endpoint.tsx`, en-tête à côté du `h1`) : `Badge tone="crit"`
  « Quorum perdu » si `lost`, `Badge tone="ok"` « Quorum {{online}}/{{total}} » si `ok`,
  rien si inconnu (null). **+ badge failover** `Badge tone="warn"` « API via {{host}} (nœud
  endpoint injoignable) » si `EndpointSnapshot.apiVia` est définie (voir skill `api` §failover).
- **Carte endpoint vue d'ensemble** (`pages/overview.tsx`, `EndpointHealthBody`) : suffixe
  rouge « · Quorum perdu » dans la ligne `x/y nœuds · …` si `lost` (compact, pas de badge).
- **Health Score** : pénalité **−25** (`health.penalty.quorumLost`, params online/total) si
  `quorumState === 'lost'` — même poids qu'un nœud down (guests actifs mais cluster en
  lecture seule). `computeHealthScore` reçoit un 4ᵉ param optionnel
  `cluster?: { quorum, quorumState }` (rétro-compatible). La health-gauge rend les pénalités
  génériquement → rien à changer côté jauge.
- **Alerte dashboard** : `buildAlerts` (poller) += alerte `crit` `alerts.quorumLost` si lost.
- **i18n** : `cluster.quorumOk` / `cluster.quorumLost` + `health.penalty.quorumLost` +
  `alerts.quorumLost` (fr/en).
- **Règle d'alarme** : voir skill `centreon-nsca` (métrique `cluster_quorum` + cible
  `kind: 'cluster'`).
- **Validation** : tests shared (quorum.test.ts 3, health 2, centreon-nsca 2) + tests server
  (helpers failover `clusterAltUrls`/`promoteUrl` dans prox4u-client.test.ts) + typecheck
  shared/server/web + vite build.
- **E2E validé** (2026-11-20, lab nested — cluster 2 nœuds ProxSite1/ProxSite2 + Qdevice sur la
  VM NFS 192.168.1.190) :
  - **Perte + failover** : nœud endpoint (.202) arrêté + Qdevice (NFS) déconnecté → `quorate=0`
    → `quorumState=lost`, health **30 critical** (nodeDown −25 + quorumLost −25 + praCrit −20),
    alerte crit, **badge rouge « Quorum perdu »** + **badge failover « API via 192.168.1.201:8006
    (nœud endpoint injoignable) »** (l'app a basculé sur l'autre nœud) — screenshot
    `docs/screenshots/quorum-lost-failover.png`.
  - **Récupération** : nœud relancé + NFS reconnectée → `quorate=1` → `state=ok`, badge vert
    « Quorum 2/2 », `apiVia` disparu (retour auto sur l'endpoint configuré).

### 11.10. Surveillance du Qdevice (état réel corosync, P1)

L'API PVE n'expose **que** `quorate` + `nodes` (vérifié dans le code source PVE :
`PVE/API2/Cluster.pm`, grep des 25 modules API2) — l'état du Qdevice (en ligne / hors ligne)
et le détail des votes n'existent qu'au niveau **corosync** (`pvecm status`). Deux sources,
en cascade :

- **Source 1 — corosync (réelle, prioritaire)** : script Telegraf `exec`
  `prox4u-telegraf-quorum.sh` (installé par `deploiement/60-telegraf-nodes.sh`, section 5e)
  parse `pvecm status` → table `quorum_detail` (base `raw`) :
  `expected_votes`, `total_votes`, `quorum_threshold`, `quorate`, `has_qdevice` (0/1),
  `qdevice_online` (0/1). Le membre Qdevice est matché par son **nodeid `0x00000000`**
  (constante corosync) — PAS par le nom « Qdevice » en dernier champ : quand le Qdevice est
  hors ligne, la ligne porte un suffixe (`0x00000000  0  Qdevice (votes 1)`) et le dernier
  champ n'est plus « Qdevice ». `qdevice_online` = votes (colonne 2) > 0 ; `has_qdevice` =
  Flags contient « Qdevice » OU ligne nodeid `0x00000000` présente. Silencieux si `pvecm`
  absent (nœud hors cluster).
- **Source 2 — déduction API (repli)** : `deriveQdeviceState(nodesTotal, nodesOnline,
  quorumState)` (shared, pure) — seuil sans Qdevice `floor(N/2)+1` ; nœuds insuffisants +
  quorate → `up`, sinon `down` ; nœuds suffisants → `unknown`.

**Chaîne** : poller `readQuorumDetail()` (querySql InfluxDB `raw`, **cache 30 s**/endpoint,
fenêtre 10 min, filtré par nœuds de l'endpoint, `ORDER BY time DESC LIMIT 1`) → si données
`qdeviceStateFromCorosync(hasQdevice, qdeviceOnline)` (`up`/`down`/`absent`), sinon repli
`deriveQdeviceState`. Résultat dans `DashboardSnapshot.cluster` :
- `qdevice: 'up' | 'down' | 'absent' | 'unknown'`
- `quorumDetail: QuorumDetail | null` (expectedVotes, totalVotes, quorumThreshold, quorate,
  hasQdevice, qdeviceOnline) — null si agent non déployé.

**UI** (page cluster `endpoint.tsx`) : badge 🟢 `cluster.qdeviceUp` « Qdevice en ligne » si
`up`, badge 🔴 `cluster.qdeviceDown` « Qdevice hors ligne » si `down` ; `absent`/`unknown`
masqués (rien à surveiller / indéterminé).

**Alerte** : `buildAlerts` += `qdevice-down` **warn** `alerts.qdeviceDown` si `qdevice ===
'down'` (le quorum n'est plus protégé si un nœud tombe — pas d'incident immédiat tant que le
quorum tient).

**Health Score** : pénalité **−10** si `qdevice === 'down'` (`health.penalty.qdeviceDown`) —
même poids que `praWarn` (risque, pas incident). Cumulable avec `quorumLost` (−25) si le
quorum est aussi perdu. `up`/`absent`/`unknown` → aucune pénalité.

**Centreon NSCA** : métrique `cluster_qdevice` (cible `kind: 'cluster'`) — Qdevice
up/absent=1, down=0, unknown=null ; service auto-nommé `Prox4u-Alarm-CLUSTER-QDEVICE`.
cf. skill `centreon-nsca`.

**i18n** : `cluster.qdeviceUp` / `cluster.qdeviceDown` + `alerts.qdeviceDown` +
`health.penalty.qdeviceDown` + `alarm.metric.cluster_qdevice` (fr/en).

**Tests** : shared quorum.test.ts 15 (3 deriveQuorumState + 9 deriveQdeviceState + 3
qdeviceStateFromCorosync) + health.test.ts 3 (pénalité qdevice down / up-absent-unknown /
cumul quorumLost) + centreon-nsca.test.ts 2 (defaultServiceName + METRIC_IDS cluster_qdevice).
**E2E validé avec données réelles** (2026-11-20, lab nested) : `systemctl stop corosync-qnetd`
sur la VM Qdevice → `qdevice_online=0` → badge 🔴 + alerte warn + **Health Score −10**
(quorum maintenu par les 2 nœuds, `quorumState=ok`) ; `systemctl start corosync-qnetd` →
`qdevice_online=1, total_votes=3` → badge 🟢, alerte disparue, score restauré. Screenshot
`docs/screenshots/qdevice-online-badge.png`.

**Déployé** (2026-11-20) sur les nœuds ProxSite1/ProxSite2 (re-run
`deploiement/60-telegraf-nodes.sh` sur un nœud = idempotent, ajoute le script + la section
`[[inputs.exec]]`). Le Qdevice (VM NFS) n'a PAS besoin de Telegraf — l'état du Qdevice se lit
depuis n'importe quel nœud du cluster (`pvecm status`).

### 11.11. Évolution v4 (en place) — Score de configuration (audit, P3) : colonne overview + widget endpoint

> **2026-11-20** — P3 (issue #6) : un **2ᵉ score de configuration** (complément du health score
> ressources). Le moteur d'audit vit dans `shared/audit.ts` et est **calculé par le poller** à
> chaque tick → posé dans le **snapshot WS** (`snapshot.audit`) — hypervision_v4 le lit **en
> direct, zéro API**. Détail complet du module : **skill `audit`**. Implémenté **en place dans
> `hypervision_v4`** (dérogation à la règle `_vN`).

- **Vue d'ensemble** (`pages/overview.tsx`) : **colonne « Audit »** dans le tableau endpoints —
  `auditScoreCell` (score coloré ≥80 ok / 50–79 warn / <50 crit, `—` si null) + `auditScoreTone`.
  Lit `ep.snapshot.audit.score`. (Le widget `table` est étroit w7 → la colonne est en fin de
  tableau, défilement horizontal — comportement existant du tableau 13 colonnes.)
- **Détail endpoint** (`pages/endpoint.tsx`) : **widget « Score de configuration »** —
  `components/audit-gauge.tsx` (`AuditGaugeBody` : jauge ECharts + liste des constats, **miroir
  de `HealthGaugeBody`**) + slot `extra` = badge état (Conforme/À améliorer/À revoir). Ajouté au
  **catalogue** (→ 21 widgets) + à **`ENDPOINT_DEFAULT_LAYOUT`** (y19, sous la surallocation) —
  **pas** dans `DEFAULT_LAYOUT` (store/layout.ts) pour éviter un **slot vide** sur les pages
  legacy v1/v2/v3 qui l'utilisent en fallback.
- **i18n** : `audit.scoreCol` (en-tête colonne) + `audit.*` (skill `audit` §9).

**Vérifications** : typecheck + build OK ; **shared 366** (dont 35 audit) + **server 240** verts ;
Playwright — colonne « Audit » dans le tableau overview (`hasAudit: true`) + widget audit dans le
détail endpoint (jauge 87 + badge Conforme + constats) ; constats cliquables (clic VM →
`/vms?tree=…&vm=…`).

### 11.12. Évolution v4 (en place) — PRA global cross-endpoints (niveau 3, widget `pra-global`)

> **2026-11-20** — PRA **multi-sites niveau 3** : le PRA par endpoint (bascule N-1 intra-cluster)
> est complété par un **PRA global** — si un **bâtiment (site)** tombe, les **autres sites de TOUS
> les clusters** (tous les endpoints) peuvent absorber. Complément, pas remplacement : le PRA par
> endpoint (détail cluster, §4) reste inchangé. Implémenté **en place dans `hypervision_v4`**
> (dérogation à la règle `_vN`).

**Sémantique** (validée utilisateur) :
- **PRA seulement si nœuds répartis** : « les clusters mono-nœud ou sur le même site, non pas de
  PRA. Seule les clusters avec des nœuds répartis sont dans le PRA » → condition **≥ 2 sites avec
  ≥ 1 nœud présent**, sinon `na` (non applicable).
- **Stockage ISO** : « le stockage pour le PRA doit être iso d'un site à l'autre » → **prérequis
  documenté** (affiché dans le hint du widget), **pas de flag de config**.

**Calcul côté serveur** (`core/poller.ts`) :
- `computeGlobalPra()` appelé à chaque `tick()` — agrège les nœuds/VMs de **tous** les endpoints
  (`lastNodes`/`lastVms` conservés par le tick), construit une topologie de sites
  **cross-endpoints** et appelle `computePra` (shared) avec les sites préfixés par endpoint.
- Résultat poussé via WS dans **`MultiDashboardSnapshot.globalPra`** (champ **requis**
  `PraReport | null` — null = aucun endpoint avec snapshot).
- **Noms préfixés par endpoint** : les **ids de sites** sont préfixés (`clusterproxmox/ProxSite1`)
  pour désambiguïser les bâtiments homonymes entre clusters ; les **noms de bâtiments** restent
  intacts (affichés tels quels).

**`computePra`** (`shared/pra.ts`) :
- `multiSite` = **≥ 2 sites avec nœuds présents** (condition de PRA, sinon `na`).
- `unmappedNodes: string[]` — nœuds sans site mappable (orphelins), calculé et exposé.
- `SitePra.nodes: string[]` — mapping visible (les nœuds de chaque site).

**Widget `pra-global`** (vue d'ensemble `pages/overview.tsx`) :
- Entrée au **catalogue** (w12 h4, minW 6, minH 3) après `temp-nodes` ; **dans
  `overviewDefaultLayout`** (rangée pleine largeur `PRA_ROW_Y`, `epY` décalé) — cf. piège
  §10/§11.3 (un widget absent du default layout serait invisible pour un nouvel user).
- Rendu : **`PraPanelBody`** (composant partagé `components/pra-panel.tsx`, **enrichi**) —
  badge sévérité globale + hint (prérequis stockage ISO) + une ligne par site (nom bâtiment +
  **badge endpoint** + % de capacité libre utilisée + **ligne nœuds** `SitePra.nodes` + VMs à
  basculer / capacité libre des autres sites) + section **VMs concernées** + encart **orphelins**
  (`unmappedNodes`, masqué si vide).
- **Réemploi** : le même `PraPanelBody` sert le **PRA par endpoint** (détail cluster, §4) — la
  différence est dans les données (global = cross-endpoints préfixés ; endpoint = intra-cluster
  sans préfixe).

**i18n** : `pra.globalTitle` / `pra.globalHint` / `pra.nodes` / `pra.unmapped` (fr/en).

**Tests** : shared `pra.test.ts` +4 (multiSite, unmappedNodes, SitePra.nodes) + server
`poller.test.ts` +3 (`computeGlobalPra` : null sans snapshot, cross-endpoints, préfixe endpoint).
**shared 393** + **server 255** verts, web typecheck OK.

**E2E validé** (2026-11-20, lab) :
- **API** `/api/dashboard` → `globalPra` : `globalSeverity: crit`, `unmappedNodes: []`, sites
  `proxmox/site-principal` **700 % crit** (49c/120G, cap 7c/34G), `clusterproxmox/proxsite1`
  **75 % warn** (3c/2G, cap 4c/22G), `clusterproxmox/proxsite2` **66,7 % ok** (2c/2G, cap 3c/22G).
- **UI** (vue d'ensemble v4, widget `pra-global`) : badge « Bascule à risque » (crit) + 3 lignes
  sites (700 %/75 %/67 %) + **badge endpoint** (proxmox / clusterproxmox) + **ligne nœuds**
  (`proxmox/proxmox`, `clusterproxmox/ProxSite1`, `clusterproxmox/ProxSite2`) + VMs concernées
  (AMD-IA, ProxSite1, ProxSite2, ia-u24-01, Centreon) + encart orphelins masqué (vide).
- **PRA par endpoint inchangé** : proxmox (1 site) → `na` « Bascule N-1 non applicable » ;
  clusterproxmox (2 sites) → 75 %/67 % (capacité libre **intra-cluster** 17.1G, ≠ global 22.4G).

> **Note visibilité** : le widget est une fonctionnalité **v4** — visible uniquement si l'utilisateur
> a sélectionné `hypervision_v4` dans « Mon profil → Modules » (le module est globalement activé,
> mais la sélection par user contrôle la visibilité — cf. skill `general` §auth). Un user sur v2/v3
> ne le voit pas (il voit la 1ʳᵉ version visible de la famille).

### 11.13. Évolution v4 (en place) — Widget « InfluxDB 3 Core » (santé de la base de métriques)

> **2026-11-23** — Widget `influxdb` sur la vue d'ensemble v4 : **santé live de la base
> InfluxDB 3 Core** (file d'écriture, abandons, headroom fichiers) + mini-graphe 24 h.
> Détail complet : **skill `api` § /api/influxdb** + RFC `docs/plan-module-influxdb.md`.
> Page dédiée `/influxdb` (plugin `influxdb`) : KPIs, 4 graphiques 24h/7j/30j, bases,
> archivage, 7 actions (réservées groupes `INFLUX_ACTION_GROUPS`).

**Données** :
- **Live** : `multi.influx: InfluxStatus | null` dans le snapshot WS (zéro API) — calculée par le
  poller (`computeInfluxStatus()`) : compteurs d'écriture (file/enqueued/flushed/dropped) +
  headroom fichiers (`fileEstimate`) + ping 60 s **fire-and-forget** (ne bloque jamais le tick).
  `null` si InfluxDB désactivé/mock → widget affiche « InfluxDB désactivé ».
- **Mini-graphe 24 h** : `GET /api/influxdb/history?range=24h` (cache serveur 5 min, refresh
  client 5 min — `useInfluxHistory24h()`). 2 séries : `queueDepth` + `dropped` (cumul).
  Source : self-telemetry `influxdb_self` (base raw, 1 ligne/tick poller).

**Définition du widget** (`overview.tsx`) :
- Catalogue : `id: 'influxdb'`, `default: { w: 6, h: 4 }`, `minW: 4`, `minH: 3`,
  badge `extra` = ping (🟢 ok / 🔴 ko / `…` si `null`).
- **Layout par défaut** : **ligne pleine largeur** `w: 12, h: 4` à `y = PRA_ROW_Y + PRA_ROW_H`
  (constantes `INFLUX_ROW_Y` / `INFLUX_ROW_H`, après `pra-global`) — les widgets endpoints
  (`epY`) sont décalés en conséquence.
- Rendu : `InfluxDbBody` (`components/influxdb-card.tsx`) — 3 KPIs (File / Abandonnées
  (cumul) en warn si > 0 / Headroom badge ok-warn-crit) + ECharts 24 h + lien → `/influxdb`.

**i18n** : 60 clés `influxdb.*` (fr/en) — `influxdb.title`, `influxdb.kpi.*`, `influxdb.charts.*`,
`influxdb.headroom.*`, etc.

**E2E validé** (2026-11-23, lab, compte test-admin) : badge 🟢 + KPIs live (file 21, abandonnées 0,
headroom OK) + mini-graphe 24 h (courbe visible) + clic → `/influxdb`. Après « Réinitialiser la
disposition », le widget apparaît à sa position par défaut (après PRA global) — validé screenshot.

> **Note visibilité** : fonctionnalité **v4** (comme §11.12). Piège rencontré : un module
> `globallyEnabled` n'est **pas** auto-sélectionné dans les préférences d'un user existant
> (visible = autorisés ∩ préférences, `ModuleRoute` → `visibleModuleIds`) → `/influxdb` redirige
> vers `/profile` tant que le module n'est pas coché dans « Mon profil → Modules ».
