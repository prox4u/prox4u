# Node Sensors

Displays the **local metrics** that the Proxmox API does not provide — disk **SMART** (predictive failure detection), **temperatures** (CPU / disks / memory), **ZFS ARC**, **failed systemd units** — collected by the **Telegraf** agent running on each Proxmox node.

- **Who uses it**: the IT department / admin who monitors physical hardware health, and the **NOC** who tracks disk / temperature alerts.
- **What it does**: Prox4u reads from InfluxDB the measurements written by Telegraf on each node, and displays them in 4 filterable tables, with **custom thresholds** and **value history** (31-day / 1-year chart).

---

## How to use it

### 1. View node sensors

1. Open the **Node Sensors** page (route `/node-sensors`).
2. The page displays **4 tables**:
   - **Disk Health (SMART)**: node, device, model, health, temperature, reallocated sectors, NVMe wear;
   - **Temperatures (sensors)**: node, chip, sensor, temperature, critical threshold, fan;
   - **ZFS ARC**: node, hits, misses, size;
   - **Failed systemd units**: node, unit, `active`, `sub`, `load` — **only real alerts** (units `failed` / `error`).
3. Use the **Sections filter** (multi-select dropdown, "All" option) to show / hide the tables.
4. Use the **column filters** (multi-select) to narrow down by node, device, health, etc.

> **SMART health** is tri-state: **OK** (green) / **CRITICAL** (red) / **Unknown** (gray). A disk without SMART (virtual, RAID volume) is "Unknown", **not** "CRITICAL". A disk temperature of `0 °C` is displayed as "—" (no sensor).

![Node Sensors page — 4 tables and filters](/screenshots/node-sensors.png)

### 2. View the history of a sensor or a disk

1. In the **Temperatures (sensors)** or **Disk Health (SMART)** table, click the **chart icon** next to a temperature (SMART: only if the reading is not `0 °C`).
2. The **"Value history"** dialog opens:
   - the identity (node / chip / sensor, or node / device) and the **last reading**;
   - the **31 days / 1 year** toggle;
   - a **resizable chart** (drag the corner) — the size is **persisted per target** and per account.
3. Reference lines: sensor → **effective threshold** (red) + firmware threshold (gray, if custom threshold); SMART → fixed critical line **80 °C**.

> **Gaps in the curve are data**: a powered-off node does not measure — the gaps remain visible, never filled in (no interpolation).

### 3. Set a custom sensor threshold (admin)

1. Open **Administration → Sensor thresholds**.
2. For each sensor (node / chip / sensor), enter a **custom threshold** — **always ≤ the firmware threshold** (the value is clamped).
3. The **Temperatures (sensors)** table colors temperatures according to the **effective threshold** (custom, otherwise firmware): **critical** if the threshold is reached, **warning** within the 20 °C margin below the threshold, **OK** otherwise.
4. **Reset** a threshold (per row) or **Reset all**.

> These thresholds feed the **Alarms & Centreon** module ("temperature > effective threshold" rules).

### 4. Host system metrics (Overview + node Monitor)

The same Telegraf measurements also feed:
- the **Overview** page: the **"System — per node"** card (cross-node table: load 1/5/15, iowait, swap, uptime);
- the **Monitor** tab of the **node detail** (VM view): **System**, **CPU per core**, **Disk I/O** (per physical device), **Network** (per interface) sections, plus **temperatures**, **ZFS ARC**, **load**, **swap** charts.

These views are read-only, no configuration required — the data is already in InfluxDB.

---

## What happens in the background

- The **Telegraf** agent (bare-metal on each Proxmox node) writes its measurements to the InfluxDB `raw` database (retention **31 days**) **every ~10 s**.
- Prox4u reads the **last point per key** (current state, not an aggregate), with a **1-minute cache**.
- A **15-minute consolidator** aggregates `smart_device`, `sensors`, `zfs`, `systemd_units` (min / max) into the `consolidated` database (retention **∞**) → long-term history for the 1-year chart.

| Event | When | Detail |
|---|---|---|
| Telegraf measurement | every ~10 s | write to the `raw` database |
| Prox4u cache | 1 min | last state per node / device / chip / unit |
| Consolidation | 15 min | min / max into `consolidated` (∞) |
| Value history | on demand | `raw` (10-min buckets) + `consolidated` (15 min), 5-min cache |
| Host system metrics | on demand | load / swap / iowait / per core, I/O per device — 5-min cache |

**Flow**: Telegraf (node) → InfluxDB `raw` → Prox4u API → `/node-sensors` page (and the **System** card of the Overview + the **node Monitor** of the VM view).

---

## Configuration (summary)

| Parameter | Where | Default |
|---|---|---|
| Telegraf agent | on each Proxmox node (script `60-telegraf-nodes.sh`) | — |
| `raw` database retention | InfluxDB | 31 days |
| `raw` → `consolidated` consolidation | Prox4u (auto) | 15 min (min / max) |
| Prox4u cache | Prox4u (auto) | 1 min |
| Custom sensor thresholds | Admin → Sensor thresholds | firmware threshold |
| SMART critical threshold | fixed | 80 °C (warning 60 °C) |
| Temperature warning margin | fixed | 20 °C below the threshold |

---

## Known limitations

- **Telegraf agent required**: without the agent (or not (re)deployed), the tables are empty — the page shows a readable "no data" state, not an error.
- **SMART**: a disk behind a RAID controller or a virtual disk does not return health → "Unknown" (not "CRITICAL").
- **ZFS ARC**: on a node without a ZFS pool (LVM), hits / misses are 0 — the hit rate series is hidden.
- **Failed systemd units**: only the `failed` / `error` states are shown — the `dead` state (normal for one-shots / on-demand units) is ignored.
- **I/O and network history**: limited to 31 days (`raw` retention).
- **ZFS pools** (name / state / size): not yet populated.

---

## FAQ / troubleshooting

**Why are the tables empty?**
The Telegraf agent is not installed (or not (re)deployed) on the node. Run the deployment script `deploiement/60-telegraf-nodes.sh` on the node; the data then appears within a few seconds.

**Why does a disk show "Unknown" health?**
The disk does not expose SMART (virtual disk, RAID volume, unreadable state) — this is **not** a failure. Only "CRITICAL" (SMART `FAILED`) is an alert.

**Why does a disk temperature show "—"?**
`0 °C` means the disk has no temperature sensor.

**Why is my threshold clamped?**
A custom threshold **cannot exceed the firmware threshold** (the clamp is applied on save). This is intentional: it is a stricter alert, not a looser one.

**Why are there gaps in the history chart?**
A powered-off node does not measure. The gaps are **data**, never filled in (no interpolation).

**How do I view the history of a disk or a sensor?**
Click the chart icon next to the temperature in the **Temperatures (sensors)** or **Disk Health (SMART)** table → "Value history" dialog (31 days / 1 year, resizable chart).
