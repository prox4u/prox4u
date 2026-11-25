# VM view

Inventory of **VMs and LXC containers** across the entire multi-cluster Proxmox fleet, presented like vCenter: `Datacenter → cluster → node` tree, live table, and full-screen details per VM and per node with monitoring. **Read-only**: no power actions (start/stop/reboot).

- **Who it's for**: the IT director / Proxmox admin doing drill-down on the fleet, and the NOC that wants to check the state of a VM or a node and open its console.
- **What it does**: continuously lists (5 s) all VMs and LXC from all endpoints, lets you filter/sort/search them, open the detail of a VM (Summary / Monitor / Configuration / Network / Snapshots) or of a node (Summary / Monitor / VMs), and open the VM's console in the PVE UI.

---

## How to use it

### 1. Browse the inventory

1. Open **VM view** (route `/vms`).
2. On the left, the **Datacenter → cluster → node** tree: VMs are listed as leaves under each node, with counters (running / total).
3. In the center, the multi-endpoint table (VMs + LXC), **refreshed every 5 seconds**:
   - search by **name** (case-insensitive) or exact **VMID**;
   - filters by **status** (running / paused / stopped) and by **type** (VM / LXC);
   - sort by any column: name, VMID, node, type, status, CPU, RAM, disk, **PVE agent**;
   - the **PVE agent** column flags the guest agent: green **active** badge, red **inactive** badge (VM running without an agent — to be addressed), or "—" if not applicable.
4. Click a **VM** → its full-screen detail. Click a **node** → its full-screen detail.
5. The selection is in the URL (`?vm=`, `?node=`, `?tree=`, `?q=`, `?status=`, `?type=`): the link is shareable and reloads exactly as-is.

![VM inventory — tree + table](/screenshots/vm-inventory.png)

### 2. View a VM's detail

1. Click the VM (in the tree or the table).
2. The full-screen detail opens: header (state, **Web console** button) + tabs **Summary / Monitor / Configuration / Network / Snapshots**.
3. **Summary** tab: 10 widgets — guest OS, details, hardware, network interfaces, usage (CPU/RAM/disk bars), related objects, and 3 **cluster-level capacity planning** charts (CPU / RAM / disk: when the resource will be saturated if the trend continues).
4. **Monitor** tab: CPU, RAM, disk, network histories (timeframes **1 h / 24 h / 7 d / 30 d**), disk usage **per filesystem** (via the guest agent), I/O **per disk** of the VM and traffic **per network card** (one chart per card). **CSV** export of the displayed timeframe, per chart.
5. **Web console** button: opens the VM's console **in the PVE UI** (new browser tab).

![VM detail — Summary / Monitor / Configuration / Network / Snapshots tabs](/screenshots/vm-detail.png)

### 3. View a node's detail

1. Click a **node** in the tree.
2. The full-screen detail opens: header (● online / offline, CPU/RAM overcommit ratios, IP, uptime) + tabs **Summary / Monitor / VMs**.
3. **Summary** tab: 4 live KPIs (CPU, RAM, rootfs, load average) + 3 **node-level capacity planning** charts (the "disk" = the node's rootfs).
4. **Monitor** tab: two independent sources, same timeframes and CSV export —
   - **PVE history**: CPU, RAM, rootfs disk, network;
   - **Telegraf host agent**: system (load 1/5/15, iowait, swap, uptime), CPU **per core** (real-time bars), disk I/O **per physical device**, network **per host interface** (PVE firewall interfaces `fw*` are decoded), CPU/chip temperatures, temperatures and **SMART disk health**, **ZFS ARC**, load average, swap.
5. **VMs** tab: the table filtered to this node — click a row to go to the VM detail.

![Node monitor — v4 widgets (temperatures, SMART, ZFS ARC, load, swap)](/screenshots/node-monitor-v4-widgets.png)

### 4. Customize the grids (per user)

The **Summary** (VM and node) and **Monitor** (VM and node) views are customizable grids:

- **drag & drop** and **resize** cards;
- **remove** a card → it goes to the page's **Chart library**, from which it is re-inserted;
- **Reset layout** (with confirmation) to go back to the default layout;
- the layout is **saved per account, per VM and per node** — it is kept on reconnection and only affects you.

> ⚠️ **Renaming a node** resets the node's layouts (Summary and Monitor) to zero: the node name is the key.

---

## What happens in the background

| Event | When | Detail |
|---|---|---|
| Table refresh | every **5 s** | WebSocket push (`snapshot.vms` per endpoint) — state, CPU, RAM, disk, agent |
| VM detail | on opening | `GET /api/vm-config`: live VM, configuration (1 h cache), snapshots (PVE call on demand, 5 min cache) |
| Monitor histories | on opening then every **60 s** | InfluxDB, displayed timeframe (1 h / 24 h / 7 d / 30 d) |
| Disk usage per filesystem | at most every **5 min** per VM | the poller queries the guest agent (`get-fsinfo`), one call per VM at a time |
| Host agent metrics | every **10 s** | Telegraf on each PVE node (system, CPU per core, disk I/O, network, temperatures, SMART, ZFS ARC) |
| Capacity planning | on demand, **5 min** cache | `GET /api/capacity` (cluster) and `GET /api/node-capacity` (node) — projection on the trend ≥ 7 d |

**Flow**: Proxmox poller (PVE API, read-only token) → InfluxDB (histories) + WebSocket snapshot (live) → `/vms` page. Host agent metrics arrive via Telegraf (10 s) in the `raw` database and are served by the `/api/node-*` endpoints.

---

## Configuration (summary)

| Parameter | Where | Default |
|---|---|---|
| Exposed module version | Administration → Module catalog | v4 (`vm-view_v4`) |
| Module enabled / hidden | Administration (Module catalog) | enabled |
| Summary / Monitor layouts | per user, per VM and per node (automatic save) | default layout |
| PVE token | server `.env` | read-only (`ManagerReader`) |
| Guest agent (QGA) | on each VM (required for per-filesystem usage and the PVE agent column) | — |
| Telegraf host agent | on each PVE node (required for the agent sections of the Monitor) | — |

---

## Known limitations

- **Read-only**: no power actions (start/stop/reboot), no VM creation / migration / deletion — dedicated iteration to come.
- **PVE 9**: depending on the storage, the API returns `disk=0` in `/cluster/resources` → the table displays "0 o / X To" (the detail displays the same live value).
- **Web console**: disabled in demo mode (endpoint without a PVE URL) — explanatory tooltip.
- **Renaming a node**: the node's layouts (Summary and Monitor) are reset (the node name is the persistence key).
- **Per-card network of the VM**: if the VM is stopped or on SDN (card without a host `tap`), the chart stays empty — never an invented value.
- **Node Monitor network**: `vnet*` / `tap*` / `veth*` / `lo` are excluded (their traffic is already in each VM's Monitor — double-counting otherwise).
- **Capacity planning**: requires ≥ 7 days of history, otherwise "insufficient data".

---

## FAQ / troubleshooting

**The table displays "0 o / X To" for a disk?**
Known behavior of PVE 9: the API returns `disk=0` depending on the storage. Nothing breaks; the VM detail displays the same live value.

**What does the "PVE agent" column mean?**
Green **active** badge = the guest agent (QGA) responds. Red **inactive** badge = the VM is running but without an agent — critical for per-filesystem disk usage. "—" = not applicable or unknown.

**How do I open a VM's console?**
**Web console** button in the detail header: opens the console in the PVE UI (new tab). Unavailable in demo mode.

**The Monitor is empty or displays "insufficient data"?**
The node is too new, offline, InfluxDB is down, or the node does not have the Telegraf agent. The two sources (PVE history and host agent) are independent: if one is empty, the other stays displayed with its own empty state.

**Can I move the cards of the Summary or the Monitor?**
Yes — drag & drop, resize, remove (→ **Chart library**), re-insert, **Reset layout**. The layout is saved per account, per VM and per node.

**How do I go back to an earlier version of the module?**
The admin enables the exposed version in **Administration → Module catalog**; in the meantime, previous versions remain accessible via `?v=vm-view_v3` or `?v=vm-view_v2` in the URL.
