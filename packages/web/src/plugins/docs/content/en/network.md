# Network topology

An **auto-discovered** wiring diagram from the Proxmox API (switches → nodes → bridges → VLAN segments → VMs) and an **inventory** of the networks and the VMs that use them.

- **Who it's for**: the manager / IT director doing **network hypervision** — what is connected where, what goes down if an element goes down, and the impact on VMs.
- **What it does**: Prox4u reads the network configuration of all your Proxmox nodes (NICs, bridges, VLANs, VM attachments) and draws it as an interactive diagram. You can simulate an incident there (switch, VLAN, bridge, NIC, node, site) and immediately see which VMs are lost or degraded.

---

## How to use it

### 1. Open the page and read the diagram

1. Open **Network topology** in the menu (route `/topology`).
2. At the top, choose the **view**: **All servers** (aggregated view, inventory only) or a specific **endpoint** (Proxmox cluster).
3. The diagram is displayed hierarchically: **switches** → **Proxmox nodes** → **Linux bridges** → **VLAN segments** → **VMs / containers**.
4. The **legend** under the diagram explains the elements: switch (inferred), node, bridge, segment, Proxmox internal network (shield icon), running / stopped VM.
5. The **Refresh** button reloads the topology (the server caches it for 5 minutes per endpoint).
6. After moving elements with the mouse, **Reset layout** puts the diagram back in order.

![Network topology — auto-discovered diagram](/screenshots/network-topology.png)

### 2. Search and filter

- **Unified search** (field at the top): type a network, a VLAN, an IP, a VM, a `vmid`… — the inventory **and** the diagram are restricted to the results.
- **Network** (dropdown): select an exact segment (bridge + VLAN) — the diagram shows only that segment and the corresponding inventory row expands automatically.
- **Filter by…** (multi-select): **VLANs**, **Bridges**, **Physical NICs**.
- If several filters are active, the most specific one wins: selected network > search > multi-select.

### 3. View the networks → VMs inventory

The table above the diagram lists **one row per network** (bridge + VLAN segment) with:

- **Type**: Proxmox internal or External;
- **Subnet**, connected **Nodes**, **VMs** (running / stopped), **Traffic**;
- **State**: Nominal / Degraded / Down / Unknown;
- **Impact if it fails**: how many VMs would be lost or degraded.

Click a row to **expand** it and see the VMs that use the network (interface, `MAC`, `IP`). The **CSV export** button exports the current view: one row per VM interface on a network (server, network, VLAN, type, subnet, node, `vmid`, VM, interface, IP, `MAC`, state) — file `inventaire-reseaux-<date>.csv`.

### 4. Simulate a network incident

1. In the **Network incident** dropdown, choose the element that "goes down": **Switch**, **VLAN**, **Bridge**, **Physical NIC** or **Node**.
2. The diagram highlights the element and its neighborhood, and a panel summarizes:
   - **Impacted VMs (down)** — they lose all their interfaces;
   - **Degraded VMs** — they lose one but keep others.
3. Clicking any element in the diagram also shows its details, including "VMs impacted if this fails".

### 5. Simulate a PRA N-1 (site failure)

1. In the **PRA N-1 simulation** dropdown, choose a **site** (disabled if the endpoint has only one site).
2. The nodes of the simulated site are highlighted in the diagram, and a banner indicates:
   - **failover impossible** — insufficient capacity elsewhere (red);
   - **X VMs to fail over — other sites' free capacity used at Y %** (orange).

### 6. View an element's details

Clicking an element in the diagram opens the **Details** panel:

- **Switch** (inferred): subnet, connected nodes, impact;
- **Node**: state, IP, physical NICs, bridges;
- **Bridge**: IP, subnet, gateway, ports, attached VMs, impact;
- **Segment**: bridge, VLAN (or native), VMs;
- **VM**: state, node, interfaces table — clicking an interface gives its details (bridge, VLAN, `MAC`, `IP`, traffic) and its impact: **VM down** if it's the only interface, **VM degraded** otherwise.

---

## What happens in the background

- **Source**: Proxmox API (read-only) — NICs, bridges, VLANs and VM attachments (parsing of `bridge=` from the VM configuration interfaces).
- **Server cache**: the topology is cached for **5 minutes per endpoint**; **Refresh** forces a reload.
- **Live IPs (guest agent)**: for each running QEMU VM, Prox4u queries the **guest agent** (`network-get-interfaces`, **60 s** cache) and joins the result to the Proxmox configuration **by `MAC`** to display the real `IP` of each interface (IPv4 + IPv6). Stopped VM or LXC: static configuration IP.
- **Inferred switches**: the Proxmox API does not see physical switches — Prox4u **infers** them (same bridge name + same subnet = same switch) and flags them "inferred" in the details.
- **Incident analysis and PRA simulation**: computed **instantly in the browser** from the current topology and the sites' PRA snapshot (WebSocket) — no server call.

| Event | When | Detail |
|---|---|---|
| Topology load | opening the page + **Refresh** button | `/api/network-topology`, server cache 5 min per endpoint |
| Live IP refresh | every time the topology is built | QEMU guest agent, 60 s cache per VM |
| Incident / PRA analysis | on selection in the dropdowns | instant, computed in the browser |

---

## Configuration (summary)

| Parameter | Where | Default |
|---|---|---|
| View (All servers / endpoint) | top of page (encoded in the URL) | All servers |
| Search / network / filters | top of page (encoded in the URL) | none |
| Topology cache | server | 5 min per endpoint |
| Guest agent IP cache | server | 60 s |

---

## Known limitations

- **Inferred switches, not discovered**: the Proxmox API does not expose physical switches. The inference (same bridge + same subnet) may merge two physical switches or split one.
- **Aggregated view without diagram**: "All servers" shows only the inventory (intentional) — choose an endpoint to see the diagram.
- **VLAN volume**: with many VLANs (~200), the diagram relies on search and filters — not everything is rendered at once.
- **Live IPs**: only for **running** QEMU VMs with the guest agent installed. LXC = static configuration IP; stopped VM = no live IP.
- **Read-only**: the module never modifies the network (no actions).
- **PRA simulation**: requires at least **2 sites** on the endpoint, otherwise disabled.

---

## FAQ / troubleshooting

**Why are my switches "inferred"?**
The Proxmox API does not see physical switches. Prox4u groups by bridge name + subnet: same bridge + same subnet = same switch. The details panel indicates this ("inferred").

**Why is there no diagram in the "All servers" view?**
Intentional: the aggregated view is an inventory only (all endpoints). Choose a specific endpoint to display the diagram.

**Why does my VM not show an IP?**
Live IPs come from the **guest agent** (QEMU only, running VM). Without an installed agent or a stopped VM, only the Proxmox configuration IP is displayed (LXC: static IP).

**The diagram is messy after moving elements?**
The **Reset layout** button restarts the original hierarchical layout.

**How do I share a view with a colleague?**
The URL is shareable: the view (endpoint / all servers), the search and the selected network are encoded in the URL (`view`, `q`, `net`).

**What does "Impact if it fails" mean?**
The number of VMs that would be **lost** (all their interfaces cut) or **degraded** (at least one interface remaining) if this network or this element went down — computed instantly from the current topology.
