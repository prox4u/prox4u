---
name: api
description: Contrat de l'API REST de Prox4u — /api/health, /api/dashboard, /api/endpoints, /api/capacity, /api/trends, /api/metrics, /api/overcommit-risk, /api/network-topology, /api/storage-inventory, /api/vm-config, /api/node-sensors + WebSocket /ws ; formes de réponse, caches 5 min (1 min pour node-sensors), repli InfluxDB→RRD. Use when working on packages/server/src/modules/, adding an endpoint, or consuming the API from a plugin.
---

# Prox4u — Contrat API REST

Serveur Fastify (`packages/server`), HTTPS :8080 en prod. Modules : `modules/dashboard/routes.ts`, `modules/supervision/routes.ts`, enregistrés dans `modules/index.ts`.

## 1. Règles générales
- **Cache 5 min** (mémoire, par clé) sur les endpoints lourds ; pas de cache sur `/api/health`, `/api/dashboard`, `/api/endpoints` (snapshot live).
- `?endpoint=<id>` : défaut = endpoint par défaut ; inconnu → **404** `{error}`. `/api/metrics` accepte aussi `endpoint=all` (agrégat de tous les endpoints).
- Avant le 1er tick du poller : **503** `{error:'snapshot not ready'}` sur les endpoints snapshot.
- Les endpoints historiques renvoient `source: 'influx' | 'rrd'` — InfluxDB en priorité, **repli RRD Proxmox automatique** (warn loggé, jamais de crash).
- Erreurs : `{ error: string }` avec le code HTTP adapté.

## 2. Endpoints
| Endpoint | Cache | Réponse |
|---|---|---|
| `GET /api/health` | — | `{ status:'ok', mock:boolean, uptimeSec:number }` |
| `GET /api/dashboard` | — | `MultiDashboardSnapshot` (même payload que le push WS) : par endpoint `{ id, name, ok, error, snapshot: DashboardSnapshot }` ; 503 si pas prêt |
| `GET /api/endpoints` | — | Liste compacte sidebar : `{ id, name, ok, error, nodesOnline, nodesTotal, vmsRunning, vmsTotal, healthScore, healthLabel }[]` |
| `GET /api/capacity?endpoint=` | 5 min/ep | `{ cpu, ram, disk: CapacityForecast, source }` — moyennes journalières 30 j + régression (`buildForecast` : slopePerDay, daysTo80/90, projection 30 j). Disque = stockage VM (`storage_metrics`, pondéré Σused/Σtotal) si disponible, sinon série legacy rootfs |
| `GET /api/trends?endpoint=` | 5 min/ep | `{ trend7d: {time, cpuPct, ramPct}[], os: {os, count}[], source }` |
| `GET /api/metrics?timeframe=&endpoint=&node=` | 5 min/(ep,tf,node) | `{ timeframe, points: MetricsPoint[], source }` — `timeframe ∈ hour\|day\|week\|month` (sinon **400**) ; `MetricsPoint = { time, cpuPct, ramPct, storagePct:number|null, netInBps, netOutBps }`. Bucket sans série `storage_metrics` → `storagePct: null` (gap). Vue nœud (`?node=`) exclue de la fusion stockage |
| `GET /api/overcommit-risk?endpoint=` | 5 min/ep | Risque dynamique : pire cas = Σ p95 (7 j, `vm_metrics`) par VM running vs capacité physique. `{ insufficientData, cpu:{usagePct,ratio,severity,demandCores,capacityCores}, ram:{…Bytes}, storage:{usagePct,daysTo90,severity}, vms:[{vmid,name,cpuP95Pct,memP95Bytes}] }` — `null`/`na` si aucun historique |
| `GET /api/network-topology` | 5 min/ep | `{ topologies: NetworkTopology[] }` (tous les endpoints ; un endpoint en échec est omis ou servi depuis le cache périmé) |
| `GET /api/storage-inventory` | 5 min/ep | `{ endpoints: [{ endpointId, storages: PveStorage[], vms: StorageVmRef[] }] }` — groupement/agrégats calculés côté client (`shared/storage-inventory`) |
| `GET /api/vm-config?endpoint=&vmid=` | snapshots 5 min/(ep,vmid) ; config 1 h (client PVE) ; live = snapshot courant | `VmDetailResponse { vm: VmSummary (live), config: VmConfigInfo \| null, snapshots: PveVmSnapshot[] }` — 400 si vmid invalide, 404 endpoint/VM inconnu, 503 avant le 1er tick. Snapshots = appel PVE à la demande (`/nodes/{n}/{type}/{vmid}/snapshot`, pseudo-entrée `current` filtrée) |
| `GET /api/node-sensors` | 1 min | `NodeSensorsResponse { timeframe, nodes[], smart: SmartDevice[], sensors: SensorReading[], zfs: ZfsStatus[], failedUnits: FailedUnit[], source:'influx'\|'empty' }` — métriques locales Telegraf (SMART, capteurs, ZFS ARC, unités systemd) depuis la base `raw`, dernier point par clé. **try/catch par section** (une table absente ne vide pas les autres) · `health_ok` arrive en boolean `true` · colonnes ZFS = `arcstats_*` (voir skill `node-sensors`) |

## 3. WebSocket `/ws`
- Pousse `{ type:'snapshot', data: MultiDashboardSnapshot }` **toutes les 5 s** (rythme du poller) + immédiatement au connect.
- Aucun message client→serveur ; le web se reconnecte en backoff exponentiel (1 s → 30 s max).
- La config `overcommit.json` est aussi poussée en WS (defaults côté web avant le 1er push).

## 4. Repli InfluxDB → RRD (historique)
- `influxReady = influx.enabled && !mock` ; erreur de requête ou série vide → warn loggé + RRD Proxmox (`source:'rrd'`).
- Buckets par timeframe : `hour`=1 min/1 h, `day`=5 min/24 h, `week`=1 h/7 j (base **raw**) ; `month`=1 j/30 j (base **consolidated**).
- Filtre cluster : `COALESCE(cluster, '<default>') = '<epId>'` (lignes legacy sans tag → endpoint par défaut) ; `endpoint=all` → `1=1`.
- Sémantique disque : `storage_metrics` (stockage VM, pondéré par capacité) ≠ `disk_pct` (rootfs nœud).

## 5. Ajouter un endpoint
1. Créer `packages/server/src/modules/<name>/routes.ts` avec `registerXxx(app, ctx, poller)` (même signature).
2. L'enregistrer dans `modules/index.ts` (tableau `modules`).
3. Types partagés → `@proxmox/shared` (types.ts ou fichier dédié) — jamais dupliqués serveur/web.
4. Endpoint lourd → cache 5 min + repli InfluxDB→RRD s'il lit l'historique.
5. Côté web : consommer via `ctx.api` (client REST partagé, `core/api/apiClient`) — jamais de HTTP/WS propre depuis un plugin.
