# Proxmox inventory

A **consolidated inventory of the entire multi-endpoint fleet** : **one machine per row** (QEMU + LXC), cross-referencing live resources, guest agent data (real OS, disks, interfaces/IPs) and the Proxmox configuration (tags, notes).

- **Who uses it** : the IT department / infra admin who needs a single, up-to-date view of the fleet (asset inventory, IP lookups, checking agent status).
- **What it does** : Prox4u aggregates all machines from all Proxmox endpoints into a single table that can be filtered, sorted and exported (TXT / CSV / JSON).

---

## How to use it

### 1. Opening the inventory

1. In the left menu, open **Proxmox inventory** (route `/proxmox-inventory`).
2. The page shows :
   - a global **search** field (name, hostname, VMID, node, OS, IP, tag, note…) ;
   - **9 summary cards** : Total, Shown, Running, Stopped, RAM alloc. / RAM used, CPU cores, CPU avg (%), and **Agent OK n/total** ;
   - the table : **one row per machine**, all endpoints combined (the **Host** column indicates the source endpoint).

![Proxmox inventory — consolidated multi-endpoint view](/screenshots/proxmox-inventory.png)

### 2. Searching and filtering

1. Type text into the **search** : it covers all columns (name, hostname, VMID, node, type, status, OS, IPs, tags, notes), case-insensitive.
2. Use the **per-column filters** (at the top of each column) :
   - **Node**, **Type**, **Status** : list of the values present in the inventory ;
   - **PVE agent** : fixed values **active** / **inactive** / **N/A** ;
   - **CPU**, **RAM**, **Disk** : min / max ranges.
3. **Sort** by clicking a column header (name, VMID, node, type, status, agent, CPU, RAM, uptime, disks…).

### 3. Exporting the filtered view

1. Choose the format : **CSV**, **TXT** or **JSON**.
2. Click **Export** : the downloaded file contains only **the rows currently displayed** (after search and filters), not the whole inventory.
3. Use **Refresh** to force a refresh of the data.

---

## What happens in the background

For each machine, Prox4u cross-references three sources :

- **live resources** (status, CPU, RAM, uptime) ;
- the **guest agent** (QGA) : real OS, disks per filesystem, interfaces and IPs ;
- the **Proxmox configuration** : tags, notes, OS type (fallback when the agent is unavailable).

| Event | When | Detail |
|---|---|---|
| Inventory refresh | every **5 min** per endpoint | background recompute of the agent data (OS, disks, IPs) |
| Page load | on every visit | serves the last known value (even if stale) + kicks off the background recompute |

- **5-minute cache per endpoint (stale-while-revalidate)** : the page **never** blocks behind an agent computation — the last known value is displayed immediately, the recompute runs in the background.
- **Best-effort** : a stopped VM or one without an agent does not cause an error — its disks and IPs are simply empty.
- **Bounded concurrency** : a slow VM only holds a few agent calls at a time, not the whole inventory.

**Flow** : Proxmox API (resources + guest agent) → server cache (5 min) → `GET /api/proxmox-inventory` → table.

---

## Configuration (summary)

| Parameter | Where | Default |
|---|---|---|
| Inventory cache | server (internal) | 5 min per endpoint |
| Agent call timeout | server (internal) | 8 s per VM |
| Agent call concurrency | server (internal) | bounded (a slow VM does not block the others) |

> This module has **no user-facing settings** : it is a read-only view of the fleet.

---

## Known limitations

- **Real OS** : read via the guest agent ; for stopped VMs or VMs without an agent, the Proxmox configuration is used as a fallback (less precise).
- **PVE agent "N/A"** : LXC containers, stopped VMs and templates have no guest agent — this is normal, not a failure.
- **Export of the filtered view only** : the exported file contains the displayed rows, not the full inventory.
- **Cold start** : on the first load after a server restart, the page may take a few seconds (the agent caches are not warm yet).

---

## FAQ / troubleshooting

**Why is the "PVE agent" column red "inactive" on a running VM?**
The VM is running (QEMU) but the guest agent is not started or is not reachable inside the operating system. Check the agent service inside the VM (e.g. `qemu-guest-agent` on Linux).

**Why "N/A" in the agent column?**
Normal for LXC containers, stopped VMs and templates : they have no guest agent. If you see "N/A" on a running QEMU VM right after a server restart, the agent cache may not be warm yet — click **Refresh**.

**Why are the disks or IPs empty on some VMs?**
The guest agent is not responding (stopped VM, agent not installed). The row is still displayed with the available data (status, CPU, RAM, tags…).

**My export does not contain all my VMs?**
The export only exports the **filtered view**. Clear the search and the column filters, then export again.

**The data looks stale?**
The inventory is **cached for 5 minutes** per endpoint. Click **Refresh** : the last known value is displayed immediately and the recompute runs in the background.
