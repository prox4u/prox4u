# Plan de travail — Module « InfluxDB 3 Core » (vision + action)

## Contexte

La base **P4** (plan-limites-influxdb3.md) est en place : `GET /api/influxdb`
(état/compteurs/headroom), self-telemetry `influxdb_self` (1 ligne/tick dans `raw`),
3 alertes (`influxdb-down` / `influxdb-write-drops` / `influxdb-file-limit`), archiver CSV.
Mais il n'y a ni **vision graphique** (pas de graphiques de la santé InfluxDB) ni
**action** (les opérations manuelles de DEPLOY.md — recréer `consolidated` à rétention
finie, forcer un archivage — restent des commandes en ligne).

Ce plan transforme la base P4 en **module complet** :
- un **widget « InfluxDB » sur la vue d'ensemble** (badge live + mini-graphe 24 h) ;
- une **page `/influxdb`** (KPIs, graphiques, bases, archivage, actions) ;
- des **actions (scripts)** réservées aux membres des groupes **Administrateurs** et
  **Exploitations** (configurable via env).

## Consignes (non négociables)
1. **Zéro nouvelle dépendance** (ECharts déjà utilisé, API InfluxDB 3 Core existantes).
2. **Le tick ne doit jamais bloquer** sur InfluxDB (ping en cache 60 s, fire-and-forget).
3. **Module visible par TOUS** les utilisateurs ; **seules les actions** sont restreintes
   (groupes configurés OU rôle admin).
4. **Chaque action est loggée** dans l'audit admin (`influxdb.action`).
5. Les noms de `db`/`table` sont validés (`/^[a-zA-Z0-9_-]+$/`) avant toute interpolation.

## 1. Vision serveur

### 1.1 `multi.influx` dans le snapshot WS (live, zéro API pour le front)
```ts
// shared/types.ts
export interface InfluxStatus {
  enabled: boolean;
  ping: boolean | null;      // null = 1ʳᵉ mesure en cours
  queueDepth: number;
  enqueued: number;
  flushed: number;
  dropped: number;
  failedBatches: number;
  headroom: 'ok' | 'warn' | 'crit';
  chunkFiles: number;
  fileLimit: number;
}
// MultiDashboardSnapshot += influx: InfluxStatus | null
```
Le poller la calcule dans `tick()` : `getStats()` + `fileEstimate()` (en mémoire, gratuit)
+ ping **mis en cache 60 s** (fire-and-forget — le tick n'attend jamais ; entre deux
pings, la dernière valeur connue est servie).

### 1.2 `GET /api/influxdb/history?range=24h|7d|30d` (série pour les graphiques)
SQL sur `influxdb_self` (base `raw`) :
```sql
SELECT date_bin(INTERVAL '<bucket>', time) AS t,
       max(queue_depth) AS queue_depth,
       max(dropped_total) AS dropped_total,
       avg(last_query_ms) AS query_ms,
       max(enqueued_total) AS enqueued_total
FROM influxdb_self WHERE time >= now() - INTERVAL '<range>' GROUP BY t ORDER BY t
```
Buckets adaptatifs : 24 h → 5 min · 7 j → 15 min · 30 j → 1 h.
Cache 5 min (pattern des caches dashboard) · table absente → `{ points: [], source: 'empty' }`
· InfluxDB désactivé → `source: 'disabled'`.

## 2. Actions (toutes sous `/api/influxdb/actions/*`)

| Endpoint | Corps | Effet | Risque |
|---|---|---|---|
| `POST .../flush` | — | `influx.flush()` immédiat | aucun |
| `POST .../archive/run` | — | `archiver.runNow()` | aucun |
| `POST .../archive/reset` | — | `archiver.resetState()` (re-archivage depuis 1 an) | faible |
| `POST .../export` | `{table, from, to}` | export CSV ad-hoc dans `archiveDir` | aucun |
| `POST .../database/recreate` | `{db, retention?}` | drop + create (l'op manuelle de DEPLOY.md) | **destructif** |
| `POST .../database/backup` | `{db}` | ZIP persistant (1 CSV/table + manifeste) dans `INFLUX_BACKUP_DIR` | aucun (lecture) |
| `POST .../database/restore` | `{file}` | unzip + `createTable` + réinjection line-protocol (base d'origine du manifeste) | attention (append si tables existantes) |
| `POST .../database/drop` | `{db, backup?}` | `DELETE /api/v3/configure/database` ; `backup: true` → sauvegarde préalable obligatoire | **destructif** |
| `POST .../table/drop` | `{db, table}` | `DELETE /api/v3/configure/table` | **destructif** |

Sécurité : validation des noms, 404 si base/table inexistante, audit admin par action.
`retention` absent sur recreate = rétention infinie (comportement actuel `consolidated`).

Nouveaux besoins :
- `influx.ts` : `dropDatabase(db)`, `dropTable(db, table)`.
- `influx-archiver.ts` : `runNow()` + `resetState()` publics.
- **L'archiver rejoint `AppContext`** (créé dans `index.ts`, accessible aux routes).

> **Suivi (Gitea #14, livré)** : sauvegarde/restauration de bases — `database/backup`
> (ZIP persistant + manifeste), `database/restore` (réinjection line-protocol), `GET
> /api/influxdb/backups`, et `database/drop` avec `backup: true` (sauvegarde préalable).
> Hors du périmètre de ce plan d'origine. Détail : skill `api` + notice `docs/influxdb`.

## 3. Permission par groupe

- **Env `INFLUX_ACTION_GROUPS`** (défaut `Administrateurs,Exploitations`, noms séparés par `,`).
- **`guard.ts`** : `req.authUser` gagne `groupIds` ; `/api/influxdb/actions/*` exige
  **rôle admin OU appartenance à un des groupes configurés** → sinon 403 `influx-actions-group`.
- **`GET /api/influxdb`** renvoie `canAct: boolean` (même logique, calculée serveur) →
  le front masque/affiche le panneau Actions.

## 4. Widget vue d'ensemble (hypervision_v4)

Nouvelle entrée du catalogue de la grille (pattern `pra-global`) :
- **`extra`** (en-tête) : badge 🟢 up / 🔴 down / ⚪ inconnu + badge headroom.
- **`render`** : KPIs compacts (file, abandonnées, latence) + **mini-graphe 24 h**
  (queue_depth + dropped, ECharts, fetch `/api/influxdb/history?range=24h` au mount +
  refresh 5 min, pattern `sys-nodes` avec état loading).
- Clic → navigation `/influxdb`. Données live : `multi.influx` (WS).

## 5. Module `/influxdb` (nouvelle famille de plugin web)

```
packages/web/src/plugins/influxdb/
  index.ts               — Plugin { routes: /influxdb, nav: « InfluxDB » (Database, order 80) }
  pages/influxdb.tsx
  components/
    kpi-row.tsx          — état, version, file, abandonnées, latence, headroom
    history-charts.tsx   — 4 graphiques + sélecteur 24h/7j/30j
    databases-card.tsx   — bases (nom, rétention)
    archive-card.tsx     — état archivage (lastArchivedTs, prochain cycle, fichiers/taille)
    actions-panel.tsx    — boutons + confirmations (masqué si !canAct)
```
- **Graphiques** (2×2) : file d'écriture · lignes abandonnées · latence requêtes ·
  débit d'écriture (delta `enqueued_total`).
- **Actions** : non-destructifs en 1 clic (Flush, Archive now, Export table/from/to) ;
  destructifs avec **dialog de confirmation** ; toast de résultat ; refresh KPIs après action.
- Enregistrement : `plugins.ts` + `FEATURES.USE_PLUGIN_INFLUXDB` + `ModuleDef influxdb`
  dans `DEFAULT_MODULES` (shared/auth.ts) + i18n fr/en.

## Tâches

### 1. Vision serveur
- [x] `shared/types.ts` : `InfluxStatus` + `MultiDashboardSnapshot.influx`
- [x] `poller.ts` : `multi.influx` (stats + headroom + ping cache 60 s)
- [x] `influxdb/routes.ts` : `GET /api/influxdb/history?range=` (cache 5 min, buckets adaptatifs)

### 2. Permission
- [x] `config.ts` : `INFLUX_ACTION_GROUPS` (défaut `Administrateurs,Exploitations`)
- [x] `guard.ts` : `authUser.groupIds` + règle `/api/influxdb/actions/*` (403 sinon)
- [x] `influxdb/routes.ts` : `canAct` dans `GET /api/influxdb`

### 3. Actions
- [x] `influx.ts` : `dropDatabase(db)`, `dropTable(db, table)`
- [x] `influx-archiver.ts` : `runNow()`, `resetState()` (+ `exportTable`, `getState`)
- [x] `index.ts` : archiver dans `AppContext`
- [x] `influxdb/routes.ts` : 7 `POST /api/influxdb/actions/*` + audit admin
- [x] Tests : routes actions (mock fetch + archiver), validation noms, 404

### 4. Widget overview
- [x] `hypervision_v4` : widget « InfluxDB » (badge + KPIs + mini-graphe 24 h)
- [x] i18n fr/en du widget

### 5. Module web
- [x] `plugins/influxdb/` : page + 5 composants (KPIs, graphiques, bases, archive, actions)
- [x] `plugins.ts` + `FEATURES.USE_PLUGIN_INFLUXDB`
- [x] `shared/auth.ts` : `ModuleDef influxdb` dans `DEFAULT_MODULES`
- [x] i18n fr/en du module (nav, KPIs, graphiques, actions, confirmations)

### 6. Tests
- [x] `guard.test.ts` : actions — admin OK, membre groupe OK, hors groupe 403
- [x] `influxdb/routes.test.ts` : history (format, table absente, désactivé) + 7 actions
- [x] `poller.test.ts` : `multi.influx` présent dans le snapshot

## Fichiers à créer/modifier
| Fichier | Action |
|---------|--------|
| `packages/shared/src/types.ts` | MODIF — `InfluxStatus`, `MultiDashboardSnapshot.influx` |
| `packages/server/src/core/poller.ts` | MODIF — `multi.influx` + ping 60 s |
| `packages/server/src/core/influx.ts` | MODIF — `dropDatabase`, `dropTable` |
| `packages/server/src/core/influx-archiver.ts` | MODIF — `runNow`, `resetState` |
| `packages/server/src/core/config.ts` | MODIF — `INFLUX_ACTION_GROUPS` |
| `packages/server/src/modules/influxdb/routes.ts` | MODIF — `canAct`, `GET /history`, 7 `POST /actions/*` |
| `packages/server/src/modules/auth/guard.ts` | MODIF — `groupIds` + règle groupes |
| `packages/server/src/index.ts` | MODIF — archiver dans `AppContext` |
| `packages/web/src/plugins/influxdb/` | NOUVEAU — page + 5 composants |
| `packages/web/src/plugins/hypervision_v4/` | MODIF — widget overview |
| `packages/web/src/core/plugin/plugins.ts` (+ FEATURES) | MODIF — enregistrement |
| `packages/shared/src/auth.ts` | MODIF — `ModuleDef influxdb` |
| `packages/shared/src/i18n/fr.ts` / `en.ts` | MODIF — libellés |
| `packages/server/src/modules/auth/guard.test.ts` | MODIF — tests groupes |
| `packages/server/src/modules/influxdb/routes.test.ts` | MODIF — history + actions |
| `packages/server/src/core/poller.test.ts` | MODIF — `multi.influx` |

## Hors périmètre — tracé en issues GitHub (prox4u/prox4u)
- Gestion UI des groupes (déjà dans Administration).
- Features Enterprise (compaction, HA) → **GitHub #14** · export Parquet → **GitHub #15** ·
  sharding multi-InfluxDB → **GitHub #18**.
- Actions sur Telegraf (agents nœuds) — autre périmètre.
- Affichage Version « — » + Rétention « infinie » (limites API InfluxDB 3 Core) → **GitHub #16**.
