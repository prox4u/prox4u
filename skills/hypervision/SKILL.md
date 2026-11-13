---
name: hypervision
description: Base de connaissance du plugin Hypervision de Prox4u — vue d'ensemble du parc multi-endpoints, détail endpoint (dashboard 17 blocs), détail nœud ; KPIs, graphiques ressources 7 jours (dont stockage VM), Health Score, PRA N-1, capacity planning, surallocation, alertes. Use when working on the hypervision plugin (packages/web/src/plugins/hypervision/), the /, /e/:endpointId or /e/:endpointId/n/:nodeId routes, or its components (resource-chart, kpi-row, metrics-panel, pra-panel, capacity-chart, overcommit-card…).
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
    └── overcommit-card.tsx      # rapport surallocation + risque dynamique
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
