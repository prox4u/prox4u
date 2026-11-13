---
name: node-sensors
description: Plugin « Capteurs nœuds » (node-sensors v1) de prox4u — métriques locales Telegraf (SMART, températures, ZFS ARC, unités systemd) lues dans la base InfluxDB `raw`, servies par GET /api/node-sensors, affichées dans la page /node-sensors (4 tableaux + filtres colonnes multi-choix + filtre des sections), ET seuils capteurs personnalisés (perso ≤ firmware) persistés dans data/sensor-thresholds.json, gérés dans l'onglet Administration « Seuils capteurs » (GET/PUT/DELETE /api/admin/sensor-thresholds), ET historique des valeurs d'un capteur OU d'un disque SMART (GET /api/node-sensors-history, GET /api/smart-device-history, fenêtre modal « Historique des valeurs » avec graphe ECharts depuis l'icône des tables capteurs et SMART). Use when working on the node-sensors plugin, the /api/node-sensors, /api/node-sensors-history or /api/smart-device-history routes, Telegraf consolidation, SMART/sensors/ZFS/systemd_units readings, the per-column filters, the value-history dialog (sensors & SMART disks), custom sensor thresholds, or the « Seuils capteurs » admin tab.
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
| `packages/server/src/core/influx-consolidator.ts` | Consolidation 15 min des 4 tables Telegraf |
| `packages/web/src/core/api/apiClient.ts` | `fetchNodeSensors()` · `fetchSensorHistory(node, chip, feature, range)` · `fetchSmartHistory(node, device, range)` |
| `deploiement/60-telegraf-nodes.sh` | Déploiement de l'agent Telegraf sur un nœud (bare-metal, idempotent, `--dry-run`) |

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

## 4. Mesures InfluxDB (tables Telegraf)

| Table | Clé d'unicité | Colonnes clés |
|---|---|---|
| `smart_device` | `node`, `device` | `model`, `serial_no`, `health_ok`, `temp_c`, `power_on_hours`, `power_cycle_count`, `reallocated_sectors_count`, `pending_sector_count`, `uncorrectable_sector_count`, `udma_crc_errors`, `percentage_used`, `available_spare`, `critical_warning` |
| `sensors` | `node`, `chip`, `feature` | `temp_input`, `temp_crit`, `fan_input`, `in_input` |
| `zfs` | `node` | `arcstats_hits`, `arcstats_misses`, `arcstats_size` |
| `systemd_units` | `node`, `name` | `active`, `sub`, `load` (filtré `active='failed' OR load='error'` — **vraies alertes seulement**) |

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

## 8. À suivre

- **Règles d'alarme** (SMART critique, température > seuil effectif, unité échouée) dans
  `centreonnsca` (skill `centreon-nsca`) — **peut maintenant s'appuyer sur les seuils perso**
  (livrés, §3.1/§6) : le moteur d'alarmes lira `sensorThresholds` + `effectiveSensorThreshold`.
- **Pools ZFS** (nom/état/taille) : les colonnes `pool*` existent dans le type mais ne sont pas
  encore alimentées (la table `zfs` n'expose que l'ARC dans la config Telegraf actuelle).
