# Storage

vCenter inventory of **Proxmox datastores** (local, Ceph, NFS, ZFS, LVM, iSCSI…): capacity, type, contents and **VMs whose disks reside on them**, consolidated across all endpoints.

- **Who uses it** : the **IT department** / infra admin who needs to know what is stored where, how much space is left, and when a datastore will saturate.
- **What it does** : Prox4u consolidates the datastores of all your Proxmox clusters into a single view, with capacity colouring following the `overcommit.json` policy, the iSCSI → LVM physical hierarchy, and per-datastore saturation forecasting.

---

## How to use it

### 1. Viewing the datastore inventory

1. Open **Storage** in the menu (route `/storage`).
2. The page shows, above the table, the **Physical volumes** panel (see step 2), then the **datastore table** : one row per datastore, with :
   - **Datastore** (icon per type) · **Server** (aggregated view only) · **Type** (badge, "Shared" if shared) · **Node** (or "shared") ;
   - **Capacity** (coloured bar + used/total) · **Content** · **VMs** (running + stopped) · **State** (badge **Nominal** / **Watch** / **Critical** / **Unknown**).
3. Filter and sort :
   - **Search** (datastore, type, node, VM, vmid…) ;
   - the **Type** (list of types present in the current view) ;
   - the **Server** : **All servers** or a specific endpoint — the view is **shareable by URL** ;
   - **sorting** on the headers (datastore, server, type, capacity, VMs, state).
4. Click **Refresh** to reload the inventory (5-minute server cache).

![Storage page — physical volumes + datastore table](/screenshots/storage.png)

### 2. Exploring the physical volumes (iSCSI → LVM)

The **Physical volumes** panel shows storage **in physical hierarchy**, not per datastore :
- an **iSCSI LUN** is the **reference volume** (parent card) ; the **LVM VGs** sitting on it are **indented** below it (the "└" connector + the "under {LUN}" label) ;
- the **LUN capacity is counted only once** — never LUN + VG (redundant datastore views are grouped together) ;
- each volume is classified as **Thin** (over-allocation, can exceed 100 %) or **Thick** (usage, ≤ 100 %), with **Real capacity** (or **Capacity (lower bound)** if the LUN size is unknown), **Committed space (Σ VGs)** and **VM disks allocated**.

Expand or collapse a LUN (**Expand the LUN** / **Collapse the LUN**) to show or hide its VGs.

> If a LUN shows "Capacity (lower bound)", its physical size is not known to Proxmox : set it in `storage-volumes.json` (`lunSizes`) to display the real capacity.

### 3. Datastore drill-down (customizable grid)

1. Expand a table row (chevron) : a **customizable grid** opens with **3 widgets** :
   - **Occupancy** — history chart, **1 year** or **31 d** period ;
   - **Capacity planning** — days until 90 % + slope ;
   - **Hosted VMs** — name, vmid, disk size, node, state (50 per page, **Show more**).
2. Customize the grid : **drag** cards by their header, **resize** with the handle, **Remove** a card (it goes to the **Chart library**), re-insert it from the library, or **Reset layout**.
3. The layout is **saved for your account, per datastore** — each user has their own view.

### 4. Exporting the inventory

Click **Export CSV** : a flat file, **one row per VM on a datastore** (server, datastore, type, nature, node, vmid, VM, VM's node, disk size, state) — opens directly in Excel.

---

## What happens in the background

- **Inventory** : the poller queries Proxmox (`/cluster/resources` + VM configs) and consolidates the inventory ; the `/api/storage-inventory` endpoint is **cached for 5 minutes** on the server.
- **Physical volumes** : computed by the poller (pure function, iSCSI → LVM hierarchy, LUN capacity counted once) and pushed into the **WebSocket snapshot** — zero recomputation on the client side.
- **Occupancy + forecast** : the history is read from InfluxDB (`datastore_metrics`), with a **Proxmox RRD fallback** if less than 7 days of data ; the saturation forecast (days until 80/90 %, slope, 30-day projection) is computed from that history.

| Event | When | Detail |
|---|---|---|
| Inventory refresh | on every poller tick (5 s) + 5-minute REST cache | re-reads storage + VM disks of each endpoint |
| Physical volumes snapshot | pushed via WebSocket (5 s) | iSCSI → LVM hierarchy recomputed, capacity counted once |
| Occupancy series | on demand (drill-down) | InfluxDB `datastore_metrics`, RRD fallback < 7 d |
| Saturation forecast | on demand (drill-down) | days until 80/90 % + 30-day projection |

---

## Configuration (summary)

| Parameter | Where | Default |
|---|---|---|
| iSCSI LUN sizes | `storage-volumes.json` (repo root, optional — `lunSizes`) | lower bounds (Σ VGs) |
| Capacity thresholds | `overcommit.json` (hot-reload) | warn 70 % / crit 90 % |
| Drill-down layout | per account (`/api/user-config`, per-datastore scope) | 3 default widgets |

---

## Known limitations

- **Ceph panel + I/O charts** : phase 2, **not implemented**.
- **Thin storage** (LVM-thin / ZFS / Ceph RBD) : the virtual size can exceed the real space — see the overcommit policy.
- **Unknown capacity** : some datastores expose no capacity → empty bar + "—" (do not read as 0 %).
- **LUN sizes** : without `storage-volumes.json`, iSCSI capacities are shown as **lower bounds** (sum of the VGs).
- **PVE 9** : disk storage is no longer in `/cluster/resources` → it is parsed from the VM configs (server-side).

---

## FAQ / troubleshooting

**Why does a LUN show "Capacity (lower bound)" ?**
The physical size of the LUN is not known to Proxmox : the displayed capacity is the sum of the sizes of the VGs sitting on it. Set the LUN size in `storage-volumes.json` (`lunSizes`) to display the real capacity.

**Why can't I expand a datastore row ?**
A row is expandable if it has **child VGs**, **hosted VMs**, or a **known capacity**. A datastore with no VMs and no capacity (e.g. an empty ISO/backups `dir`) does not open.

**Why does an LVM VG appear under an iSCSI LUN ?**
An iSCSI LUN and its LVM VGs are **the same physical volume** : the LUN is the parent, the VGs are its children. The LUN capacity is counted **only once** (never LUN + VG) to avoid double counting.

**The inventory looks stale ?**
The endpoint is **cached for 5 minutes** on the server. Click **Refresh** : if the cache has not expired, the response may remain the cached one until it expires.

**The Occupancy chart is empty ?**
The poller records the history continuously : the curves fill in as ticks accumulate. Less than 7 days of data → **RRD fallback** ; no history at all → "insufficient history" message.
