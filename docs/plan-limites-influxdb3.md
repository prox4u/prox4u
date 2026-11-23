# Plan de travail — Gérer les limites InfluxDB 3 Core (cible 500 VMs 24/7)

## Contexte

Prox4u s'appuie sur **InfluxDB 3 Core** (image `influxdb:3.11.5-core`) comme base de
métriques : le poller (tick 5 s) écrit dans `raw` (rétention 31 j) et un consolidateur
agrège vers `consolidated` (rétention ∞, buckets 5/15 min). Les agents Telegraf des nœuds
PVE écrivent ~16 tables dans `raw`.

Le dimensionnement actuel a été validé sur un **endpoint de test** (quelques VMs). Pour un
parc de **500 VMs en production 24/7**, la recherche sur les limites d'InfluxDB 3 Core
montre que les limites « dures » (bases/tables/colonnes) ne nous touchent pas, mais que
**trois manques concrets** apparaissent côté Prox4u, plus des risques opérationnels 24/7.
Ce plan définit les outils pour les combler.

## Recherche — Limites InfluxDB 3 Core

### Limites dures (non configurables, constantes du binaire)
| Limite | Valeur | Prox4u (500 VMs) |
|---|---|---|
| Bases (databases) | **5 max** | `raw` + `consolidated` = 2 → ✅ |
| Tables (measurements) | **2000 max** (toutes bases) | ~25 tables → ✅ |
| Colonnes / table | **500 max** (dont `time`) | ~10 champs → ✅ |
| Architecture | **single-node** (pas de cluster/HA) | ⚠️ point de défaillance unique |

> InfluxData positionne Core pour le « non-production, edge, single-node » ; pour du 24/7
> de prod ils recommandent Enterprise. On reste sur Core (décision actée) → on doit
> **gérer** ses limites, pas les subir.

### La limite de requête : `--query-file-limit` (nombre de fichiers)
- Défaut **432 fichiers Parquet = 72 h** (1 fichier / table / bloc de 10 min, `gen1-duration`).
- Prox4u met déjà `--query-file-limit=10000` → **~69 jours par table**.
- **Aucune compaction en Core** (le compactor est une feature Enterprise) → le nombre de
  fichiers croît **linéairement et sans borne** avec le temps. C'est le cœur du problème
  « nombre de fichiers / historique ».

### Mémoire / écriture (configurables)
`--exec-mem-pool-size` (20 %), `--file-cache-size` (20 %), `--wal-max-buffered-writes`
(100 000, **forcé avec 429 en 3.12+**), `--max-concurrent-queries` (fini + file d'attente
en 3.12+), `--force-snapshot-mem-size` (50 %), `--force-snapshot-max-age` (1 h).

### Historique
Rétention **immuable** à la création (raw 31 j / consolidated ∞) · **pas de DELETE/UPDATE**
(DML) · **pas de downsampling natif** (le consolidateur Prox4u est le mécanisme) · rétention
appliquée à la requête (les lignes passées sont purgées).

## Impact à 500 VMs 24/7 (chiffré depuis le code)

**Volume** : un tick (5 s) sur un cluster 500 VMs (≈350 running, 2 mountpoints/VM) produit
**~1 100–1 450 lignes** ≈ **220 lignes/s ≈ 19 M lignes/jour**. Côté DB c'est négligeable
(InfluxDB 3 avale des millions/s). **Les manques sont côté Prox4u :**

| # | Manque | Preuve dans le code | Conséquence |
|---|---|---|---|
| **1** | File d'écriture bornée à 1000 lignes | `influx.ts` `QUEUE_MAX=1000`, flush 25 ms | Un tick de ~1 100–1 450 lignes **déborde et abandonne les plus anciennes** (`storage_metrics`, `datastore_metrics`, `node_metrics`) → **~10–45 % de perte par tick** |
| **2** | Timeframe `year` cassé par la file limit | `nodesensors/routes.ts` `mergedTempBuckets` = 1 requête 365 j | 365 j = ~35 000–52 000 fichiers > 10 000 → **échec silencieux** (le `catch` renvoie `source:'empty'`). La vue « 1 an » ne marche que tant que les données font < ~69 j |
| **3** | Pas de compaction → croissance des fichiers | `consolidated` à rétention ∞ | Au-delà de ~69 j/table, il faut monter `query-file-limit` (coût RAM/perf) ou chunker |

**Risques 24/7** : single-node (mort du nœud = perte long terme, repli RRD seulement) ·
WAL buffer → 429 en pic d'écriture (3.12+) · OOM sur requêtes longues si pools mémoire mal
dimensionnés.

## Consignes (non négociables)
1. **Zéro nouvelle dépendance** Node (on reste sur `undici` + stdlib ; l'export P5 est CSV,
   pas Parquet, pour éviter un writer binaire).
2. **Le poller ne doit jamais bloquer** sur InfluxDB (file non bloquante, repli RRD intact).
3. **Rétrocompatibilité** : les changements d'API `InfluxClient` restent optionnels
   (défauts = comportement actuel ou strictement meilleur) ; pas de rupture des routes existantes.
4. **Tous les nouveaux réglages** passent par `.env` (gitignoré) avec défauts sûrs, et sont
   documentés dans `deploiement/DEPLOY.md` §InfluxDB.
5. **Pas de modification de Telegraf** ni du consolidateur existant (sauf ajout de
   self-telemetry non intrusif).

## P1 — Backpressure d'écriture (corrige la perte de données, manqué #1)

**Objectif** : plus d'abandon de lignes à 500 VMs, et **visibilité** des abandons s'ils
arrivent quand même.

**Design** (dans `InfluxClient`, `packages/server/src/core/influx.ts`) :
- **File dimensionnée** : `QUEUE_MAX` configurable via `INFLUX_QUEUE_MAX` (défaut **20 000**
  — tient ~15 ticks de 500 VMs). Plus de débordement sur un pic de tick.
- **Batch plus gros** : `FLUSH_MAX_LINES` configurable via `INFLUX_FLUSH_MAX_LINES`
  (défaut **1 000**) → moins de requêtes HTTP par tick (1 au lieu de 6).
- **Compteurs** (monotones, en mémoire) : `enqueued`, `flushed`, `dropped`,
  `failedBatches`, `lastDropAt`, `lastErrorAt`.
- **`getStats()`** : renvoie les compteurs + `queueDepth` courant + `enabled`.
- **Dead-letter borné** : après `INFLUX_FLUSH_MAX_RETRIES` (défaut 3) lots consécutifs en
  échec sur la même fenêtre, les lignes sont comptées `dropped` (et loggées) au lieu de
  ré-enfiler indéfiniment — évite la file qui gonfle sans fin si InfluxDB est tombé.
- **Exposition** : `getStats()` dans `/api/health` (section `influx`) + log d'abandon
  déjà présent (maintenant chiffré).

**Comportement attendu** : à 500 VMs, `dropped` reste à 0 en régime nominal ; en cas de
panne InfluxDB, `dropped` monte et `/api/health` le signale (le repli RRD reste actif pour
l'affichage).

## P2 — Requêtes long terme chunkées (corrige `year`, manqué #2)

**Objectif** : les fenêtres > ~69 j fonctionnent sans monter `query-file-limit` (et sans
OOM), en découplant la requête en tranches < file-limit.

**Design** (dans `InfluxClient`) :
- Nouveau **`querySqlChunked<T>(db, buildSql, from, to, opts?)`** :
  - `buildSql(fromIso, toIso) => string` : le caller fournit le SQL **paramétré par bornes**
    (il contrôle la clause `WHERE time >= … AND time < …`).
  - Découpe `[from, to)` en tranches de `INFLUX_QUERY_CHUNK_DAYS` (défaut **30 j** =
    4 320 fichiers < 10 000, marge incluse).
  - Exécute chaque tranche, **concatène** les résultats (tranches disjointes → pas de
    dédoublonnage ; tri par `time` si la colonne existe).
  - Une tranche en échec « table absente / No field named » est ignorée (pattern existant) ;
    un autre échec est propagé.
- **Taille de tranche dérivée** : `chunkDays` tel que `chunkDays × 144 blocs/jour <
  file_limit × 0.5` (sécurité). `file_limit` lu depuis `INFLUX_QUERY_FILE_LIMIT` (défaut
  10 000, = la valeur posée dans `docker-compose.yml`).

**Application** :
- `nodesensors/routes.ts` `mergedTempBuckets` : la partie **consolidated** (fenêtre `year`
  = 365 j) passe en `querySqlChunked` ; la partie **raw** (31 j = 4 464 fichiers) reste en
  requête simple. → la vue « 1 an » des historiques capteurs/SMART **remarche**.
- Tout autre timeframe long ajouté plus tard réutilise le helper.

## P4 — Auto-monitoring InfluxDB (visibilité des limites)

**Objectif** : voir en continu où on en est par rapport aux limites (fichiers, WAL, RAM,
abandons), et alermer avant la panne.

**Design** :
- **Route `GET /api/influxdb`** (nouveau module `packages/server/src/modules/influxdb/`) :
  - `enabled`, `ping` (bool), `version` (via `/api/v3/server-info`, à confirmer à
    l'implémentation ; sinon `null`),
  - `databases[]` : nom + rétention (via l'API config/database),
  - `tables` : nombre de tables par base (si exposé),
  - `write` : `InfluxClient.getStats()` (P1) — enqueued/flushed/dropped/queueDepth,
  - `query` : latence de la dernière requête + dernier error,
  - `fileEstimate` : **estimation** du nb de fichiers Parquet pour le plus long timeframe
    qu'on requête (`jours × 144`), comparée à `INFLUX_QUERY_FILE_LIMIT` → `headroom` (ok /
    warn / crit).
- **Self-telemetry** : le poller écrit une mesure `influxdb_self` (1×/tick, 1 ligne) dans
  `raw` : `queue_depth`, `dropped_total`, `last_query_ms`, `ping_ok`. → on surveille
  InfluxDB **avec** InfluxDB (graphe réutilisable).
- **Alertes** (pattern `Alert` existant, `messageKey` i18n) :
  - `influxdb-write-drops` (warn) : `dropped` a augmenté depuis le dernier tick.
  - `influxdb-file-headroom` (warn/crit) : `fileEstimate` > 80 % / 100 % de la file limit.
  - `influxdb-down` (crit) : `ping` faux depuis N ticks (le repli RRD est actif).
- **UI** (optionnel, hors périmètre initial) : carte « InfluxDB » dans Administration qui
  lit `/api/influxdb`.

## P5 — Archivage / rétention multi-niveaux (manqué #3, très long terme)

**Objectif** : que l'historique survive au-delà de la fenêtre interrogeable de Core, et que
la croissance de `consolidated` (∞) reste maîtrisée.

**Contrainte clé** : **pas de DELETE en Core** → on ne purge pas ligne à ligne. La levier
réel est l'**export** (archive interrogeable hors InfluxDB) + la **rétention** (raw 31 j
auto-purge ; consolidated ∞ surveillé via P4, et éventuellement recréé à rétention finie
manuellement).

**Design** :
- **`InfluxArchiver`** (nouveau, `packages/server/src/core/influx-archiver.ts`, même
  pattern que le consolidateur — timer + état `data/archive-state.json` tmp+rename +
  reprise) : toutes les `INFLUX_ARCHIVE_INTERVAL` (défaut **6 h**), exporte les lignes de
  `consolidated` dans `[lastArchivedTs, now - INFLUX_ARCHIVE_AGE]` (défaut **90 j** — on
  n'archive que ce qui sort de la fenêtre « chaude ») vers **CSV** dans
  `INFLUX_ARCHIVE_DIR` (défaut `data/influx-archive/`), **1 fichier / table / jour**
  (`<table>-<YYYY-MM-DD>.csv`). État = `lastArchivedTs` (n'avance que si succès → reprise).
- **Format CSV** : en-tête `time,<tags>…,<fields>…`, une ligne par point. Lisible par
  DuckDB/Excel/`csvtool`, interrogeable hors InfluxDB. (Pas de Parquet → zéro dépendance.)
- **Stratégie de rétention documentée** (DEPLOY.md) :
  - `raw` : 31 j (auto-purge native),
  - `consolidated` : ∞ (surveillé via P4 `fileEstimate`) — si la croissance devient un
    problème, **recréer** `consolidated` à rétention finie (ex. 2 ans) + s'appuyer sur
    l'archive CSV pour l'au-delà (opération manuelle, documentée),
  - `data/influx-archive/` : l'au-delà, à la rétention du disque (copie de sauvegarde).
- **Sauvegarde** : `data/influx-archive/` rejoint la liste des artefacts à sauvegarder
  (DEPLOY.md §Sauvegarde).

## Tâches

### P1 — Backpressure d'écriture
- [x] `influx.ts` : `QUEUE_MAX`/`FLUSH_MAX_LINES` configurables (env), défauts 20 000 / 1 000
- [x] `influx.ts` : compteurs `enqueued/flushed/dropped/failedBatches/lastDropAt/lastErrorAt`
- [x] `influx.ts` : dead-letter borné (`INFLUX_FLUSH_MAX_RETRIES`, défaut 3)
- [x] `influx.ts` : `getStats()` (compteurs + `queueDepth` + `enabled`)
- [x] `config.ts` : lire `INFLUX_QUEUE_MAX`, `INFLUX_FLUSH_MAX_LINES`, `INFLUX_FLUSH_MAX_RETRIES`
- [x] `/api/health` : section `influx` (getStats)
- [x] Tests unitaires : débordement file, dead-letter, compteurs
- [x] `DEPLOY.md` : documenter les 3 env

### P2 — Requêtes chunkées
- [x] `influx.ts` : `querySqlChunked(db, buildSql, from, to, opts?)`
- [x] `config.ts` : `INFLUX_QUERY_CHUNK_DAYS` (défaut 30), `INFLUX_QUERY_FILE_LIMIT` (défaut 10 000)
- [x] `nodesensors/routes.ts` : `mergedTempBuckets` → consolidated en chunké (raw inchangé)
- [x] Tests unitaires : découpage, concat, tranche « table absente » ignorée
- [ ] Test manuel : vue « 1 an » capteur/SMART avec > 69 j de données (besoin de données réelles) → **issue #4**

### P4 — Auto-monitoring
- [x] Nouveau module `packages/server/src/modules/influxdb/` (route `GET /api/influxdb`)
- [x] `influx.ts` : `getServerInfo()` (version via `/api/v3/server-info`, défensif)
- [x] `influx.ts` : stats requête (latence dernière + dernier error)
- [x] `fileEstimate` : estimation fichiers vs file limit + `headroom`
- [x] Poller : self-telemetry `influxdb_self` (1 ligne/tick)
- [x] Alertes `influxdb-write-drops` / `influxdb-file-headroom` / `influxdb-down` (+ i18n fr/en)
- [x] Enregistrement du module dans le loader
- [x] Tests : route (enabled/désactivé, headroom) — `influxdb/routes.test.ts`
- [ ] Tests : alertes `influxAlerts()` (optionnel — fonction pure, non couverte) → **issue #4**

### P5 — Archivage
- [x] `influx-archiver.ts` : timer + état `data/archive-state.json` + reprise
- [x] Export CSV `consolidated` `[lastArchivedTs, now - age]` → `<table>-<date>.csv`
- [x] `config.ts` : `INFLUX_ARCHIVE_INTERVAL`, `INFLUX_ARCHIVE_AGE`, `INFLUX_ARCHIVE_DIR`
- [x] Démarrage/arrêt dans `index.ts` (comme le consolidateur)
- [x] `DEPLOY.md` : stratégie de rétention + `data/influx-archive/` dans la sauvegarde
- [x] Tests : export CSV 1/table/jour, table absente ignorée, erreur → état figé, reprise — `influx-archiver.test.ts`

## Fichiers à créer/modifier
| Fichier | Action |
|---------|--------|
| `packages/server/src/core/influx.ts` | MODIF — P1 (file/compteurs/dead-letter/getStats) + P2 (querySqlChunked) + P4 (getServerInfo, stats requête) |
| `packages/server/src/core/config.ts` | MODIF — nouvelles env InfluxDB |
| `packages/server/src/core/influx-archiver.ts` | NOUVEAU — P5 |
| `packages/server/src/core/poller.ts` | MODIF — P4 self-telemetry `influxdb_self` |
| `packages/server/src/core/influx-consolidator.ts` | (inchangé — référence de pattern pour P5) |
| `packages/server/src/modules/influxdb/routes.ts` | NOUVEAU — P4 `GET /api/influxdb` |
| `packages/server/src/modules/dashboard/routes.ts` | MODIF — `/api/health` section `influx` |
| `packages/server/src/modules/nodesensors/routes.ts` | MODIF — P2 `mergedTempBuckets` chunké |
| `packages/server/src/index.ts` | MODIF — enregistrement module influxdb + démarrage archiver |
| `packages/shared/src/i18n/fr.ts` / `en.ts` | MODIF — libellés alertes InfluxDB |
| `packages/server/src/core/influx.test.ts` | MODIF — tests P1/P2 |
| `deploiement/DEPLOY.md` / `DEPLOY.en.md` | MODIF — env InfluxDB + stratégie de rétention + sauvegarde archive |
| `.env.example` | MODIF — options INFLUX_* (commentées, défauts sûrs) |
| `docker-compose.yml` | (inchangé — `--query-file-limit=10000` déjà posé) |

## Hors périmètre (pour plus tard) — tracé en issues Gitea
- **P3 — Calculateur de dimensionnement** (script VMs/nœuds/tick → config recommandée) :
  utile avant déploiement prod, mais non retenu dans cette itération. → **issue #2**
- **UI « carte InfluxDB »** dans Administration (P4 est d'abord route + alertes).
  → **FAIT** (module `/influxdb` — itération `plan-module-influxdb.md`, 2026-11-23).
- **Migration vers InfluxDB 3 Enterprise** (compaction, HA, rétention mutable) : décision
  stratégique si le single-node / la croissance de `consolidated` deviennent critiques. → **issue #6**
- **Export Parquet** (au lieu de CSV) : nécessite un writer binaire (dépendance) — CSV
  choisi pour rester zéro-dépendance. → **issue #3**
- **Sharding multi-InfluxDB** par endpoint (si un seul nœud ne suffit plus). → **issue #5**
