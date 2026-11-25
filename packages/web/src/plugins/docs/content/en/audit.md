# Audit / best-practices

Computes a **2nd configuration score** (complementing the health score, which measures **resources**): it detects **deviations from Proxmox best practices** on already-polled data, and each finding is **clickable** to its target.

- **Who uses it**: the **IT department / admin** who wants a configuration assessment, and the **NOC** who acts on the findings.
- **What it does**: Prox4u runs **17 best-practice checks** (VMs, network, storage, system) on each endpoint, computes a **deterministic score** from 0 to 100, and displays the findings grouped by severity — live, with no API call when the page loads.

---

## How to use it

### 1. Enable the module (admin)

1. The module is **enabled by default**; it only needs to be **authorized** (enabled globally or assigned to your group) **and selected** in your user profile.
2. If the module does not appear in the menu, check your profile: an unselected module redirects to **My profile**.

### 2. Read the score and the findings

1. Open **Audit / best-practices** in the menu (route `/audit`).
2. In multi-endpoint mode, choose the **endpoint** to audit.
3. Read the **score card**:
   - the **big number** (0–100) and the **badge**: **≥ 80 Compliant**, **50–79 To improve**, **< 50 To review**;
   - the **counters** of findings by severity (critical / warning / info);
   - the number of **checks passed** (e.g. "15/17 checks passed").
4. Browse the **Findings** section, grouped by severity (hidden if empty): each row shows the severity badge, the message, and a **clickable button** that takes you directly to the target — the **VM** (VM view page), the **node** (node page), the **storage** (Storage page) or the **cluster** (endpoint page).
5. Expand the **Check catalog** at the bottom of the page: for each check, it explains **why** (the risk), **how** (the detection logic) and the **threshold** applied.

![Audit page — configuration score, findings by severity and check catalog](/screenshots/audit.png)

### 3. Track the score without opening the page

- **Overview**: the endpoints table has an **"Audit" column** with the colored score (green ≥ 80, orange 50–79, red < 50).
- **Endpoint detail**: the **"Configuration score"** widget (gauge + list of findings) is available in the widget library of the endpoint page.

### 4. Adjust the thresholds (optional, admin)

1. Copy the `audit.example.json` template (server root) to `audit.json`.
2. Modify the **thresholds** or **disable** a check (`"enabled": false`).
3. **No restart**: the file is reloaded automatically on the next tick (≤ 5 s). An invalid file is ignored (the previous config is kept).

---

## What happens in the background

The **poller** computes the audit **on every tick (5 s)** on already-polled data, then pushes it into the **WebSocket snapshot**: the page, the overview column and the endpoint widget read it **live, zero API**.

| Data | Refresh | Detail |
|---|---|---|
| Audit computation (17 checks) | every tick (5 s) | score + findings set in the snapshot |
| VM configuration (autostart, host CPU, privileged container) | 1 h | Proxmox API |
| Oldest snapshot age (per VM) | 1 h | 1 API call/VM/h, in the background |
| Replication jobs, bridges and bonds | 5 min | Proxmox API |
| ZFS ARC, SMART disks, systemd units, pending reboot, security updates | 5 min | InfluxDB database, fed by the nodes' **Telegraf agent** |

- **Deterministic score**: `100 − Σ penalties`, bounded [0, 100] — penalty **critical −10**, **warning −5**, **info −1**.
- **No false positives**: if a data point is missing (Telegraf agent not deployed, no snapshot, no bond…), the corresponding check stays **silent** instead of alerting wrongly.
- The system checks (disks, systemd units, reboot, updates) **require the Telegraf agent** deployed on the nodes (`deploiement/60-telegraf-nodes.sh`).

---

## Configuration (summary)

| Parameter | Where | Default |
|---|---|---|
| Check enabled / disabled (per check) | `audit.json` → `checks.<id>.enabled` | enabled |
| Penalties by severity | `audit.json` → `penalties` | crit −10 · warn −5 · info −1 |
| Score labels | `audit.json` → `labelNominal` / `labelDegraded` | ≥ 80 Compliant · 50–79 To improve · < 50 To review |
| Max snapshot age (`stuck_snapshots`) | `audit.json` → `maxAgeDays` | 7 d |
| Max replication staleness (`replication_state`) | `audit.json` → `maxStalenessHours` | 24 h |
| Min. bond members (`bond_members`) | `audit.json` → `minMembers` | 2 |
| ZFS ARC max as % of RAM (`zfs_arc_max`) | `audit.json` → `maxPctOfRam` | 75 % |
| NVMe wear (`disk_service_life`) | `audit.json` → `warnPct` / `critPct` | 80 % / 90 % |
| Number of security patches (`security_updates`) | `audit.json` → `warnCount` | 5 |

> Missing file or missing key → **built-in default**: the server runs without `audit.json`.

---

## Known limitations

- **Read-only**: the audit emits findings, it fixes nothing — each finding is a **starting point** (clickable target) for the admin.
- **Telegraf agent required** for the 5 system checks (SMART disks, NVMe wear, systemd units, pending reboot, security updates): without the agent, they are silent (no false positive, but no control either).
- **A bridge without a physical port is flagged (warning)** even if it is intentional (e.g. NFS bridge): it is a finding to review, not an error.
- **Data freshness**: VM configuration and snapshot age are refreshed every 1 h — a very recent change can take up to 1 h to appear in the audit.
- **Module visibility**: a module must be both authorized (group) and selected in the user profile, otherwise the `/audit` route redirects to **My profile**.

---

## FAQ / troubleshooting

**The module does not appear in the menu / the page redirects to My profile?**
The module must be **authorized** (enabled globally or assigned to your group) **and selected** in your user profile. Both conditions are required.

**Why is my score 100 when I see "weird" things?**
The score only penalizes the 17 implemented checks, with the thresholds in effect. A state not covered by a check (or below the threshold) costs no points. The **Check catalog** lists exactly what is checked.

**Why do some checks produce no finding?**
Either everything is compliant, or the **data is missing** (Telegraf agent not deployed, no replication job, no bond, no snapshot…): the check stays **silent** rather than alerting wrongly.

**I modified `audit.json`, nothing changes?**
1. Is the file at the **server root** (or working directory)?
2. Check the log: `grep "modifié : configuration rechargée" logs/server.log`.
3. An **invalid** file (bad JSON syntax) is **ignored**: the previous config is kept — fix the syntax.

**A check bothers me, how do I disable it?**
In `audit.json`, set `"enabled": false` on the check in question: it is excluded from the score and from the number of checks run, without a restart.

**What is the difference with the health score?**
The **health score** measures **resource health** (CPU, RAM, disk, nodes online, quorum). The **audit** measures **configuration quality** (best practices). The two are complementary: a cluster can have a perfect health score but an audit to review (e.g. privileged containers, VMs without agent).
