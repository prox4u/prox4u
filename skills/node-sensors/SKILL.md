---
name: node-sensors
description: Plugin « Capteurs nœuds » (node-sensors v1) de prox4u — métriques locales Telegraf (SMART, températures, ZFS ARC, unités systemd) lues dans la base InfluxDB `raw`, servies par GET /api/node-sensors, affichées dans la page /node-sensors (4 tableaux + filtres colonnes multi-choix + filtre des sections), ET seuils capteurs personnalisés (perso ≤ firmware) persistés dans data/sensor-thresholds.json, gérés dans l'onglet Administration « Seuils capteurs » (GET/PUT/DELETE /api/admin/sensor-thresholds), ET historique des valeurs d'un capteur OU d'un disque SMART (GET /api/node-sensors-history, GET /api/smart-device-history, fenêtre modal « Historique des valeurs » avec **graphe ECharts en widget redimensionnable** (drag/resize, persistance /api/user-config par cible) depuis l'icône des tables capteurs et SMART), ET métriques système hôte (GET /api/node-system : load/swap/iowait/usage par cœur ; GET /api/node-diskio : I/O par device physique — consommées par la Vue d'ensemble (carte Système cross-node) et le Monitor nœud de la Vue VM v2 (sections Système / CPU par cœur / I/O disques)), ET historiques de jauges hôte (GET /api/node-temps : températures par chip ; GET /api/smart-temps : températures par disque SMART ; GET /api/zfs-arc : taille ARC + max + hit rate ; GET /api/node-system-history : load 1/5/15 + n_cpus + swap — tous 4 timeframes raw, cache 5 min, 400 params, source influx|insufficientData), ET mapping device-mapper → LV PVE (table dm_names écrite par le plugin exec Telegraf, consommée par GET /api/vm-diskio de la vue VM), ET empreinte matérielle des nœuds (GET /api/node-hardware : modèle CPU + DMI product/vendor/board, table quasi-statique node_hardware écrite par le script exec prox4u-telegraf-hw-info.sh — consommée par la carte « Détails hôte » de la page nœud v4), ET détail du quorum corosync (table quorum_detail écrite par le script exec prox4u-telegraf-quorum.sh qui parse `pvecm status` : expected/total votes, seuil, quorate, has_qdevice, qdevice_online — consommée par le poller pour la surveillance du Qdevice, cf. skill hypervision §11.10). Use when working on the node-sensors plugin, the /api/node-sensors, /api/node-sensors-history, /api/smart-device-history, /api/node-system, /api/node-hardware, /api/node-diskio, /api/node-temps, /api/smart-temps, /api/zfs-arc or /api/node-system-history routes, Telegraf consolidation, SMART/sensors/ZFS/systemd_units readings, the per-column filters, the value-history dialog (sensors & SMART disks), custom sensor thresholds, the « Seuils capteurs » admin tab, the overview system card (load/swap/uptime) and temp-nodes card (v3), the node monitor sections (CPU per-core, per-device disk I/O, temps, ZFS ARC, load, swap), or the dm_names Telegraf mapping.
---

# Node Sensors — métriques locales Telegraf

Plugin **`node-sensors` v1** : expose dans le dashboard les **métriques locales** que l'API PVE
ne donne pas — **SMART** (détection prédictive des pannes disque), **températures** (CPU/disques/
mémoire), **ZFS ARC**, **unités systemd** en échec — collectées par l'agent **Telegraf** tournant
en **bare-metal** sur chaque nœud Proxmox.

> Architecture globale : skill `general`. Analyse de référence ProxMenux + plan Telegraf :
> skill `monitoring-proxmenux`. Déploiement de l'agent : `deploiement/60-telegraf-nodes.sh`.

## 1. Chaîne de données

```
Nœud Proxmox (bare-metal, root)          Serveur Prox4u
─────────────────────────────            ──────────────────────────────────────────────
Telegraf (plugins smart/sensors/zfs/
systemd_units/disk/diskio/mem/cpu/
system)
   │  écritures toutes les ~10 s
   ▼
InfluxDB 3 Core — base `raw` (31 j) ◄──── GET /api/node-sensors (cache 1 min)
   │                                       try/catch par section → dernier point
   │  consolidateur (15 min, min/max)        par (node, device)/(node, chip, feature)/
   ▼                                       (node)/(node, name)
base `consolidated` (∞)
```

- **Source unique** : la base `raw` (les mesures Telegraf arrivent directement dans `raw`).
- **Dernier point par clé** : la requête trie par `time DESC` et on garde la **première** ligne
  rencontrée par clé (Map) → état courant, pas un agrégat.
- **Cache 1 min** (`CACHE_TTL_MS = 60_000`) : les données Telegraf arrivent toutes les ~10 s,
  1 min suffit et évite de marteler InfluxDB.
- **Consolidation 15 min** : le consolidateur agrège `smart_device`, `sensors`, `zfs`,
  `systemd_units` de `raw` vers `consolidated` en buckets 15 min (`min()`/`max()`, pas
  `ANY_VALUE`) → historique SMART/capteurs/ZFS **infini** (tendances long terme).

## 2. Fichiers & responsabilités

| Fichier | Rôle |
|---|---|
| `packages/shared/src/node-sensors.ts` | Types partagés : `SmartDevice`, `SensorReading`, `ZfsStatus`, `FailedUnit`, `NodeSensorsResponse`, `SensorHistoryPoint` / `SensorHistoryResponse` / `SmartHistoryResponse` (historiques, §3.2) |
| `packages/server/src/modules/nodesensors/routes.ts` | `GET /api/node-sensors` — cache 1 min, **try/catch par section** (une table absente ne fait pas perdre les autres), dernier point par clé · `GET /api/node-sensors-history` — série de température d'un capteur (raw 10 min + consolidated 15 min, fusion, seuils, cache 5 min) · `GET /api/smart-device-history` — idem pour un disque SMART (`smart_device.temp_c`, sans seuil, 0 °C exclus, cache 5 min) — les deux partagent le helper `mergedTempBuckets` |
| `packages/server/src/modules/nodesensors/index.ts` | Enregistre le module |
| `packages/web/src/plugins/node-sensors/index.ts` | Manifest `id:'node-sensors'`, route `/node-sensors`, menu order 70 (icône `Thermometer`) |
| `packages/web/src/plugins/node-sensors/pages/node-sensors.tsx` | Page 4 tableaux + `MultiFilter` (filtres colonnes multi-choix, position fixe) + filtre des sections. Le tableau capteurs colore la température selon le **seuil effectif** (perso sinon firmware) via `tempTone`/`effectiveSensorThreshold` (shared). **Icône graphique `Activity`** sur la cellule Temp. des tables capteurs ET SMART (SMART : seulement si lecture ≠ 0 °C) ouvrant la fenêtre générique `HistoryDialog` (état `historyTarget: HistoryTarget \| null`) |
| `packages/web/src/plugins/node-sensors/components/history-dialog.tsx` | Fenêtre « Historique des valeurs » **générique** — cible `HistoryTarget = { kind:'sensor'; sensor } \| { kind:'smart'; device }` : fetch `fetchSensorHistory` / `fetchSmartHistory`, toggle 31 j / 1 an, **graphe ECharts en widget redimensionnable** (grille `WidgetGridLayout`, persistance `/api/user-config` scope `sensorHistory` = `historyTargetKey`), couleur `ct.temp`, `connectNulls: false` → **les trous restent visibles**, lignes de référence `markLine` (capteur : seuil effectif rouge + firmware gris si perso ; SMART : ligne fixe **80 °C** critique), dernière mesure, état vide / erreur / chargement. **Piège** : `chartTheme()` renvoie un objet NOUVEAU à chaque appel — les deps de l'effet de fetch doivent être `theme` (string stable), jamais l'objet `ct` (boucle infinie de re-fetch) |
| `packages/web/src/components/ui/dialog.tsx` | Modal léger zéro-dépendance (overlay sombre + panneau centré, fermeture X / overlay / Échap, scroll body gelé) — réutilisable |
| `packages/shared/src/node-sensors.ts` | Types partagés + fonctions pures testées : `sensorKey`, `effectiveSensorThreshold`, `tempTone`, `smartHealthTone` (tri-state SMART), `smartTempDisplay` (0 °C = pas de lecture) |
| `packages/server/src/modules/nodesensors/thresholds.ts` | `SensorThresholdStore` — data/sensor-thresholds.json (écriture atomique tmp+rename, chmod 600, fail-fast si corrompu) |
| `packages/web/src/components/admin/sensor-thresholds.tsx` | Onglet Administration « Seuils capteurs » (tableau nœud/puce/capteur/temp/seuil firmware RO/seuil perso input clampé + reset par ligne + tout) |
| `packages/web/src/plugins/node-sensors/lib/sensor-thresholds-api.ts` | Client API /api/admin/sensor-thresholds (list/save/resetAll/resetOne) |
| `packages/shared/src/system-metrics.ts` | Types + fonctions pures testées des métriques système hôte : `NodeSystemRow/Response`, `NodeHardwareRow/Response` (empreinte matérielle : cpuModel/product/vendor/board), `NodeDiskioRow/Response`, `VmDiskioPoint/Series/Response`, `NodeNetRow/Response`, `VmNetPoint/Series/Response`, `parsePveMapperName` (LV `vg--vm--101--disk--0` → vmid/ctid, depuis le **suffixe** LV car le VG peut contenir `--`), `mapperLabel`, `isPhysicalDevice` (disques entiers seuls) |
| `packages/server/src/modules/nodesensors/system-routes.ts` | `registerNodeSystemRoutes(app, ctx, poller)` — `GET /api/node-system` (dernier point par nœud : `system`+`mem`+`cpu`, cache 60 s) · `GET /api/node-hardware` (empreinte matérielle par nœud : dernier point de la table quasi-statique `node_hardware` sur fenêtre 1 h, helper `strOrNull` mappe `unknown`/vide → null, cache 5 min `HW_CACHE_TTL_MS`, `source: 'empty'` si table absente — consommé par la carte « Détails hôte » de la page nœud v4, §3.3) · `GET /api/node-diskio?node=&timeframe=` (I/O par device physique, SQL `diskioRateSql` = bucket d'abord puis LAG des counters, cache 5 min) · `GET /api/node-net?node=&timeframe=` (trafic réseau **par interface hôte** : SQL `netRateSql` idem sur `bytes_recv`/`bytes_sent`, **vnet\*/tap\*/veth\*/lo exclus dans le SQL** — double-comptage avec la vue VM — **+ `interfaces: NodeNetIface[]` = liste des interfaces du nœud depuis l'API PVE** `GET /nodes/{n}/network` via `nodeEndpoint(ctx, poller, node)` → endpoint du snapshot → `ep.source.getNetwork()` ; joint nom PVE ↔ noyau en **candidats** `kernels = [name, ...altnames]` ; helper pur exporté `buildNodeNetIfaces(net, rows)` testé (+ `parsePveFwIface` — décryptage des interfaces pare-feu PVE `fw*`, cf. §6), cache 5 min) — consommés par la Vue d'ensemble (carte Système cross-node) ET le Monitor nœud Vue VM v2 (sections Système / CPU par cœur / I/O disques / Réseau par interface) |
| `packages/server/src/modules/vmview/vm-diskio.ts` | `GET /api/vm-diskio?endpoint=&vmid=&timeframe=` — I/O PAR DISQUE d'une VM : mapping `dm_names` (dernier point par (node, dm), fenêtre 1 h) + `diskioRateSql` sur les dm de la VM ; états `influx` / `noMapping` (table absente) / `insufficientData` (pas de LV dm pour la VM) |
| `packages/server/src/modules/vmview/vm-net.ts` | `GET /api/vm-net?endpoint=&vmid=&timeframe=` — trafic réseau **PAR INTERFACE d'une VM** (l'API PVE n'expose que l'agrégat : /cluster/resources, rrddata, QGA network-get-interfaces « not implemented ») : snapshot poller → node/type de la VM, `getVmConfig` → cartes (net0/net1, bridge, **MAC**), `net_if_mac` (fenêtre 1 h, `latestIfMacMapping`) → MAC → tap hôte, 1 `netRateSql` sur les tap résolus ; états `influx` / `noMapping` (tables absentes) / `insufficientData` (VM hors snapshot, pas de carte lue) — MAC non trouvée (VM arrêtée, SDN) = série listée `hostIface=null`, points vides |
| `packages/web/src/plugins/hypervision/components/system-nodes-card.tsx` | Carte Vue d'ensemble « Système — par nœud » (tableau cross-node, pleine largeur) : load 1/5/15 teinté vs nb de cœurs (≥1 warn, ≥2 crit), iowait (≥10 warn, ≥25 crit), swap (≥50 warn, ≥80 crit), uptime |
| `packages/web/src/plugins/vm-view_v2/components/node-system-card.tsx` | Section Monitor nœud « Système (nœud) » (chips, nœud affiché uniquement) : load 1/5/15 teinté, cœurs, iowait, swap, uptime — mêmes seuils que la carte cross-node |
| `packages/web/src/plugins/vm-view_v2/components/node-diskio-card.tsx` | Section Monitor nœud « I/O disques (nœud) » : nœud FIXE (prop), timeframe piloté par la barre d'outils de l'onglet (prop), 2 graphes (débits lecture=plein/écriture=pointillé par device ; busy % + IOPS double axe) + export CSV — base de temps commune, trous = null (pas d'interpolation) |
| `packages/web/src/plugins/vm-view_v2/components/node-net-card.tsx` | Section Monitor nœud « Réseau — par interface » : **UNE CARTE GRAPHIQUE PAR INTERFACE DU NŒUD** (même liste que la page Réseau de Proxmox — source API PVE, dispo AVANT le redéploiement de l'agent) : titre = nom PVE + badge type (pont/carte réseau/interface) + actif, joint des mesures sur `iface.kernels` (nom PVE + altnames), 1 graphe RX=plein/TX=pointillé par carte, export CSV par carte (timestamp, in_bps, out_bps), état vide **par carte** (`overview.netif.ifaceNone` si d'autres interfaces mesurées, `overview.netif.none` si rien) ; interfaces pare-feu PVE `fw*` **décryptées** (badge « pare-feu PVE · machine 102 · net0 · pont (fwbr) », infobulle = trajet paquet, bloc dépliable `FwDecodeBlock` si des fw* existent — cf. §6) — tap des VMs exclus (vue VM), trous = null |
| `packages/web/src/plugins/vm-view_v2/components/cpu-cores-card.tsx` | Section Monitor nœud « CPU par cœur » : barres horizontales usage courant (teinte <70 ok / <90 warn / ≥90 crit), tooltip user/system/iowait, export CSV, **hauteur dynamique** (≥240 px, sinon 18 px/cœur) |
| `packages/web/src/plugins/vm-view_v2/components/node-monitor.tsx` | Onglet Monitor NŒUD : graphes PVE (CPU/RAM/rootfs/réseau via `/api/metrics?node=`) + sections agent hôte ci-dessus (dont « Réseau — par interface » après le graphe Réseau agrégé) — sources **indépendantes** (si la série PVE est vide, les sections Telegraf restent montées, et inversement) |
| `packages/web/src/plugins/vm-view_v2/components/vm-monitor.tsx` | Onglet Monitor VM : section « Disques I/O — par device (hôte) » (`PerDeviceDiskSection`) après le graphe disque agrégat — 1 carte par disque (débits + saturation + export CSV) ; section « Réseau — par interface » (`PerIfaceNetSection`) après le graphe Réseau agrégat — **1 carte par NIC** (RX/TX, note « MAC non trouvée » si pas de tap), états noMapping/insufficientData/noMac lisibles |
| `packages/server/src/core/influx-consolidator.ts` | Consolidation 15 min des 4 tables Telegraf (**pas** diskio/mem/cpu/system — counters, cf. §6) |
| `packages/web/src/core/api/apiClient.ts` | `fetchNodeSensors()` · `fetchSensorHistory(node, chip, feature, range)` · `fetchSmartHistory(node, device, range)` · `fetchNodeSystem()` · `fetchNodeHardware()` · `fetchNodeDiskio(node, timeframe)` · `fetchVmDiskio(endpoint, vmid, timeframe)` · `fetchNodeNet(node, timeframe)` · `fetchVmNet(endpoint, vmid, timeframe)` |
| `deploiement/60-telegraf-nodes.sh` | Déploiement de l'agent Telegraf sur un nœud (bare-metal, idempotent, `--dry-run`). Inclut le plugin `exec` (script `/usr/local/lib/prox4u-telegraf-dm-names.sh` → table `dm_names`, §4), le 2ᵉ script exec (`/usr/local/lib/prox4u-telegraf-iface-mac.sh` → table `net_if_mac`, §4), le 3ᵉ script exec (`/usr/local/lib/prox4u-telegraf-hw-info.sh` → table `node_hardware` : modèle CPU + DMI, §4), le 4ᵉ script exec (`/usr/local/lib/prox4u-telegraf-quorum.sh` → table `quorum_detail` : détail quorum corosync / Qdevice, §4) et le plugin `net` (trafic par interface, §4) |

## 3. Endpoint API

`GET /api/node-sensors` → `NodeSensorsResponse` :

```ts
{
  timeframe: '1h',
  nodes: string[],            // nœuds avec des données (union smart ∪ sensors, trié)
  smart: SmartDevice[],       // 1 par (node, device)
  sensors: SensorReading[],   // 1 par (node, chip, feature)
  zfs: ZfsStatus[],           // 1 par node (ARC)
  failedUnits: FailedUnit[],  // 1 par (node, name) — SEULES les vraies alertes : active='failed' OR load='error' (JAMAIS sub='dead' : état de repos normal des one-shots/à-la-demande → noyait la section, ~170 lignes/nœud d'états sains)
  source: 'influx' | 'empty', // 'influx' si au moins un nœud, 'empty' sinon
  sensorThresholds: Record<string, number>  // seuils perso (clé = `node/chip/feature`) — merge serveur
}
```

### 3.1 Seuils capteurs personnalisés — onglet Administration

`GET /api/admin/sensor-thresholds` → `{ thresholds, sensors }` (`sensors` = capteurs avec `temp` courante + `firmware` (`temp_crit`) + `custom` éventuel).
`PUT /api/admin/sensor-thresholds` (body `{ thresholds }`) → remplace le jeu, **clamp perso ≤ firmware** (valeurs invalides ≤ 0 ignorées, body tableau → 400).
`DELETE /api/admin/sensor-thresholds` → tout réinitialiser · `DELETE /api/admin/sensor-thresholds/:node/:chip/:feature` → réinitialiser un capteur.
Toutes les routes sont sous `/api/admin/*` → **guard rôle admin** (skill `general`). Le firmware est lu dans InfluxDB (`sensors.temp_crit`) — le store ne le connaît pas.

### 3.2 Historique des valeurs (capteurs + disques SMART)

Deux endpoints, **même pattern** (helper partagé `mergedTempBuckets` dans `routes.ts`) :

- `GET /api/node-sensors-history?node=&chip=&feature=&range=month|year` — table `sensors`, colonne `temp_input`
- `GET /api/smart-device-history?node=&device=&range=month|year` — table `smart_device`, colonne `temp_c`

`range` défaut `month` ; l'identité **requise** (capteur : `node`+`chip`+`feature`, disque :
`node`+`device`), longueur ≤ 128 → sinon **400** via `reply.code(400).send` (`bad-sensor` /
`bad-device`) — pas `return { statusCode }`, ne fait rien en Fastify 5. Réponses :
`SensorHistoryResponse` (ci-dessous) / `SmartHistoryResponse { node, device, range, points, source }`.

```ts
{
  node, chip, feature, range,
  points: { time, temp }[],   // triée par temps croissant — SPARSE : les trous (nœud éteint) ne sont pas comblés
  threshold: number | null,   // seuil effectif (perso ≤ firmware) — ligne de référence du graphe
  thresholdCustom: boolean,
  thresholdFirmware: number | null,  // firmware — 2ᵉ ligne si un seuil perso existe
  source: 'influx' | 'empty'
}
```

- **Double source** (pattern `/api/storage-datastore-history`) : `raw` (rétention 31 j, points 10 s)
  bucketé en **10 min** (`date_bin(INTERVAL '10 minutes')` — les points 10 s feraient ~270k points
  sur 31 j par capteur, trop pour un graphe navigateur) + `consolidated` (rétention ∞, buckets
  **15 min** écrits par le consolidateur) → ~2900 pts / 31 j, ~8900 / 1 an.
- **Fusion** : au même horodatage, le point **raw prime** (plus fin) ; le consolidé n'écrase jamais
  un point raw (même logique que `datastore_metrics`).
- **Seuils** : `threshold` = perso (`store.getThresholds()[sensorKey]`) sinon firmware
  (dernier `temp_crit` non nul, fenêtre 1 h — le firmware ne bouge pas). Capteur sans `temp_crit`
  (ex. `tctl` de `k10temp`) → `threshold: null`, pas de ligne de référence.
- **Cache 5 min** par clé `node/chip/feature:range` (capteurs) / `node/device:range` (SMART).
  Identité échappée en SQL par `sqlStr` (guillemets simples doublés) — les valeurs viennent de
  la query string.
- **SMART** (`/api/smart-device-history`) : **pas de seuil** — les disques n'exposent pas de
  `temp_crit` (le front trace la référence fixe **80 °C** critique de la table, i18n
  `nodeSensors.history.smartThreshold`) et les points à **0 °C sont exclus** (prédicat
  `keep(t) => t > 0` dans `mergedTempBuckets` — 0 = pas de sonde, cf. `smartTempDisplay` ;
  sinon un disque sans capteur tracerait une ligne plate à 0 °C).

- `SmartDevice` : `device`, `model`, `serialNo`, `healthOk` (**tri-state** `boolean | null` —
  `true`=PASSED, `false`=FAILED, `null`=**inconnu** : disque virtuel / volume RAID / état
  illisible, **pas un échec**), `tempC`, `powerOnHours`, `powerCycleCount`,
  `reallocatedSectors`, `pendingSectors`, `uncorrectableSectors`, `udmaCrcErrors` + champs NVMe
  `percentageUsed`, `availableSpare`, `criticalWarning`.
- `SensorReading` : `chip`, `feature`, `tempInput`, `tempCrit`, `fanInput`, `inInput`.
- `ZfsStatus` : `arcHits`, `arcMisses`, `arcSize` (ARC) ; `poolName`/`poolState`/`poolSize`/
  `poolAllocated`/`poolFree` (pools, null dans v1).
- `FailedUnit` : `name`, `active`, `sub`, `load`.

### 3.3 Métriques système hôte (Vue d'ensemble + Monitor nœud) + I/O par device

Trois routes de plus, **même source** (tables Telegraf `raw`), dans le même module
(`system-routes.ts`, enregistrement dans `index.ts`) :

- `GET /api/node-system` → `NodeSystemResponse { nodes: NodeSystemRow[], source: 'influx'|'empty' }` —
  **dernier point par nœud** (fenêtre 10 min, `ORDER BY time DESC`, premier par clé) sur 3 tables
  jointes en TS : `system` (load1/5/15, n_cpus, uptime), `mem` (swap_total/swap_free → used =
  total−free), `cpu` (cpu-total → iowait/user/system ; `cpu0..N` → usage par cœur =
  100 − idle − iowait). Cache 60 s (données 10 s). L'API PVE donne loadavg/swap **en instantané**
  (vue nœud) mais **ni historique, ni iowait, ni par cœur** — d'où la source agent.
  **Consommé 2×** (un fetch par vue, tick 60 s) : la carte « Système » cross-node de la Vue
  d'ensemble (hook `useNodeSystem` dans `overview.tsx`) et le Monitor nœud Vue VM v2
  (sections Système + CPU par cœur — `node-monitor.tsx` cherche la ligne du nœud affiché).
- `GET /api/node-hardware` → `NodeHardwareResponse { nodes: NodeHardwareRow[], source:
  'influx'|'empty' }` — **empreinte matérielle par nœud** (modèle CPU + DMI) : dernier point
  par nœud sur la table quasi-statique `node_hardware` (script `exec` Telegraf, §4, fenêtre
  1 h, `ORDER BY time DESC`, premier par nœud). `NodeHardwareRow { node, cpuModel, product,
  vendor, board }` — chaque champ `string | null` : le helper `strOrNull` mappe `unknown`
  (sentinelle du script = valeur illisible, ex. DMI absent en VM) et le vide en `null` —
  **jamais de valeur inventée**. Cache 5 min (`HW_CACHE_TTL_MS`). `source: 'empty'` si la
  table est absente (agent pas encore (re)déployé) → le front affiche « — ». **Consommé** par
  la carte « Détails hôte » de la page nœud v4 (skill `hypervision` §11.6 — fetch 60 s,
  `hwRow = hwRows.find(r => r.node === nodeId)`).
- `GET /api/node-diskio?node=&timeframe=` → `NodeDiskioResponse { timeframe, node, devices:
  NodeDiskioRow[], source: 'influx'|'insufficientData' }` — I/O **par device physique**
  (nvme0n1, sda… ; dm-N/loop/md/sr/ram exclus **dans le SQL**, **partitions** sda1/nvme0n1p1
  filtrées **côté TS** par `isPhysicalDevice`). `timeframe ∈ hour|day|week|month` → buckets
  1 min/1 h, 5 min/24 h, 1 h/7 j, 1 j/30 j, **tous sur `raw`** (rétention 31 j couvre 30 j —
  diskio n'est pas consolidée, cf. §6). Cache 5 min par (node, timeframe). 400 sans `node` ou
  timeframe invalide.
- `GET /api/vm-diskio?endpoint=&vmid=&timeframe=` (module `vmview`) → `VmDiskioResponse {
  timeframe, vmid, series: VmDiskioSeries[], source: 'influx'|'insufficientData'|'noMapping' }` —
  I/O **PAR DISQUE d'une VM** : les disques PVE (LVM-thin) sont des LV device-mapper vus comme
  `dm-N` côté hôte ; le mapping dm-N → LV (`vg--vm--<vmid>--disk--<n>`) vient de la table
  `dm_names` (plugin `exec` Telegraf, §4) — **l'API PVE ne l'expose pas**. Sélection : dernier
  point par (node, dm) sur 1 h, `parsePveMapperName` filtre `kind==='vm' && id===vmid` (QEMU
  seulement — les CT `base-<ctid>--` sont parsés mais non demandés). 1 requête `diskioRateSql`
  par nœud (`name IN (…)`). Libellé UI = `mapperLabel` (`vm-100-disk-0 (vg rapide)`).

 - `GET /api/node-net?node=&timeframe=` → `NodeNetResponse { timeframe, node, interfaces:
   NodeNetIface[], rows: NodeNetRow[], source: 'influx'|'insufficientData' }` — trafic réseau
   **par interface hôte** (table `net`, plugin Telegraf) : NICs physiques + ponts (vmbr*),
   **vnet\*/tap\*/veth\*/lo exclus dans le SQL** (le trafic des tap est montré dans le Monitor
   de chaque VM — sinon double-comptage). **`interfaces`** = liste des interfaces du nœud
   (API PVE `GET /nodes/{n}/network` — dispo même si `rows` est vide, agent non déployé) :
    `NodeNetIface { name (nom PVE), kernels: string[] (candidats noyau = [name, ...altnames]),
    kind: 'bridge'|'nic'|'other'|'firewall', active: boolean|null,
    firewall?: NodeNetFwInfo { vmid, ifIndex, role:'bridge'|'line'|'port' } }` ; les
    devices noyau vus seulement dans les mesures (ex. `fw*` internes au firewall PVE)
    sont ajoutés par `buildNodeNetIfaces` (helper pur exporté) — les `fw*` qui matchent
    `parsePveFwIface` reçoivent `kind:'firewall'` + métadonnées `firewall` (décodage
    VMID / index d'interface / rôle), les autres `kind:'other'` (dégradation douce,
    jamais de faux décodage). Joint des mesures : `rows[].iface` ∈ `kernels`
   (sur un nœud PVE le device noyau est renommé selon /etc/network/interfaces → le nom PVE est
   le cas courant, vérifié live ; `altnames` = noms dérivés du MAC en secours). Même buckets
   que node-diskio (raw, 31 j), cache 5 min par (node, tf), 400 sans `node` ou timeframe
   invalide. Table absente (agent non (re)déployé) → `insufficientData` (avec `interfaces`
   renseigné), pas une erreur HTTP.
 - `GET /api/vm-net?endpoint=&vmid=&timeframe=` (module `vmview`) → `VmNetResponse {
   timeframe, vmid, series: VmNetSeries[], source: 'influx'|'insufficientData'|'noMapping' }` —
   trafic **PAR INTERFACE d'une VM**. L'API PVE n'expose que l'agrégat (vérifié 9.1/9.2 :
   /cluster/resources, rrddata ; QGA `network-get-interfaces` « not implemented ») → le trafic
   est lu côté hôte sur le **device tap** de la carte (plugin `net`), joint à la config PVE par
   **MAC** (robuste bridge/SDN/OVS/LXC, indépendant du nommage vnet/tap de PVE) : snapshot
   poller → `vm.node`/`vm.type`, `getVmConfig` (cache 1 h) → cartes `net0`/`net1` (bridge, MAC),
   `net_if_mac` (fenêtre 1 h) → MAC → tap. 1 requête `netRateSql` sur les tap résolus
   (`"interface" IN (…)`). `noMapping` = tables absentes (agent à (re)déployer — **pas une
   erreur HTTP**), `insufficientData` = VM hors snapshot ou aucune carte lue. MAC non trouvée
   côté hôte (VM arrêtée → pas de tap) : série listée `hostIface=null`, points vides — jamais
   de valeur inventée.

**SQL de débit — `diskioRateSql` / `netRateSql(where, bucket, bucketSec, window)`** (exportées, testées) :
`read_bytes`/`write_bytes`/`reads`/`writes`/`io_time` sont des **counters** (reset au reboot) ;
`io_await` est une jauge (ms). Pattern : **bucket d'abord** (`date_bin` + `MAX` colonaires sur
les counters — pas de window function sur les ~60k points/device/7 j), **puis `LAG` de bucket en
bucket** (`WINDOW w AS (PARTITION BY name ORDER BY t)`) ; débits = Δ(counter) / durée de bucket ;
**delta négatif (reboot) → NULL via `normRate`, jamais un pic faux** ; `busy_pct` =
Δ(`io_time`, ms d'occupation réelle) / durée — 0–100, **convention iostat** (PAS `io_util`
Telegraf, basé sur `weighted_io_time`, qui **dépassait 100 %** observé 233 % avec du parallélisme).

### 3.4 Historiques de jauges hôte (Monitor nœud v4 + Vue d'ensemble v3)

Quatre routes de plus, **même source** (tables Telegraf `raw`), même module
(`system-routes.ts`) : mêmes buckets `HOST_DISKIO_TF` que node-diskio (hour → 1 min/1 h,
day → 5 min/24 h, week → 1 h/7 j, month → 1 day/30 j), cache 5 min par (node, timeframe),
400 sans `node` ou timeframe invalide, `source: 'influx' | 'insufficientData'`.
**Contrairement au débit (counters + LAG), ce sont des JAUGES** : `max` du bucket (pic de la
fenêtre) — pas de LAG, pas de `normRate`.

- `GET /api/node-temps?node=&timeframe=` → `NodeTempsResponse { timeframe, node, series:
  NodeTempSeries[], source }` — températures **PAR CHIP** (table `sensors`) :
  `tempsSql` = `max(temp_input)` par (chip, bucket), `temp_input IS NOT NULL` (les features
  ventilateurs/tensions sans température sont exclues dans le SQL). Un chip regroupe plusieurs
  features (par cœur, Tdie/Tctl…) → le max du bucket représente le chip. Parsers
  `tempsRowsToSeries` : gardes `r.temp == null` + `Number.isFinite` (**piège `Number(null)` = 0**
  — `num()` est null-safe : `if (v == null) return null`).
- `GET /api/smart-temps?node=&timeframe=` → `SmartTempsResponse { …, series: SmartTempSeries[] }`
  — températures **PAR DISQUE** (table `smart_device`) : `smartTempsSql` = `max(temp_c)` par
  (device, bucket), **`temp_c > 0` dans le SQL** (0 °C = pas de capteur — ils traceraient une
  ligne plate à 0 °C, cf. `smartTempDisplay`). Le **modèle** est joint ensuite par une 2ᵉ
  requête glissante 1 h (`SELECT device, model … ORDER BY time DESC`, dernier par device).
- `GET /api/zfs-arc?node=&timeframe=` → `ZfsArcResponse { …, points: ZfsArcPoint[] }` — ZFS ARC
  (table `zfs`) : `zfsArcSql` mélange jauges et counters **dans le même bucket** —
  `max(arcstats_c)` (taille courante) / `max(arcstats_c_max)` (max) +
  `max/min(arcstats_hits)` / `max/min(arcstats_misses)` ; **hit rate = Δ dans le bucket
  (max − min, PAS de LAG entre buckets)** → helper partagé `zfsHitRatePct(Δhits, Δmisses)`
  (`null` si compteurs nuls, total = 0 ou delta négatif = reset). **Découverte live** : sur le
  parc actuel `arcstats_hits/misses` = **0 systématiquement** (nœud `proxmox` sans pool ZFS —
  LVM) → le front **masque la série hit rate** quand tout est nul (pattern ProxMenux
  `hasZfsArc` — jamais de série inventée).
- `GET /api/node-system-history?node=&timeframe=` → `NodeHostHistoryResponse { …, points:
  NodeHostHistoryPoint[] }` — **load 1/5/15 + n_cpus** (table `system`, `max` du bucket) **+
  swap** (table `mem` : utilisé = `max(swap_total) − min(swap_free)`, seulement si
  total > 0 et free ∈ [0, total] — sinon null, jamais négatif). **2 requêtes isolées**
  (`hostHistorySystemSql` + `hostHistoryMemSql`) fusionnées par `mergeHostHistory` (union des
  horodatages de buckets) — **une table absente ne fait pas perdre l'autre**. Helper partagé
  `swapPct(used, total)`.

**Consommés** : `vm-view_v4` Monitor nœud (6 widgets — skill `vm-inventory` §11 : `temp-cpu`,
`smart-temps`, `zfs-arc`, `load`, `swap` + `smart-health` sur le live `/api/node-sensors`) et
`hypervision_v3` Vue d'ensemble (widget `temp-nodes` sur le live `/api/node-sensors` —
skill `hypervision` §10). Tests : 19 nouveaux (builders SQL + parsers + merge) dans
`system-routes.test.ts` → 215 tests serveur.

## 4. Mesures InfluxDB (tables Telegraf)

| Table | Clé d'unicité | Colonnes clés |
|---|---|---|
| `smart_device` | `node`, `device` | `model`, `serial_no`, `health_ok`, `temp_c`, `power_on_hours`, `power_cycle_count`, `reallocated_sectors_count`, `pending_sector_count`, `uncorrectable_sector_count`, `udma_crc_errors`, `percentage_used`, `available_spare`, `critical_warning` |
| `sensors` | `node`, `chip`, `feature` | `temp_input`, `temp_crit`, `fan_input`, `in_input` |
| `zfs` | `node` | ~253 colonnes `arcstats_*` — consommées : `arcstats_c` (taille courante), `arcstats_c_max` (max), `arcstats_hits` / `arcstats_misses` (counters, 0 sur le parc actuel — nœud sans pool ZFS), `arcstats_size` |
| `systemd_units` | `node`, `name` | `active`, `sub`, `load` (filtré `active='failed' OR load='error'` — **vraies alertes seulement**) |
| `system` | `node` | `load1`, `load5`, `load15`, `n_cpus`, `uptime` |
| `mem` | `node` | `swap_total`, `swap_free` (PAS de `swap_used` — calculé total−free), `used`, `available_percent` |
| `cpu` | `node`, `cpu` | `cpu` = `cpu-total` ou `cpu0..N` ; `usage_user/nice/system/idle/iowait/irq/softirq/steal` (somme = 100) |
| `diskio` | `node`, `name` | counters : `read_bytes`, `write_bytes`, `reads`, `writes`, `read_time`, `write_time`, `io_time`, `weighted_io_time` · jauges : `io_await` (ms), `io_svctm`, `io_util` (fraction 0–1, peut **>1**), `iops_in_progress` · `wwid` (NVMe) |
| `dm_names` | `node`, `dm` | `mapper_name` (LV PVE, ex. `rapide--vm--100--disk--0`), `present` (champ factice — une ligne line-protocol sans champ est invalide). Écrite par le **plugin `exec`** Telegraf (script `/usr/local/lib/prox4u-telegraf-dm-names.sh` → `/sys/block/dm-*/dm/name`) ; quasi statique, relue toutes les 10 s ; **pas consolidée** (dimension, pas une mesure) |
| `net` | `node`, `"interface"` (colonne à **guillemets doubles** en SQL — tag Telegraf) | counters : `bytes_recv`, `bytes_sent` (+ errin/errout/dropin/dropout) — toutes les interfaces : NICs physiques, ponts vmbr*, **et tap des VMs (vnet*/tap*/veth*)** — source du trafic **par interface** (nœud + VMs, cf. §3.3) ; **pas consolidée** (counters) |
| `net_if_mac` | `node`, `iface` | `mac` (minuscules), `present`. Écrite par le **plugin `exec`** (script `/usr/local/lib/prox4u-telegraf-iface-mac.sh` → `/sys/class/net/*/address`) ; quasi statique (change au start/stop des VMs) ; joint **carte VM ↔ tap hôte** par MAC pour `/api/vm-net` ; **pas consolidée** (dimension) |
| `node_hardware` | `node`, `cpu_model`, `product`, `vendor`, `board` (tags) | `present` (champ factice — une ligne line-protocol sans champ est invalide). Écrite par le **plugin `exec`** (script `/usr/local/lib/prox4u-telegraf-hw-info.sh` → `/proc/cpuinfo` `model name` + `/sys/class/dmi/id/{product_name,sys_vendor,board_name}`) ; quasi statique (change au remplacement de machine) ; valeur illisible → tag `unknown` (mapé en `null` par `strOrNull` pour `/api/node-hardware`) ; **pas consolidée** (dimension) |
| `quorum_detail` | `node` | `expected_votes`, `total_votes`, `quorum_threshold`, `quorate` (0/1), `has_qdevice` (0/1), `qdevice_online` (0/1). Écrite par le **plugin `exec`** (script `/usr/local/lib/prox4u-telegraf-quorum.sh` → parse `pvecm status` corosync) ; quasi statique (change au changement de membership) ; **pas consolidée** ; **consommée par le poller** (`readQuorumDetail`, cache 30 s, fenêtre 10 min) pour l'état réel du Qdevice + l'alerte `qdevice-down` (cf. skill `hypervision` §11.10) — l'API PVE n'expose que `quorate`+`nodes` |

> ⚠️ La table SMART s'appelle **`smart_device`** (pas `smart`) — piège classique, déjà corrigé.

> ⚠️ **`systemd_units` — sémantique des états** (plugin Telegraf sans filtre = D-Bus `ListUnits()`,
> toutes les unités connues du manager, ~170/nœud) : `inactive (dead)` est l'état de repos **normal**
> des one-shots (terminés au boot/timer), des unités à la demande (`rescue`, `hibernate`…) et des
> non-installées (`load='not-found'` — vestiges de provisioning : références à des unités dont le
> fichier a disparu, stables au travers des redémarrages, souvent identiques sur tous les nœuds d'une
> même image). Ne jamais alerter sur `dead` — seuls `active='failed'` et `load='error'` sont des
> alertes (exemple réel env. de test : `openipmi.service` failed sur nœud sans BMC IPMI).

> ⚠️ **Format line protocol des scripts `exec` (piège majeur — corrigé 2026-11-19)** : InfluxDB 3
> Core interprète `key="valeur"` comme un **CHAMP string**, pas un tag → une ligne
> `mesure tag="v" champ=1i` est **invalide** (« Found trailing content » / « No fields were
> provided ») et la table n'est **jamais créée** (échec silencieux côté Telegraf). Le format
> correct (identique au helper `buildLine`/`escapeTag` du poller) :
> `mesure,tag1=v1,tag2=v2 champ=1i` — **virgule après la mesure**, tags **NON quoted**, valeurs
> de tags **échappées** (`\` `,` `=` espace → backslash, cf. `esc()` des scripts), **espace avant
> les champs**. Le tag `node` est ajouté par `global_tags` (pas dans le script). Symptôme d'un
> script mal formé : la table absente de `SHOW TABLES` alors que les autres plugins écrivent.
> Validé en direct sur l'instance (write_lp + relecture).

## 5. Page web (`/node-sensors`)

- **4 tableaux** : SMART (nœud, device, modèle, santé, temp, secteurs reallocated, usure NVMe),
  capteurs (nœud, puce, feature, temp, seuil critique, ventilateur), ZFS ARC (nœud, hits, misses,
  size), unités systemd (nœud, unité, active, sub, load).
- **Santé SMART tri-state** : badge OK (vert) / CRITIQUE (rouge) / **Inconnu** (gris) via
  `smartHealthTone` — un disque sans SMART (QEMU, RAID) est « Inconnu », **pas** « CRITIQUE ».
  La valeur « Inconnu » est proposée dans le filtre santé.
- **Temp SMART `0 °C` → « — »** : `smartTempDisplay` — Telegraf écrit `0` quand le disque n'a pas
  de capteur (aucun disque réel à 0 °C) → affiché « — » (badge gris), pas `0°C`.
- **Filtre des sections** : dropdown multi-choix (option « Toutes ») qui montre/masque les 4
  tableaux.
- **Filtres colonnes** : un `MultiFilter` par colonne de statut (nœud, device, santé, …).
- **Historique des valeurs** : chaque température des tables capteurs **et SMART** porte une
  **icône graphique** (lucide `Activity` ; SMART : seulement si lecture ≠ 0 °C) → ouvre
  `HistoryDialog` (modal `ui/dialog.tsx`, générique capteur/disque) : identité
  `node/chip/feature` ou `node/device`, dernière mesure, toggle **31 j / 1 an** (style du range
  stockage), **graphe ECharts en WIDGET redimensionnable** (grille `WidgetGridLayout` — socle
  `core/widgets`, skill `general` §12) : couleur thème `ct.temp`, aire dégradée,
  `connectNulls: false` → **les trous = nœud sans mesure (éteint) restent visibles, jamais
  comblés**), `markLine` — capteur : seuil effectif (rouge pointillés) + seuil firmware (gris) si
  perso ; SMART : ligne critique fixe **80 °C** (pas de `temp_crit` pour les disques), note
  explicative des trous. i18n `nodeSensors.history.*` / `nodeSensors.range.*`.
  - **Personnalisation** : le graphe est un widget unique (`sensor-history-chart`, w12 h6, minH 4)
    **redimensionnable** (drag du coin `se-resize`) + toolbar (bibliothèque + Réinitialiser) ;
    persistance par compte via `/api/user-config` — **scope `sensorHistory` = `historyTargetKey`**
    (capteur : `sensorKey` = `node/chip/feature` ; disque : `node/device`). La taille est
    **persistée par cible** (survit à la reconnexion). Le corps gère les états
    chargement (Skeleton) / erreur / vide / graphe ; `HistoryChart` passe de `h-72` fixe à
    **`h-full`** (remplit la carte du widget — le `ResizeObserver` de `useEChart` gère le resize
    RGL). Le sélecteur de période (31 j / 1 an) et l'en-tête (identité + dernière mesure) restent
    **hors grille** (en-tête du modal).
- **`MultiFilter`** : dropdown avec checkboxes, valeurs extraites des données, **option « Tous »**
  en haut (coche = tout sélectionner, décoche = tout libérer). **`position:fixed`** calculé depuis
  `getBoundingClientRect()` du bouton (pas d'overflow du tableau), **fond opaque** `#0f1117`,
  `z-50`.

## 6. Décisions actées

- **Option A** : nouvelle famille de plugin `node-sensors` v1 — **aucun module existant touché**
  (protège l'existant). Un futur backend Zabbix/Prometheus partagera le namespace
  `/api/node-sensors/*`.
- **Cache 1 min** (pas 5 min comme les autres routes) — les mesures arrivent toutes les ~10 s.
- **try/catch par section** (pas un seul bloc) — une table absente ou une colonne inconnue ne
  fait pas perdre les autres sections ; `source` reste `influx` si au moins un nœud a des données.
- **Consolidation 15 min** (pas 5 min) + agrégats `min()`/`max()` (pas `ANY_VALUE`) — les mesures
  arrivent toutes les 10 s, 15 min est un bon compromis volume/lisibilité.
- **Seuils capteurs personnalisés** (livré — plan `docs/plan-seuils-capteurs.md`) :
  seuil perso **≤ firmware** (clamp input `max` + clamp serveur au PUT), jamais au-dessus.
  Persistance `data/sensor-thresholds.json`. **Coloration du tableau capteurs = seuil
  effectif** (`effectiveSensorThreshold` = perso sinon firmware) via `tempTone` :
  `crit` si temp ≥ seuil effectif, `warn` dans la marge de 20 °C sous le seuil, `ok` sinon ;
  sans seuil (ni perso ni firmware) → repli historique 80/60 °C. Le tableau **SMART** garde
  le seuil 80/60 (pas de `temp_crit` pour les disques).
- **Santé SMART tri-state** (livré) : `healthOk` est `boolean | null` — `true`=PASSED,
  `false`=FAILED, `null`=**inconnu** (pas de SMART : disque virtuel, volume logique RAID, état
  illisible). Raison : sur du **vrai matériel**, un disque derrière un contrôleur RAID renvoie
  aussi `health_ok = NULL` ; mapper NULL → `false` afficherait « CRITIQUE » (faux positif). Le
  parsing serveur (`parseHealthOk`, routes.ts) et le consolidateur 15 min préservent le NULL.
  `0 °C` = pas de lecture (`smartTempDisplay`) → affiché « — ».
- **Historique des valeurs** (livré) : résolution **raw 10 min / consolidated 15 min** — jamais de
  points 10 s bruts dans le graphe (~270k pts / 31 j / capteur). Les **trous de la série sont des
  données** (nœud éteint = pas de mesure) : la série est sparse, `connectNulls: false`, **aucune
  complétion / interpolation** (anticiper du vrai matériel : un nœud éteint pendant des jours n'est
  pas une panne de l'app). `max(temp_input)` par bucket (cohérent avec le consolidateur).
- **Métriques système hôte + I/O disques** (livré — Vue d'ensemble P0/P1/P2 + Monitor VM P0) :
  la Vue d'ensemble consommait **zéro** métrique Telegraf (100 % PVE) ; 3 cartes ajoutées
  (Système par nœud / I/O disques par device physique / CPU par cœur) + section Monitor VM
  « I/O par device ». Décisions :
  - **Busy % depuis le counter `io_time`** (occupation réelle, 0–100, iostat) — PAS `io_util`
    Telegraf (basé sur `weighted_io_time`, fraction 0–1 **observée > 1** : 233 % sur sda avec
    du parallélisme NCQ).
  - **Bucket d'abord, LAG ensuite** (`date_bin` + `MAX` colonaires, puis `LAG` de bucket en
    bucket) — pas de window function ligne à ligne sur ~1,5 M points / 7 j ; delta négatif
    (reset counter au reboot) → **NULL** (`normRate`), jamais un pic faux.
  - **`diskio`/`mem`/`cpu`/`system` non consolidées** : les 4 timeframes lisent `raw` (rétention
    31 j couvre `month` = 30 j) ; le consolidateur (15 min, min/max) est réservé aux tables de
    jauges — pour des counters, il faudrait pré-calculer des **taux** par bucket (extension).
  - **Mapping dm-N ↔ LV par l'agent** (plugin `exec` Telegraf → table `dm_names`) : l'API PVE ne
    l'expose pas (`/nodes/{n}/disks/list` = disques physiques seulement) ; le script lit
    `/sys/block/dm-*/dm/name` (l'agent tourne en root, tourne au même rythme que le reste).
    Quasi statique → lu sur une **fenêtre 1 h** (dernier point par (node, dm)), pas consolidée.
  - **Dégradations encodées, jamais comblées** : `noMapping` (table absente = agent pas encore
    (re)déployé — message lisible dans l'UI, pas une erreur HTTP), `insufficientData` (mapping
    présent mais aucun LV dm pour la VM — stockage ZFS/dir), holes visibles dans les séries.
  - **Devices physiques = disques entiers seuls** : dm-N exclus dans le SQL (ce sont les LV —
    I/O double-comptée avec le disque sous-jacent), **partitions** (sda1, nvme0n1p1) filtrées
    côté TS (`isPhysicalDevice`) — le disque entier porte déjà toute l'I/O.
  - **Placement UI (arbitrage 2026-11-13)** : la Vue d'ensemble ne garde que la carte
    « Système » **cross-node** (tableau pleine largeur w=12, rangée y=5) — c'est la seule vue
    vraiment « parc » ; l'I/O par device et le CPU par cœur sont des **drill-down d'un nœud**
    → dans l'onglet **Monitor du nœud** (Vue VM v2), où le nœud est fixe (pas de sélecteur) et
    le timeframe de l'I/O disques est piloté par la barre d'outils de l'onglet. `LAYOUT_VERSION`
    bumpé (2→3→4) → layouts persistés antérieurs jetés au rechargement.

- **Réseau par interface** (livré — Monitor nœud + Monitor VM) : l'API PVE n'expose **pas** le
  trafic par interface d'une VM (vérifié live 9.1/9.2 : `/cluster/resources` + `rrddata` =
  agrégat par VM, QGA `network-get-interfaces` « not implemented » et sans compteurs de trafic)
  → source retenue : **côté hôte**, plugin Telegraf `net` (counters `bytes_recv`/`bytes_sent`
  par interface, 10 s) :
  - **Joint carte VM ↔ tap hôte par MAC** (pas par nom de device) : `getVmConfig` donne le MAC
    des `net0`/`net1` (cache 1 h), l'agent écrit `net_if_mac` (iface → MAC, script exec,
    fenêtre 1 h) — robuste bridge/SDN/OVS/LXC, **indépendant du nommage vnet/tap de PVE**.
    MACs normalisés **minuscules** des deux côtés.
  - **`/api/node-net` exclut vnet\*/tap\*/veth\*/lo dans le SQL** : ces tap portent le trafic
    des VMs, montré dans le Monitor de chaque VM — les inclure au niveau nœud = double-comptage.
    La vue nœud garde NICs physiques + ponts (vmbr*).
  - **`net`/`net_if_mac` non consolidées** (counters / dimension) : `raw` seul (31 j), même
    buckets que diskio ; dégradations identiques (`noMapping` = tables absentes = agent à
    (re)déployer, pas une erreur HTTP ; MAC non trouvée = série `hostIface=null`, points vides).
  - **Unités** : PVE `netin`/`netout` = **octets** cumulés depuis le boot (pas bits — confirmé
    forum PVE) → les débits calculés (octets/s) partagent `formatBps` avec les graphes agrégés
    existants, pas de facteur 8.
  - **Liste des interfaces = API PVE, 1 carte graphique par interface** (retour UI 2026-11-13 :
    « je veux ces interfaces » — la liste de la page Réseau de Proxmox, pas un bloc générique
    vide). `registerNodeSystemRoutes(app, ctx, poller)` résout nœud → endpoint via
    `nodeEndpoint(ctx, poller, node)` (snapshot du poller) → `ep.source.getNetwork()`
    (`/nodes/{n}/network` : `iface`, `altnames`, `type`, `active` — champs conservés par
    `Prox4uClient.getNetwork()` : `NodeNic`/`NodeBridge` + `altnames?`/`active?`, shared/network.ts).
    **Joint noyau** : sur un nœud PVE le device noyau est **renommé** selon /etc/network/interfaces
    → Telegraf rapporte le NOM PVE (`nic2`, vérifié live — `altnames` = noms dérivés du MAC
    `enx9c6b00dd220c`, ce ne sont PAS les noms courants) → `kernels = [name, ...altnames]`
    (candidats, le joint passe sur n‧importe lequel). Pont : kernel = nom du pont. PVE
    `active` présent seulement si UP (absent sinon → null, l’UI n’affiche « inactif » que sur
    explicite). `buildNodeNetIfaces(net, rows)` (pur, exporté, testé) : union des kernels vus
    seulement dans les mesures (ex. `fw*` internes au firewall PVE) — décodées si le nom
    matche la nomenclature pare-feu (`parsePveFwIface`), sinon `kind:'other'` — rien n'est
    perdu, jamais de faux décodage. Web : 1 `Card` par interface (titre = nom PVE + badge
    kind/actif, CSV par carte, état vide par carte ; i18n
    `overview.netif.{ifaceNone,kind.*,active,inactive}`). Les mesures restent dispo même si
    la liste PVE échoue (nœud hors ligne → `kind:'other'`).
  - **Décryptage des interfaces pare-feu PVE `fw*`** (demande user 2026-11-13 — « ces noms
    ne veulent rien dire » + texte de décryptage fourni par l'user) : PVE ne peut pas
    appliquer le pare-feu sur le pont principal (vmbr*) — les règles toucheraient toutes
    les machines du pont ; il crée donc par interface de machine une chaîne
    `fwbr<vmid>i<n>` (pont du pare-feu, le tap de la machine y est connecté, c'est ici que
    les règles s'appliquent) → `fwln<vmid>i<n>` (extrémité interne de la paire veth) →
    `fwpr<vmid>p<n>` (extrémité externe, connectée au vmbr*). **Règle générique et
    défensive** : regex `/^fw(br|ln|pr)(\d+)([ip])(\d+)$/` (`parsePveFwIface`, exportée,
    testée — br/ln/pr × i/p × vmid multi-chiffres × ifIndex > 9 + non-matches → null) : le
    rôle vient du **préfixe** br/ln/pr (la lettre i/p n'est qu'un séparateur à consommer —
    robuste si PVE la change) ; n'importe quel nombre de chiffres (VM **et** LXC,
    net0…net12+). Tout non-match → `kind:'other'` (libellé générique « interface ») : pas
    de faux positif, pas de crash, pas de valeur inventée ; si PVE change la nomenclature
    dans une future version, dégradation douce (données gardées, seul le libellé
    explicatif est perdu). Appliquée **uniquement** à l'union des mesures (jamais à la
    config PVE). **Web** : carte pare-feu = titre « pare-feu PVE · machine 102 · net0 ·
    pont (fwbr) » (calculé depuis le parse, aucun durcissement) + infobulle du titre =
    trajet du paquet (interpolé `{{vmid}}`/`{{n}}`) + bloc dépliable `FwDecodeBlock`
    (`<details>`) affiché **seulement si des fw\* existent** sur le nœud : nomenclature
    (avec la liste des machines **réellement présentes** — dynamique), les 3 rôles, le
    trajet. i18n `overview.netif.kind.firewall` + `overview.netif.fw.*` (fr/en).

## 7. Pièges rencontrés (corrigés — ne pas réintroduire)

- **`source: 'empty'` systématique** : les colonnes ZFS s'appellent `arcstats_hits` /
  `arcstats_misses` / `arcstats_size` (pas `arc_hits`). Une requête sur une colonne inexistante
  levait une erreur → **try/catch par section** + noms de colonnes exacts.
- **`health_ok` NULL ≠ `false`** (faux positif « CRITIQUE ») : InfluxDB 3 renvoie un **boolean**
  `true`/`false`, mais un disque **sans SMART** (QEMU, volume logique RAID, état illisible)
  renvoie **NULL** (champ absent). Mapper NULL → `false` affichait « CRITIQUE » sur des disques
  virtuels → **tri-state** `healthOk: boolean | null` : `parseHealthOk` (routes.ts) renvoie
  `null` pour NULL, `smartHealthTone` → badge gris « Inconnu ». Le consolidateur 15 min n'écrit
  `health_ok` que si la fenêtre en contient une valeur (sinon `num(true)`→0 = FAILED, faux).
- **Filtres superposés / illisibles** : le dropdown initial était **transparent** et **coupé par
  l'overflow du tableau** → `position:fixed` (calculé depuis le bounding rect du bouton), **fond
  opaque**, `z-50`. Un `position:absolute` dans un conteneur `overflow:hidden` serait masqué.
- **400 « silencieux » (Fastify 5)** : `return { statusCode: 400, … }` depuis un handler async
  **ne set pas le code HTTP** (renvoyé tel quel dans le body, status 200) — utiliser
  `reply.code(400).send(…)` comme partout ailleurs dans le codebase (vérifié test + live).
- **Message réel InfluxDB 3 Core, table absente** : `Error during planning: table
  'public.iox.dm_names' not found` (HTTP 400). La détection `noMapping` de `vm-diskio` doit
  matcher **`not found`** (regex `/cannot find table|not found|does not exist/i`) — un regex
  qui attend `cannot find table` seul (SQLx v1) échoue sur la formulation réelle. Les tests
  mockent le message **exact** de l'API, pas une approximation.
- **`io_util` > 100 %** : Telegraf expose `weighted_io_time` comme `io_util` (fraction 0–1,
  **peut dépasser 1** — observé 233 % sur sda, parallélisme NCQ). Jamais de « busy % » depuis
  `io_util` : le busy est le Δ du counter `io_time` (0–100, convention iostat).
- **Double-comptage I/O** : dm-N (LV) + partitions + disque physique portent la **même** I/O.
  Une carte « disques » ne doit contenir que les disques entiers (SQL : exclusion
  `dm-/loop-/md-/sr-/ram` ; TS : `isPhysicalDevice` pour les partitions).
- **`*/` dans un commentaire bloc TypeScript** (touché 2× : `dm-*/`, puis
  `(fwbr*/fwln*/fwpr*)` dans system-metrics.ts) : un `dm-*/` dans un commentaire `/* … */`
  (ex. « disques dm-*/loop */md… ») **ferme le commentaire prématurément** → esbuild
  « Unexpected token » au build, sans message pointant la cause. Dans un commentaire bloc,
  éviter `*/` même en apparence (écrire `dm-x/`, `(fwbr, fwln, fwpr)`, ou passer en
  commentaire ligne).
- **Line protocol Telegraf sans champ** : `dm_names dm="dm-10"` seul est **invalide** (une
  ligne line-protocol doit porter au moins un champ) → le script dm-names écrit toujours un
  champ factice `present=1i`. Oublier ce champ = lignes rejetées silencieusement, table vide.
- **Colonne `interface` (table `net`)** : le tag Telegraf `interface` devient une colonne SQL
  à **guillemets doubles** (`SELECT "interface" FROM net`) ; sans quotes, DuckDB/InfluxDB 3
  peut la refuser. Dans `netRateSql` on l'alias immédiatement (`"interface" AS iface`).
- **`normRate(null)` vaut 0, pas null** : `Number(null)` = 0 → `0 >= 0` → 0. Dans les tests
  qui simulent un **reset de counter** (delta négatif), il faut un **nombre négatif** dans la
  ligne mock (`out_bps: -1`), pas `null` — sinon on teste le chemin « zéro » au lieu du
  chemin « trou » (test vm-net corrigé).
- **`{{x}}` → `{x}` en f-string Python lors d'une injection i18n** : un script qui ajoute
  des clés i18n en f-strings écrit les accolades **simples** (`{vmid}`) dans fr.ts/en.ts —
  i18next n'interpole que `{{vmid}}` → le `{vmid}` brut s'affiche en UI. Le bug est
  **silencieux** (aucune erreur de build) : vérifier le texte rendu dans le navigateur.
  Injecter l'i18n en strings non-f (ou échapper `{{{{vmid}}}}`) — touché sur
  `overview.netif.fw.tooltip`/`.fw.naming`.
- **`formatBps` arrondissait les o/s à l'entier** : sur un graphe dont toute l'échelle est
  sous 1 o/s (ex. pont `nfs` au repos), tous les libellés d'axe Y affichaient « 0 o/s » —
  les données étaient réelles (~0,9 o/s) mais l'échelle illisible (question user « c'est 0
  ? »). Règle désormais : 2 décimales sous 1, 1 décimale sous 100, sinon entier
  (cohérent avec Ko/s/Mo/s). Note : le `smooth` ECharts + l'axe auto (max = max des
  données) font paraître gros un petit pic — c'est l'axe lisible qui fait foi, pas la
  forme de la courbe.

## 8. À suivre

- **Règles d'alarme** (SMART critique, température > seuil effectif, unité échouée) dans
  `centreonnsca` (skill `centreon-nsca`) — **peut maintenant s'appuyer sur les seuils perso**
  (livrés, §3.1/§6) : le moteur d'alarmes lira `sensorThresholds` + `effectiveSensorThreshold`.
- **Pools ZFS** (nom/état/taille) : les colonnes `pool*` existent dans le type mais ne sont pas
  encore alimentées (la table `zfs` n'expose que l'ARC dans la config Telegraf actuelle).
- **I/O disques > 31 j** : les 4 timeframes lisent `raw` (rétention 31 j). Pour de l'historique
  longue durée, il faudra un consolidateur **de taux** (Δ counter / 15 min écrit dans une table
  consolidée `diskio_rate`) — le min/max actuel n'est pas applicable aux counters.
- ~~**Tendances load/swap 7 j** dans la vue nœud~~ — **livré (2026-11-14)** : widgets `load` +
  `swap` du Monitor nœud `vm-view_v4` (`GET /api/node-system-history`, §3.4).
- **`ping` CAP_NET_RAW** : le plugin `ping` de Telegraf nécessite la capability
  `CAP_NET_RAW` (ou root) ; le service Telegraf tourne non-root → ajouter la capability
  (`setcap`) si on veut la latence vers le cœur de cluster.
