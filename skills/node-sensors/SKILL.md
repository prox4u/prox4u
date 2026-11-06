---
name: node-sensors
description: Plugin « Capteurs nœuds » (node-sensors v1) de prox4u — métriques locales Telegraf (SMART, températures, ZFS ARC, unités systemd) lues dans la base InfluxDB `raw`, servies par GET /api/node-sensors, affichées dans la page /node-sensors (4 tableaux + filtres colonnes multi-choix + filtre des sections). Use when working on the node-sensors plugin, the /api/node-sensors route, Telegraf consolidation, SMART/sensors/ZFS/systemd_units readings, the per-column filters, or wiring custom sensor thresholds.
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
| `packages/shared/src/node-sensors.ts` | Types partagés : `SmartDevice`, `SensorReading`, `ZfsStatus`, `FailedUnit`, `NodeSensorsResponse` |
| `packages/server/src/modules/nodesensors/routes.ts` | `GET /api/node-sensors` — cache 1 min, **try/catch par section** (une table absente ne fait pas perdre les autres), dernier point par clé |
| `packages/server/src/modules/nodesensors/index.ts` | Enregistre le module |
| `packages/web/src/plugins/node-sensors/index.ts` | Manifest `id:'node-sensors'`, route `/node-sensors`, menu order 70 (icône `Thermometer`) |
| `packages/web/src/plugins/node-sensors/pages/node-sensors.tsx` | Page 4 tableaux + `MultiFilter` (filtres colonnes multi-choix, position fixe) + filtre des sections |
| `packages/server/src/core/influx-consolidator.ts` | Consolidation 15 min des 4 tables Telegraf |
| `packages/web/src/core/api/apiClient.ts` | `fetchNodeSensors()` |
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
  failedUnits: FailedUnit[],  // 1 par (node, name), seulement active='failed' / load='error' / sub='dead'
  source: 'influx' | 'empty'  // 'influx' si au moins un nœud, 'empty' sinon
}
```

- `SmartDevice` : `device`, `model`, `serialNo`, `healthOk` (boolean), `tempC`,
  `powerOnHours`, `powerCycleCount`, `reallocatedSectors`, `pendingSectors`,
  `uncorrectableSectors`, `udmaCrcErrors` + champs NVMe `percentageUsed`, `availableSpare`,
  `criticalWarning`.
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
| `systemd_units` | `node`, `name` | `active`, `sub`, `load` (filtré `active='failed' OR load='error' OR sub='dead'`) |

> ⚠️ La table SMART s'appelle **`smart_device`** (pas `smart`) — piège classique, déjà corrigé.

## 5. Page web (`/node-sensors`)

- **4 tableaux** : SMART (nœud, device, modèle, santé, temp, secteurs reallocated, usure NVMe),
  capteurs (nœud, puce, feature, temp, seuil critique, ventilateur), ZFS ARC (nœud, hits, misses,
  size), unités systemd (nœud, unité, active, sub, load).
- **Filtre des sections** : dropdown multi-choix (option « Toutes ») qui montre/masque les 4
  tableaux.
- **Filtres colonnes** : un `MultiFilter` par colonne de statut (nœud, device, santé, …).
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
- **Seuil temp coloration** (page web, v1) : ≥ 80 °C critique, ≥ 60 °C warning, sinon OK.
  **À remplacer** par les **seuils capteurs personnalisés** (plan
  `docs/plan-seuils-capteurs.md`) : seuil perso ≤ firmware, jamais au-dessus.

## 7. Pièges rencontrés (corrigés — ne pas réintroduire)

- **`source: 'empty'` systématique** : les colonnes ZFS s'appellent `arcstats_hits` /
  `arcstats_misses` / `arcstats_size` (pas `arc_hits`). Une requête sur une colonne inexistante
  levait une erreur → **try/catch par section** + noms de colonnes exacts.
- **`health_ok` boolean** : InfluxDB 3 renvoie un **boolean** `true` (pas un nombre) → tester
  `(r.health_ok as unknown) === true` + repli sur `1` / `'true'` / `'True'`.
- **Filtres superposés / illisibles** : le dropdown initial était **transparent** et **coupé par
  l'overflow du tableau** → `position:fixed` (calculé depuis le bounding rect du bouton), **fond
  opaque**, `z-50`. Un `position:absolute` dans un conteneur `overflow:hidden` serait masqué.

## 8. À suivre

- **Seuils capteurs personnalisés** (plan `docs/plan-seuils-capteurs.md`) : abaisser le seuil
  d'alerte par capteur (perso ≤ firmware), persistance `data/sensor-thresholds.json`, onglet
  Administration, le tableau capteurs suit le seuil effectif.
- **Règles d'alarme** (SMART critique, température > seuil, unité échouée) dans `centreonnsca`
  (skill `centreon-nsca`) — dépend des seuils perso ci-dessus.
- **Pools ZFS** (nom/état/taille) : les colonnes `pool*` existent dans le type mais ne sont pas
  encore alimentées (la table `zfs` n'expose que l'ARC dans la config Telegraf actuelle).
