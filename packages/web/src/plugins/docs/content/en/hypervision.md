# Overview

Provides a **real-time view of the entire fleet** (all Proxmox clusters) and lets you drill down to the **cluster** and then to the **node**.

- **Who uses it** : the IT department / admin who wants a global view of the fleet, and the **NOC** that continuously monitors clusters, nodes and VMs.
- **What it does** : Prox4u aggregates all Proxmox endpoints into a single real-time view — resources, Health Score, PRA (N-1 failover), overcommit, alerts — then lets you drill down into the detail of a cluster and a node.

---

## How to use it

### 1. Open the overview

1. Click on **Overview** in the left menu (1st entry).
2. The page shows **the entire fleet, multi-cluster** :
   - the **resource charts** (CPU, RAM, disk — 7 days) with a **cluster selector** (« All clusters » or a specific cluster) ;
   - the **KPI cards** (nodes, CPU/RAM, storage, VMs & containers) — the VMs card shows a **red** counter if some VMs have no **PVE agent** ;
   - the **Nodes — all clusters** matrix (one row per node, grouped by cluster : status, CPU, RAM, disk, VMs) ;
   - the **System — per node** card (load, I/O wait, swap, uptime) ;
   - the **Temperatures — per node** widget (max sensors + max disks) ;
   - the **Global PRA** widget (cross-cluster failover) ;
   - the **InfluxDB 3 Core** widget (health of the metrics database) ;
   - the **endpoint cards** (health score + status) and the **endpoint table** (status, nodes, VMs, usages, overcommit, risk, audit score) ;
   - the **alerts** (critical ones first).
3. The **Proxmox submenu** (chevron under « Overview ») lists all endpoints and nodes — direct access to the details.

![Multi-cluster overview](/screenshots/overview.png)

### 2. Open the endpoint (cluster) detail

1. Click on an **endpoint card** or a row of the **table** (or the Proxmox submenu).
2. The page shows the **cluster dashboard** (17 blocks) :
   - 7-day resource charts + KPIs with sparklines ;
   - **Health Score** gauge (with penalties) ;
   - **PRA N-1** (intra-cluster failover) ;
   - **capacity planning** (CPU/RAM/disk, with projection) ;
   - **storage**, **network** (cluster traffic), **Top 5 consumers** (VMs + pools) ;
   - **overcommit** (ratios + dynamic risk) ;
   - **nodes table** (link to the node detail) ;
   - **configuration score** (audit) ;
   - **cluster metrics** (CPU / RAM / network, one metric at a time, CSV export).
3. The header carries **badges** of the cluster status :
   - **Quorum** : green « Quorum x/y » or red « Quorum lost » ;
   - **Qdevice** : 🟢 online / 🔴 offline ;
   - **Failover** : « API via … (endpoint node unreachable) » if Prox4u has switched to another node.

![Endpoint detail — cluster dashboard](/screenshots/endpoint-detail.png)

![Quorum lost + API failover](/screenshots/quorum-lost-failover.png)

### 3. Open the node detail

1. From the cluster page, click on a node in the **nodes table** (or the « Nodes — all clusters » matrix, or the submenu).
2. The page shows :
   - the header : node name, **online / offline** badge, CPU/RAM overcommit badges, IP · PVE version · uptime ;
   - the **4 KPI cards** (CPU, RAM, disk = system disk, load) ;
   - the **Host details** card (identification + CPU/DMI hardware) ;
   - the **Capacity & usage** card (used vs capacity bars) ;
   - the **VMs table** (vmid, name, KVM/LXC, status, CPU, RAM) ;
   - the **Node monitor charts** (system, CPU per core, I/O per disk, network per interface, temperatures, SMART, ZFS ARC, load, swap).

![Node detail](/screenshots/node-detail.png)

### 4. Customize the layout

1. On the overview, cluster and node pages, each block is a **widget** that you can **move** and **resize** (drag the header).
2. Click on **Chart library** to add or remove widgets, and on **Reset layout** (with confirmation) to go back to the default layout.
3. The layout is **saved per account and per page** — each user has their own view.

---

## What happens in the background

- **Real-time (WebSocket)** : the server pushes a fleet snapshot **every 5 s** — KPIs, node status, VMs, alerts, Health Score, quorum, Qdevice, audit score, Global PRA, InfluxDB health. No manual refresh.
- **Heavy data (5 min)** : capacity planning, trends and dynamic risk are reloaded on page mount then **every 5 min**.
- **Poller** : continuously collects Proxmox data (nodes, VMs, storage, cluster), writes it to **InfluxDB**, and computes at each tick the Health Score, the PRA, the audit score and the alerts.
- **Quorum** : read from `quorate` (PVE 9) ; if lost → Health Score −25 + critical alert.
- **Qdevice** : status read from corosync (Telegraf agent), fallback by API deduction ; if offline → Health Score −10 + warning alert.
- **Failover** : if the endpoint node is unreachable, Prox4u automatically switches to another node of the cluster (« API via … » badge).
- **Sensors / temperatures** : read from the nodes' **Telegraf** agent (SMART, chips, ZFS ARC, systemd units), server cache 1 min.

| Event | When | Detail |
|---|---|---|
| Snapshot push (WS) | every 5 s | KPIs, status, alerts, Health Score, quorum, Qdevice, audit, Global PRA, InfluxDB |
| Heavy data reload | on mount + every 5 min | capacity planning, trends, dynamic risk |
| Poller tick | continuous | Proxmox collection → InfluxDB + scores/alerts computation |
| Sensors refresh | 60 s (1 min cache) | Telegraf agent (SMART, chips, ZFS ARC) |
| InfluxDB ping | 60 s | health of the metrics database (never blocks the tick) |

---

## Configuration (summary)

| Parameter | Where | Default |
|---|---|---|
| Page layout (overview / cluster / node) | per user, saved automatically | default layout |
| Module version | « My profile → Modules » | v4 (current version) |
| Overcommit / usage thresholds | `overcommit.json` (hot-reload) | built-in (if absent) |
| Audit thresholds | `audit.json` (hot-reload) | built-in (if absent) |

---

## Known limitations

- **Data gaps** : when a node is powered off, its data is missing (expected, not a pipeline defect).
- **Disk curve** : accumulates since the 1st tick — 7 days for a complete view.
- **Node network (PVE ≥ 9)** : Proxmox no longer returns per-node traffic ; the curve is the sum of running VMs.
- **Global PRA** : only if the nodes are spread over **≥ 2 sites** ; requires an **ISO storage** from one site to the other (documented precondition, no config flag).
- **v4 features** (cluster selector, nodes matrix, Global PRA, Qdevice, InfluxDB widget…) : visible only if the user has selected `hypervision_v4` in « My profile → Modules ».
- **30-day timeframe** : requires InfluxDB started with `--query-file-limit=10000`.

---

## FAQ / troubleshooting

**The layout is no longer the way I want it?**
Click on **Reset layout** (with confirmation) to go back to the default layout. The layout is saved per account and per page.

**A red « Quorum lost » badge is shown?**
The cluster has lost its quorum (majority of nodes offline) → Health Score −25 + critical alert. On a cluster with Qdevice, the loss of a single node does not lose the quorum (the Qdevice maintains it).

**A red « Qdevice offline » badge is shown?**
The Qdevice (corosync) is offline — the quorum is no longer protected if a node goes down. Health Score −10 + warning alert. No immediate incident as long as the quorum holds.

![Qdevice online badge](/screenshots/qdevice-online-badge.png)

**An « API via … » badge is shown?**
The endpoint node is unreachable ; Prox4u has automatically switched to another node of the cluster. The badge disappears as soon as the endpoint node is back.

**The « N VMs without PVE agent » counter is red?**
Running QEMU VMs do not have the guest agent (QGA) active (critical). Check these VMs in the inventory.

**The cluster selector does not change the KPIs?**
By design : the selector only drives the 3 7-day charts (curves, current value, allocation line). The KPIs stay aggregated over all clusters.

**The disk curve is empty or partial?**
It accumulates since the 1st tick — 7 days for a complete view. The gaps correspond to powered-off nodes.
