---
name: shared
description: Base de connaissance du package @proxmox/shared — fonctions pures testées par fichier (health, pra, capacity, overcommit, network, network-inventory, storage-inventory, vm-inventory), types partagés, THRESHOLDS, i18n fr/en. Use when working on packages/shared/, adding or modifying a pure function, a shared type, an i18n key, or a threshold.
---

# @proxmox/shared — Base de connaissance

Package TypeScript **pur** (aucune dépendance runtime) : source unique de vérité des formules déterministes partagées entre serveur et web. Chaque fonction est pure + testée (vitest colocalisé).

## 1. Règles
- Pas d'effets de bord, pas d'I/O, pas d'API Node/browser → testable partout.
- Nouvelle formule = nouvelle fonction dans le bon fichier + test colocalisé (`<fichier>.test.ts`) + export dans `index.ts`.
- **Builder avant le typecheck web** : `pnpm --filter @proxmox/shared build` (ou `pnpm build` à la racine) — `dist/` est gitignoré.
- Tests : `pnpm test` à la racine du repo (vitest).

## 2. Fichiers et exports
| Fichier | Exports | Sémantique |
|---|---|---|
| `types.ts` | Tous les types partagés (`PveVmResource`, `PveNodeStatus`, `KpiSummary`, `HealthScore`, `PraReport`, `CapacityForecast`, `MetricsPoint/Response`, `MultiDashboardSnapshot`…) + `THRESHOLDS` | Contrat API PVE → snapshot |
| `health.ts` | `computeHealthScore(nodes, kpis, pra)` | score = 100 − Σ pénalités, borné [0,100] : nœud down −25 ; CPU/RAM >90 % −20 (≥80 % −10) ; pire stockage >90 % −15 (≥80 % −8) ; PRA crit/warn −20/−10. Libellés : ≥80 Nominal · 50–79 Dégradé · <50 Critique |
| `pra.ts` | `computePra(sites, nodes, vms)` | Bascule N-1 par site : demande(S) = Σ CPU/RAM **alloués** (running + stopped) des nœuds de S ; capacité(¬S) = capacité **libre** des autres sites ; absorption = demande/capacité. Disque exclu (stockage partagé). 🟢<70 · 🟠70–100 · 🔴>100. Mono-site → `null`/`na` |
| `capacity.ts` | `linearRegression(points)`, `buildForecast(metric, dailyHistory, now?)` | Moindres carrés sur 30 j de moyennes journalières (%) ; `daysTo80/90 = (seuil − valeur courante)/pente` (null si pente ≤ 0) ; projection 30 j bornée [0,100] ; <7 points → `insufficientData: true` |
| `overcommit.ts` | `THIN_STORAGE_TYPES=['lvmthin','zfs','rbd']`, `isThinStorage`, `DEFAULT_OVERCOMMIT_CONFIG`, `overcommitTone(ratio, scale)`, `usageSeverity(pct, config)`, `computeOvercommit(kpis, config)`, `riskSeverity(usagePct, ratio, th)` | Surallocation statique (alloué/physique). Seuils pilotés par `overcommit.json` (hot-reload) ; defaults ici : usage warn 70/crit 90, `hostRamProvisionPct:10`, CPU ok ≤×2 / warn ≤×4 |
| `network.ts` | `segmentKey(bridge, vlan)`, `ipInSubnet(ip, subnet)`, `subnetOf(cidr)`, `parseVmNets(type, config)`, `managementSegments(topo)`, `buildTopology(input)`, `impactAnalysis(topo, failure)` + types (`NetworkTopology`, `TopologySwitch/Node/Vm`, `NetworkSegment`, `ImpactResult`…) | Builder pur de la topologie auto-découverte : même nom de pont + même sous-réseau = même switch physique (inféré) ; VM→pont via `bridge=` des interfaces netN/mpN de la config |
| `network-inventory.ts` | `segmentImpact(topo, bridge, vlan)`, `buildNetworkInventory(topo)`, `buildNetworkInventoryAll(…)`, `filterNetworkRows(rows, query, multiFilter?)`, `encodeNetSel/decodeNetSel` + types (`NetworkRow(All)`, `NetworkVmRef`, `InventoryFilter`) | Inventaire réseaux→VMs (groupement côté client à partir de la topologie) |
| `storage-inventory.ts` | `buildStorageInventory(storages, vms)`, `buildStorageInventoryAll(…)`, `filterStorageRows(rows, query, filter?)`, `storageSeverity(row, config)`, `sortStorageRows(rows, config, sort)` + types (`StorageRow(All)`, `StorageVmRef`, `StorageKind='shared'\|'local'`, `StorageSort*`) | Inventaire datastores→VMs (groupement côté client à partir de `/api/storage-inventory`) |
| `vm-inventory.ts` | `filterVmRows(vms, query, filter)`, `sortVmRows(vms, key, dir)`, `buildVmTree(rootLabel, endpoints, vmsByEndpoint)` + types (`VmInventoryFilter`, `DEFAULT_VM_FILTER`, `VmSortKey/Dir`, `VmTreeNode`) | Inventaire VMs (plugin vm-inventory) : recherche nom/vmid exact + filtres nœud/statut/type ; tri 8 clés (diskBytes null → fin de liste quel que soit le sens) ; tree Datacenter→endpoints→nœuds avec compteurs en marche/total |
| `system-metrics.ts` | `parsePveMapperName(name)` (LV `vg--vm--<vmid>--disk--<n>` → vmid/ctid), `mapperLabel(name)`, `isPhysicalDevice(name)` + types (`NodeSystemRow/Response`, `NodeDiskioRow/Response`, `VmDiskioPoint/Series/Response`, `PveMapperParse`, `NodeNetIface` (+ `NodeNetFwInfo`), `NodeNetRow/Response`, `VmNetPoint/Series/Response`) | Métriques nœud/VM (Telegraf) : types des routes node-system/node-diskio/node-net/vm-net + helpers purs (mapper LVM, device physique) — le décodage des `fw*` pare-feu PVE (`parsePveFwIface`) est côté **serveur** (system-routes.ts — skill `node-sensors` §6) |
| `i18n/` | `resources` (fr/en), `DEFAULT_LANG='fr'`, `Lang` | Source unique des clés i18n (§4) |

## 3. THRESHOLDS (`types.ts`) — fixes vs configurables
```ts
THRESHOLDS = { warn: 70, crit: 90, praWarn: 70, praCrit: 100, healthNominal: 80, healthDegraded: 50 }
```
- **Fixes** (formules documentées) : health score, PRA — volontairement non configurables.
- **Configurables** (`overcommit.json` à la racine, hot-reload, poussée en WS) : code couleur d'usage + ratios de surallocation → `OvercommitConfig` / `usageSeverity`.

## 4. i18n
- `i18n/fr.ts` + `i18n/en.ts` (clés plates `Record<string,string>`), exportées via `resources`.
- Préfixes de clés : `nav.*`, `overview.*`, `endpoint.*`, `node(s).*`, `kpi.*`, `metrics.*`, `health.*`, `risk.*`, `overcommit.*`, `alerts.*`, `topo.*`, `storage.*`, `common.*`, `topbar.*`.
- Ajouter une clé = l'ajouter **dans les deux** fr et en (le web consomme `resources` via i18next ; langue persistée localStorage, défaut `fr`).
- Alertes : le serveur calcule `messageKey` + `params`, le client traduit.

## 5. Tests
Colocalisés : `pra.test.ts`, `overcommit.test.ts`, `network.test.ts`, `storage-inventory.test.ts`, `network-inventory.test.ts`, `vm-inventory.test.ts`, `health.test.ts`, `capacity.test.ts`, `system-metrics.test.ts`. Exécution : `pnpm test` à la racine (vitest).
