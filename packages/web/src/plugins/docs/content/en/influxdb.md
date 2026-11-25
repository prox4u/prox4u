# InfluxDB 3 Core

Monitors the **health** of the **InfluxDB 3 Core** metrics database that powers all of Prox4u's charts, and lets you **act** on it (flush, archiving, export, recreating / dropping databases and tables).

- **Who uses it**: the **IT department / admin** who monitors the database and intervenes on it, and the **NOC** who tracks health continuously.
- **What it does**: Prox4u reads the state of the InfluxDB database (status, version, write queue, dropped lines, latency, file headroom), displays its health history (24 h / 7 d / 30 d), lists the databases and their retention, tracks CSV archiving, and offers administrative actions restricted to the authorized groups.

---

## How to use it

### 1. Check database health (everyone)

1. Open **InfluxDB** in the sidebar (route `/influxdb`).
2. The **KPIs** row displays the live status:
   - **Status**: Up / Down / Disabled;
   - **Version** (if the InfluxDB API provides it);
   - **Write queue**: lines pending write;
   - **Dropped lines**: lost lines (saturated queue) — highlighted if > 0;
   - **Query latency**: duration of the last query;
   - **File headroom**: OK / Watch / Critical (margin before the InfluxDB file limit).
3. The page **refreshes every 30 seconds**.

![InfluxDB page — health KPIs](/screenshots/influxdb.png)

### 2. Check the health history

1. In the **History — InfluxDB health** card, choose the **window**: **24 hours**, **7 days** or **30 days**.
2. Four charts:
   - **Write queue** (lines);
   - **Dropped lines (cumulative)**;
   - **Query latency** (ms);
   - **Write rate** (lines/s).

### 3. Check the databases and the archive

1. The **Databases** card lists each InfluxDB database and its **retention** ("infinite" if none).
2. The **Archive (consolidated → CSV)** card displays:
   - the **Last archived bound**;
   - the number of **Files** and their total size;
   - the archive **Directory**.

### 4. Act on the database (authorized groups)

The **Actions** panel is only visible if your account is an **admin** or a member of one of the authorized groups (default: **Administrateurs**, **Exploitations**).

1. **Risk-free actions** (1 click):
   - **Force flush**: empties the write queue immediately;
   - **Archive now**: triggers an archiving cycle;
   - **Reset archive**: restarts the archiving from the beginning;
   - **Export (CSV)**: exports a table from the `consolidated` database over a period (database, table, **From**, **To**) to the archive directory.
2. **Destructive actions** (confirmation dialog):
   - **Recreate database**: drops then recreates the database (data lost), with an optional **retention** (e.g. `2y`, `365d` — empty = infinite);
   - **Drop database**: permanently drops the database and all its tables;
   - **Drop table**: permanently drops a table from a database.
3. The **result** of each action is displayed (success / failure) and the page refreshes.

---

## What happens in the background

Prox4u continuously writes Proxmox metrics into InfluxDB 3 Core, then consolidates and archives them:

| Event | When | Detail |
|---|---|---|
| **Metrics writing** | on every poller tick | Proxmox metrics enter the InfluxDB **write queue** |
| **Auto-telemetry** | on every tick | 1 `influxdb_self` line in the `raw` database (queue, drops, latency) — feeds the charts |
| **Consolidation** | **5 min** window | aggregates the `raw` database (31 d) into the `consolidated` database (infinite retention) |
| **CSV archiving** | every **6 h** | incrementally exports `consolidated` data older than **90 d** to CSV |
| **Health ping** | every **60 s** | checks that the database responds (cached, never blocks the tick) |

**Alerts**: Prox4u raises 3 automatic alerts — **InfluxDB unavailable** (RRD fallback active), **dropped metric lines** (saturated queue), **file limit approaching** (long-term queries).

**Flow**: Proxmox poller → InfluxDB write queue → `raw` database → consolidator (5 min) → `consolidated` database → archiver (6 h) → CSV.

**Fallback**: if InfluxDB is unavailable, the history automatically falls back to the **Proxmox RRDs** (`source: 'rrd'`) — never a crash.

---

## Configuration (recap)

| Parameter | Where | Default |
|---|---|---|
| Groups authorized for actions | `.env` `INFLUX_ACTION_GROUPS` | `Administrateurs,Exploitations` |
| Archiving interval | `.env` `INFLUX_ARCHIVE_INTERVAL_HOURS` | 6 h |
| Minimum archived age | `.env` `INFLUX_ARCHIVE_AGE_DAYS` | 90 d |
| Archive directory | `.env` `INFLUX_ARCHIVE_DIR` | `data/influx-archive` |
| Consolidated database | `.env` `INFLUX_AGG_DB` | `consolidated` |
| Consolidation window | code (fixed) | 5 min |
| Query chunk | `.env` `INFLUX_QUERY_CHUNK_DAYS` | 30 d |
| Query file limit | `.env` `INFLUX_QUERY_FILE_LIMIT` | 10,000 |

---

## Known limitations

- **Version "—"**: some versions of InfluxDB 3 Core do not return the version (`/api/v3/server-info` returns 404) → displayed as "—".
- **Immutable retention**: in Core, the retention of an existing database cannot be changed — to change it, you must **recreate** the database (data lost).
- **Restricted actions**: without the admin role or an authorized group, the **Actions** panel is hidden (403 on the API side).
- **CSV export only**: the ad-hoc export produces a CSV (no Parquet) dropped in the archive directory.

---

## FAQ / troubleshooting

**The page shows "InfluxDB disabled"?**
InfluxDB is not enabled (or in mock mode): the page is read-only and the history falls back to the Proxmox RRD fallback. Enable InfluxDB on the server side to get the KPIs and the actions back.

**The "Dropped lines" KPI is > 0?**
The write queue got saturated: some metric lines were lost. Use **Force flush** to empty the queue and check that the database responds (**Status** = Up). The "dropped lines" alert is raised automatically.

**The "File headroom" KPI is "Watch" / "Critical"?**
Long-term queries are approaching the InfluxDB 3 Core file limit. Reduce the charts' time window, or increase `INFLUX_QUERY_FILE_LIMIT` / decrease `INFLUX_QUERY_CHUNK_DAYS`. The "file limit" alert is raised automatically.

**The "Actions" panel does not appear?**
Your account is neither an **admin** nor a member of one of the groups in `INFLUX_ACTION_GROUPS`. Ask an admin to add you to a group (default: **Administrateurs**, **Exploitations**).

**How do I export a precise history?**
**Export (CSV)**: choose the **table** (`consolidated` database), the **From / To** period, and confirm. The CSV is dropped in the archive directory.

**How do I change a database's retention?**
In Core the retention is immutable: use **Recreate database** with the new **retention** (e.g. `2y`, `365d`). The database is dropped then recreated — the existing data is lost.
