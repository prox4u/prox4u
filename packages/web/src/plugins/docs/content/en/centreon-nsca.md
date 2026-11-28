# Alarms & Centreon

Turns **monitoring rules** on your Proxmox VMs, nodes and clusters into **alarms** sent to **Centreon** (NSCA passive checks).

- **Who uses it** : the manager / IT director who sets the alert thresholds, and the Centreon **NOC** that receives the statuses.
- **What it does** : Prox4u continuously monitors Proxmox metrics, and as soon as a threshold is crossed, it sends an alarm to Centreon. When the situation recovers, it sends a recovery.

---

## How to use it

### 1. Enabling and configuring the module (admin)

1. Open **Administration → Centreon (NSCA)**.
2. Enable the module.
3. Fill in :
   - the **Centreon central** (NSCA server address, port, NSCA password) ;
   - the **pollers** (name + IP) — the NSCA destination follows the IP of the target poller ;
   - the **provisioning transport** : **CLAPI** (recommended, SSH) or **REST v1** ;
   - the **VM → Centreon host mapping** (which Centreon host corresponds to which VM).
4. Set the **periodic frames** (see below).

> The NSCA password, the REST token and the CLAPI password can be provided via the server `.env` (`CENTREON_NSCA_PASSWORD`, `CENTREON_REST_TOKEN`, `CENTREON_CLAPI_PASSWORD`) — they take precedence over the values entered in the interface.

![Administration — "Centreon (NSCA)" tab](/screenshots/admin-centreon-nsca.png)

### 2. Creating an alarm rule

1. Open **Alarms & Centreon → Create a monitor**.
2. Choose :
   - the **target** : a VM, a node (including the node's **sensors** — see below), or a cluster (quorum / Qdevice) ;
   - the **metric** : CPU, RAM, disk, VM status, IP reachable, uptime, network, node online, quorum, **or a sensor metric** (SMART temperature, SMART health, sensor temperature, systemd unit, ZFS pool state) ;
   - the **condition** : threshold (e.g. CPU > 90 %), direction (above / below), severity (WARNING / CRITICAL) ;
   - the **confirmation window** : the condition must hold for the whole window before alerting (avoids spikes).
3. Save : Prox4u **provisions the Centreon service** (passive service), then saves the rule.

![Create a monitor — rule form](/screenshots/alarms-new.png)

### 3. Managing the rules

In **Alarms & Centreon**, the table lists all rules with :
- filters (text, poller, state, provisioning) and search ;
- actions : **activate / deactivate**, **Edit**, **Delete**, **Test** (sends a test frame), **Re-provision** (recreates the Centreon service).

**Deleting a rule** also removes the **associated Centreon service** (Prox4u ↔ Centreon consistency) :
- if the central is reachable, the service is deleted then the rule removed (flash « Rule deleted — Centreon service deleted ») ;
- if the service is already gone from Centreon, the rule is removed (flash « Centreon service already absent ») ;
- if the **central is unreachable**, the rule stays in **« Deletion pending »** state (orange badge in the table, tooltip = last error) and is **retried automatically** as soon as the central responds again (or by clicking Delete again). The Centreon host is **not** deleted (shared by other rules).

![Active monitoring rules — rules table](/screenshots/alarms.png)

---

## Sensor alarm rules (SMART / temperature / systemd / ZFS)

In addition to the VM / node / cluster metrics (Proxmox API), you can create rules on the **nodes' local sensors**, collected by the **Telegraf** agent (InfluxDB database) :

| Metric | What it monitors | Target (node + identifier) |
|---|---|---|
| **SMART temperature** (`smart_temp_c`) | a disk's temperature (°C) | disk (e.g. `nvme0n1`) |
| **SMART health** (`smart_health`) | SMART health (PASSED / FAILED) | disk |
| **Sensor temperature** (`sensor_temp_c`) | CPU / memory temperature (lm-sensors) | chip + feature (e.g. `amdgpu-pci-0300` / `junction`) |
| **systemd unit** (`systemd_unit_failed`) | a unit in failed state | unit (e.g. `openipmi.service`) |
| **ZFS pool** (`zfs_pool_state`) | a pool's state (ONLINE / DEGRADED…) | pool (e.g. `local-zpool`) |

**How it works** :
- These rules read **InfluxDB** (Telegraf agent), **not** the Proxmox API → they work **even if the Proxmox endpoint is unreachable**.
- **Effective threshold** : for the sensor temperature, the applied threshold is the **effective threshold** (custom threshold ≤ firmware threshold, set in **Administration → Sensor thresholds**) — the rule follows the admin tab (the threshold entered in the rule is only used if no threshold is defined for the sensor).
- **Unknown ≠ degraded** : if the target is unknown (unit not found, pool absent, disk without SMART), the rule does **not** alert (no false positive).
- **ZFS pool** : the pool state is provided by the Telegraf script `prox4u-telegraf-zpool.sh` (deployment `60-telegraf-nodes.sh`) — **the agent must be deployed on the node** for the ZFS pool rule to work.

> Example : a "SMART temperature" rule on node `proxmox`, disk `nvme0n1`, condition `> 45 °C`, severity WARNING → Centreon alarm if the disk goes above 45 °C, recovery when it drops back below.

---

## What happens in the background

Prox4u runs an **alarm engine** that, every **15 seconds**, evaluates the active rules :

| Event | When | What is sent to Centreon |
|---|---|---|
| **Alert** | the condition holds for the whole confirmation window | frame with the severity code (WARNING=1, CRITICAL=2) |
| **Recovery** | the condition is no longer true | OK frame (code 0) |
| **OK heartbeat** | every `okHeartbeatSeconds` (default **300 s**) | OK frame (0) for each healthy rule |
| **Host check** | every `hostCheckSeconds` (default **60 s**) | host state derived from Proxmox (VM running→UP, stopped→DOWN…) |

- **The alert is immediate** (as soon as the confirmation window is filled) ; the heartbeat and the host check are **periodic** and exist so that Centreon passive checks do not stay in the `Pending` state.
- The **OK heartbeat is never sent if the rule is in alert** (it does not mask an ongoing alert).
- The **host check** pulls the Centreon host out of `Pending` **without an active check command** (the state is inferred from Proxmox).
- `okHeartbeatSeconds` / `hostCheckSeconds` = **0** → disabled.

**Flow** : Proxmox snapshot (poller) → alarm engine (in-memory ring buffer) → `send_nsca` → poller NSCA daemon → Centreon. For the **sensor rules**, the source is InfluxDB (Telegraf agent, 1 shared read/minute) instead of the Proxmox snapshot — the rest of the flow is identical.

---

## Configuration (summary)

| Parameter | Where | Default |
|---|---|---|
| Module enabled / not | Admin → Centreon (NSCA) | disabled |
| Provisioning transport | Admin → Centreon (NSCA) | CLAPI (SSH) |
| NSCA server + port + password | Admin → Centreon (NSCA) / `.env` | — |
| Pollers (name + IP) | Admin → Centreon (NSCA) | Linux / Windows / Infra |
| `okHeartbeatSeconds` | Admin → Centreon (NSCA) | 300 (0 = off) |
| `hostCheckSeconds` | Admin → Centreon (NSCA) | 60 (0 = off) |
| VM → host mapping | Admin → Centreon (NSCA) | auto-suggestion (hostname → VM) |
| Confirmation window | rule form | to be set per rule |

---

## Known limitations

- **REST v1 transport** : targets the new Centreon API (`/api/latest/` + `X-AUTH-TOKEN`) — reworked in issue #13, validated in real conditions. CLAPI remains available as an alternative.
- **`send_nsca`** must be installed on the Prox4u server (`apt install nsca-client`), otherwise "send_nsca unavailable".
- **Service not deployed** : frames are rejected if the Centreon service has not been deployed (generation + `CFGMOVE`). Provisioning does this step automatically.
- **Quorum per endpoint** : the quorum rule is per Proxmox cluster (no vmid / node).

---

## FAQ / troubleshooting

**The Centreon service stays in `Pending` ?**
Enable the host check (`hostCheckSeconds` > 0) and/or the OK heartbeat (`okHeartbeatSeconds` > 0) : a passive check has no active check to refresh it.

**No alarm is sent ?**
1. Is the module **enabled** (Admin → Centreon) ?
2. Is the **VM → host mapping** filled in ?
3. Is the Centreon service **provisioned + deployed** ("Centreon provisioning" column = OK) ?
4. Is `send_nsca` installed on the Prox4u server ?
5. Is the **NSCA password** correct (`.env` or Page 3) ?

**Is an alert in progress ?**
The rule displays its state (ok / alert) in the table. If a send fails, the "Transmission" status switches to **error** with a message — the rule stays saved, nothing crashes.

**How to test without waiting for a real alert ?**
The **Test** action on a rule : sends a test frame to Centreon.

**A sensor rule (SMART / temperature / systemd / ZFS) does not alert ?**
1. Is the **Telegraf agent** deployed on the node (`60-telegraf-nodes.sh`) ? The **ZFS pool** rule also requires the `zpool` script (deployed with the agent).
2. Does the **target** exactly match the identifier (disk `nvme0n1` without `/dev/`, chip + feature, unit name, pool name) ? An unknown target never triggers (no error, no false positive).
3. For the **sensor temperature**, is the **effective threshold** (Administration → Sensor thresholds) actually below the current temperature ? It takes precedence over the threshold entered in the rule.
