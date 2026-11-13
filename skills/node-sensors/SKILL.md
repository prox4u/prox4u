---
name: node-sensors
description: Plugin « Capteurs nœuds » (node-sensors v1) de prox4u — métriques locales Telegraf (SMART, températures, ZFS ARC, unités systemd) lues dans la base InfluxDB `raw`, servies par GET /api/node-sensors, affichées dans la page /node-sensors (4 tableaux + filtres colonnes multi-choix + filtre des sections), ET seuils capteurs personnalisés (perso ≤ firmware) persistés dans data/sensor-thresholds.json, gérés dans l'onglet Administration « Seuils capteurs » (GET/PUT/DELETE /api/admin/sensor-thresholds), ET historique des valeurs d'un capteur OU d'un disque SMART (GET /api/node-sensors-history, GET /api/smart-device-history, fenêtre modal « Historique des valeurs » avec graphe ECharts depuis l'icône des tables capteurs et SMART), ET métriques système hôte (GET /api/node-system : load/swap/iowait/usage par cœur ; GET /api/node-diskio : I/O par device physique — consommées par la Vue d'ensemble), ET mapping device-mapper → LV PVE (table dm_names écrite par le plugin exec Telegraf, consommée par GET /api/vm-diskio de la vue VM). Use when working on the node-sensors plugin, the /api/node-sensors, /api/node-sensors-history, /api/smart-device-history, /api/node-system or /api/node-diskio routes, Telegraf consolidation, SMART/sensors/ZFS/systemd_units readings, the per-column filters, the value-history dialog (sensors & SMART disks), custom sensor thresholds, the « Seuils capteurs » admin tab, the overview system cards (load/swap/disk I/O/per-core CPU), or the dm_names Telegraf mapping.
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
| `packages/web/src/plugins/node-sensors/components/history-dialog.tsx` | Fenêtre « Historique des valeurs » **générique** — cible `HistoryTarget = { kind:'sensor'; sensor } \| { kind:'smart'; device }` : fetch `fetchSensorHistory` / `fetchSmartHistory`, toggle 31 j / 1 an, graphe ECharts (couleur `ct.temp`, `connectNulls: false` → **les trous restent visibles**), lignes de référence `markLine` (capteur : seuil effectif rouge + firmware gris si perso ; SMART : ligne fixe **80 °C** critique), dernière mesure, état vide / erreur / chargement. **Piège** : `chartTheme()` renvoie un objet NOUVEAU à chaque appel — les deps de l'effet de fetch doivent être `theme` (string stable), jamais l'objet `ct` (boucle infinie de re-fetch) |
| `packages/web/src/components/ui/dialog.tsx` | Modal léger zéro-dépendance (overlay sombre + panneau centré, fermeture X / overlay / Échap, scroll body gelé) — réutilisable |
| `packages/shared/src/node-sensors.ts` | Types partagés + fonctions pures testées : `sensorKey`, `effectiveSensorThreshold`, `tempTone`, `smartHealthTone` (tri-state SMART), `smartTempDisplay` (0 °C = pas de lecture) |
| `packages/server/src/modules/nodesensors/thresholds.ts` | `SensorThresholdStore` — data/sensor-thresholds.json (écriture atomique tmp+rename, chmod 600, fail-fast si corrompu) |
| `packages/web/src/components/admin/sensor-thresholds.tsx` | Onglet Administration « Seuils capteurs » (tableau nœud/puce/capteur/temp/seuil firmware RO/seuil perso input clampé + reset par ligne + tout) |
| `packages/web/src/plugins/node-sensors/lib/sensor-thresholds-api.ts` | Client API /api/admin/sensor-thresholds (list/save/resetAll/resetOne) |
| `packages/shared/src/system-metrics.ts` | Types + fonctions pures testées des métriques système hôte : `NodeSystemRow/Response`, `NodeDiskioRow/Response`, `VmDiskioPoint/Series/Response`, `parsePveMapperName` (LV `vg--vm--101--disk--0` → vmid/ctid, depuis le **suffixe** LV car le VG peut contenir `--`), `mapperLabel`, `isPhysicalDevice` (disques entiers seuls) |
| `packages/server/src/modules/nodesensors/system-routes.ts` | `GET /api/node-system` (dernier point par nœud : `system`+`mem`+`cpu`, cache 60 s) · `GET /api/node-diskio?node=&timeframe=` (I/O par device physique, SQL `diskioRateSql` = bucket d'abord puis LAG des counters, cache 5 min) — consommés par la Vue d'ensemble (3 cartes) |
| `packages/server/src/modules/vmview/vm-diskio.ts` | `GET /api/vm-diskio?endpoint=&vmid=&timeframe=` — I/O PAR DISQUE d'une VM : mapping `dm_names` (dernier point par (node, dm), fenêtre 1 h) + `diskioRateSql` sur les dm de la VM ; états `influx` / `noMapping` (table absente) / `insufficientData` (pas de LV dm pour la VM) |
| `packages/web/src/plugins/hypervision/components/system-nodes-card.tsx` | Carte Vue d'ensemble « Système — par nœud » : load 1/5/15 teinté vs nb de cœurs (≥1 warn, ≥2 crit), iowait (≥10 warn, ≥25 crit), swap (≥50 warn, ≥80 crit), uptime |
| `packages/web/src/plugins/hypervision/components/node-diskio-card.tsx` | Carte Vue d'ensemble « I/O disques (nœud) » : sélecteur nœud + timeframe 1h/24h/7j/30j, 2 graphes (débits lecture=plein/écriture=pointillé par device ; busy % + IOPS double axe) — base de temps commune, trous = null (pas d'interpolation) |
| `packages/web/src/plugins/hypervision/components/cpu-cores-card.tsx` | Carte Vue d'ensemble « CPU par cœur » : barres horizontales usage courant (teinte <70 ok / <90 warn / ≥90 crit), tooltip user/system/iowait, sélecteur nœud |
| `packages/web/src/plugins/vm-view_v2/components/vm-monitor.tsx` | Onglet Monitor VM : section « Disques I/O — par device (hôte) » (`PerDeviceDiskSection`) après le graphe disque agrégat — 1 carte par disque (débits + saturation + export CSV), états noMapping/insufficientData lisibles |
| `packages/server/src/core/influx-consolidator.ts` | Consolidation 15 min des 4 tables Telegraf (**pas** diskio/mem/cpu/system — counters, cf. §6) |
| `packages/web/src/core/api/apiClient.ts` | `fetchNodeSensors()` · `fetchSensorHistory(node, chip, feature, range)` · `fetchSmartHistory(node, device, range)` · `fetchNodeSystem()` · `fetchNodeDiskio(node, timeframe)` · `fetchVmDiskio(endpoint, vmid, timeframe)` |
| `deploiement/60-telegraf-nodes.sh` | Déploiement de l'agent Telegraf sur un nœud (bare-metal, idempotent, `--dry-run`). Inclut le plugin `exec` (script `/usr/local/lib/prox4u-telegraf-dm-names.sh` → table `dm_names`, §4) |

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

### 3.3 Métriques système hôte (Vue d'ensemble) + I/O par device

Trois routes de plus, **même source** (tables Telegraf `raw`), dans le même module
(`system-routes.ts`, enregistrement dans `index.ts`) :

- `GET /api/node-system` → `NodeSystemResponse { nodes: NodeSystemRow[], source: 'influx'|'empty' }` —
  **dernier point par nœud** (fenêtre 10 min, `ORDER BY time DESC`, premier par clé) sur 3 tables
  jointes en TS : `system` (load1/5/15, n_cpus, uptime), `mem` (swap_total/swap_free → used =
  total−free), `cpu` (cpu-total → iowait/user/system ; `cpu0..N` → usage par cœur =
  100 − idle − iowait). Cache 60 s (données 10 s). L'API PVE donne loadavg/swap **en instantané**
  (vue nœud) mais **ni historique, ni iowait, ni par cœur** — d'où la source agent.
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

**SQL d'I/O — `diskioRateSql(where, bucket, bucketSec, window)`** (exportée, testée) :
`read_bytes`/`write_bytes`/`reads`/`writes`/`io_time` sont des **counters** (reset au reboot) ;
`io_await` est une jauge (ms). Pattern : **bucket d'abord** (`date_bin` + `MAX` colonaires sur
les counters — pas de window function sur les ~60k points/device/7 j), **puis `LAG` de bucket en
bucket** (`WINDOW w AS (PARTITION BY name ORDER BY t)`) ; débits = Δ(counter) / durée de bucket ;
**delta négatif (reboot) → NULL via `normRate`, jamais un pic faux** ; `busy_pct` =
Δ(`io_time`, ms d'occupation réelle) / durée — 0–100, **convention iostat** (PAS `io_util`
Telegraf, basé sur `weighted_io_time`, qui **dépassait 100 %** observé 233 % avec du parallélisme).

## 4. Mesures InfluxDB (tables Telegraf)

| Table | Clé d'unicité | Colonnes clés |
|---|---|---|
| `smart_device` | `node`, `device` | `model`, `serial_no`, `health_ok`, `temp_c`, `power_on_hours`, `power_cycle_count`, `reallocated_sectors_count`, `pending_sector_count`, `uncorrectable_sector_count`, `udma_crc_errors`, `percentage_used`, `available_spare`, `critical_warning` |
| `sensors` | `node`, `chip`, `feature` | `temp_input`, `temp_crit`, `fan_input`, `in_input` |
| `zfs` | `node` | `arcstats_hits`, `arcstats_misses`, `arcstats_size` |
| `systemd_units` | `node`, `name` | `active`, `sub`, `load` (filtré `active='failed' OR load='error'` — **vraies alertes seulement**) |
| `system` | `node` | `load1`, `load5`, `load15`, `n_cpus`, `uptime` |
| `mem` | `node` | `swap_total`, `swap_free` (PAS de `swap_used` — calculé total−free), `used`, `available_percent` |
| `cpu` | `node`, `cpu` | `cpu` = `cpu-total` ou `cpu0..N` ; `usage_user/nice/system/idle/iowait/irq/softirq/steal` (somme = 100) |
| `diskio` | `node`, `name` | counters : `read_bytes`, `write_bytes`, `reads`, `writes`, `read_time`, `write_time`, `io_time`, `weighted_io_time` · jauges : `io_await` (ms), `io_svctm`, `io_util` (fraction 0–1, peut **>1**), `iops_in_progress` · `wwid` (NVMe) |
| `dm_names` | `node`, `dm` | `mapper_name` (LV PVE, ex. `rapide--vm--100--disk--0`), `present` (champ factice — une ligne line-protocol sans champ est invalide). Écrite par le **plugin `exec`** Telegraf (script `/usr/local/lib/prox4u-telegraf-dm-names.sh` → `/sys/block/dm-*/dm/name`) ; quasi statique, relue toutes les 10 s ; **pas consolidée** (dimension, pas une mesure) |

> ⚠️ La table SMART s'appelle **`smart_device`** (pas `smart`) — piège classique, déjà corrigé.

> ⚠️ **`systemd_units` — sémantique des états** (plugin Telegraf sans filtre = D-Bus `ListUnits()`,
> toutes les unités connues du manager, ~170/nœud) : `inactive (dead)` est l'état de repos **normal**
> des one-shots (terminés au boot/timer), des unités à la demande (`rescue`, `hibernate`…) et des
> non-installées (`load='not-found'` — vestiges de provisioning : références à des unités dont le
> fichier a disparu, stables au travers des redémarrages, souvent identiques sur tous les nœuds d'une
> même image). Ne jamais alerter sur `dead` — seuls `active='failed'` et `load='error'` sont des
> alertes (exemple réel env. de test : `openipmi.service` failed sur nœud sans BMC IPMI).

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
  stockage), graphe ECharts (couleur thème `ct.temp`, aire dégradée, `connectNulls: false` →
  **les trous = nœud sans mesure (éteint) restent visibles, jamais comblés**), `markLine` —
  capteur : seuil effectif (rouge pointillés) + seuil firmware (gris) si perso ; SMART : ligne
  critique fixe **80 °C** (pas de `temp_crit` pour les disques), note explicative des trous.
  i18n `nodeSensors.history.*` / `nodeSensors.range.*`.
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
  - Vue d'ensemble : **une seule fetch** `/api/node-system` (tick 60 s) partagée par les 3
    cartes (hook `useNodeSystem` dans `overview.tsx`) ; rangée de grid `y=5 h=5`, `LAYOUT_VERSION`
    bumpé (2→3) → layouts persistés antérieurs jetés au rechargement.

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
- **`*/` dans un commentaire bloc TypeScript** : un `dm-*/` dans un commentaire `/* … */`
  (ex. « disques dm-*/loop */md… ») **fermait le commentaire prématurément** → esbuild
  « Unexpected token » au build, sans message pointant la cause. Dans un commentaire bloc,
  éviter `*/` même en apparence (écrire `dm-x/` ou passer en commentaire ligne).
- **Line protocol Telegraf sans champ** : `dm_names dm="dm-10"` seul est **invalide** (une
  ligne line-protocol doit porter au moins un champ) → le script dm-names écrit toujours un
  champ factice `present=1i`. Oublier ce champ = lignes rejetées silencieusement, table vide.

## 8. À suivre

- **Règles d'alarme** (SMART critique, température > seuil effectif, unité échouée) dans
  `centreonnsca` (skill `centreon-nsca`) — **peut maintenant s'appuyer sur les seuils perso**
  (livrés, §3.1/§6) : le moteur d'alarmes lira `sensorThresholds` + `effectiveSensorThreshold`.
- **Pools ZFS** (nom/état/taille) : les colonnes `pool*` existent dans le type mais ne sont pas
  encore alimentées (la table `zfs` n'expose que l'ARC dans la config Telegraf actuelle).
- **I/O disques > 31 j** : les 4 timeframes lisent `raw` (rétention 31 j). Pour de l'historique
  longue durée, il faudra un consolidateur **de taux** (Δ counter / 15 min écrit dans une table
  consolidée `diskio_rate`) — le min/max actuel n'est pas applicable aux counters.
- **Tendances load/swap 7 j** dans la vue nœud (capteurs nœuds ou vue nœud PVE) : les tables
  `system`/`mem` sont déjà dans `raw`, un graphe `date_bin(1h)` suffirait.
- **Plugin `net` par NIC** (débits réseau par interface hôte) — même pattern que `diskio`
  (counters `rx_bytes`/`tx_bytes`, rate par bucket) ; utile pour distinguer trafic VM vs hôte.
- **`ping` CAP_NET_RAW** : le plugin `ping` de Telegraf nécessite la capability
  `CAP_NET_RAW` (ou root) ; le service Telegraf tourne non-root → ajouter la capability
  (`setcap`) si on veut la latence vers le cœur de cluster.
