# Deployment on a new server

End-to-end procedure to deploy the application on a dedicated server, **outside the Proxmox infrastructure**, without git (transfer of the `deploiement/` kit — the application travels in its tarball) and without any GUI (accounts and tokens created by commands).

> French version: [DEPLOY.md](./DEPLOY.md)

> **This `deploiement/` folder is the deployment deliverable — it is fully self-contained. Move the whole folder to the target and deploy from it**:
> - `DEPLOY.en.md` — this procedure;
> - `10-proxmox-token.sh` — to run **on each Proxmox server** (§2);
> - `20-package-release.sh` — to run **on the dev machine** to produce the tarball in `releases/` (§3);
> - `releases/prox4u-<date>.tar.gz` — **the application itself** (produced by 20);
> - `30-env-setup.sh`, `40-tls-init.sh`, `50-influxdb-init.sh` — installation **on the app server**, numbered in execution order, taking the install directory as argument (§5);
> - `prox4u.service` — systemd unit of the application server (§8).

```
Target server (app)                Proxmox VE servers × N
┌─────────────────────────┐        ┌──────────────────┐
│ /opt/prox4u    │  API   │ pveum (read-only │
│  app Node.js :8080      │◄──────►│ token)           │
│  InfluxDB Docker :8181  │  8006  └──────────────────┘
│  Explorer Docker :8888  │
└─────────────────────────┘
```

**Network**: outbound TCP **8006** from the app server to each Proxmox (PVE API; 8007 for PBS later) · inbound TCP **8080** from the users' workstations.

---

## 1. Target server prerequisites

| Prerequisite | Version | Installation |
|---|---|---|
| Node.js | ≥ 20 | system package recommended (Nodesource) → `/usr/bin/node` |
| pnpm | ≥ 9 | `npm install -g pnpm` |
| Docker + compose plugin | recent | `docker compose version` must respond |

## 2. Proxmox tokens — per cluster, no GUI

On **each** Proxmox server, as root. The script is idempotent and self-tests the API:

```bash
# from the development machine (the script is in the kit):
scp deploiement/10-proxmox-token.sh root@<pve>:/tmp/
ssh root@<pve> /tmp/10-proxmox-token.sh
```

The script creates, via `pveum` commands (no GUI):

1. the **`ManagerReader`** role — 100% read-only, calibrated on the app's endpoints (`DA.Read` + `*Audit` permissions, **including `VM.GuestAgent.Audit`** for real QEMU VM disk usage — see the box below);
2. the dedicated user **`manager@pve`** (independent from LDAP/AD, revocable on its own);
3. the **API token** `manager` + rights on the whole datacenter;
4. a **self-test** (`GET /cluster/resources` + `/nodes/<n>/status`) confirming the rights are sufficient.

> **Granting the role to an existing monitoring user** (e.g. `supervision@pam`, already in `.env`/`clusters.json`): the granted role **must include `VM.Audit`** (VM listing) **and** `VM.GuestAgent.Audit` (per-partition disk usage). The kit's `ManagerReader` role already has both; to grant it to an existing user:
>
> ```bash
> # grant the role on the whole datacenter (the "/" propagates to /vms, /nodes, …)
> pveum acl modify / --user supervision@pam --roles ManagerReader
> ```
>
> If you use **your own role** (not `ManagerReader`), make sure it carries those two privileges — otherwise the inventory empties or QEMU disk stays blank:
>
> ```bash
> pveum role modify <YourRole> --privs "DA.Read,DA.Audit,VM.Audit,VM.GuestAgent.Audit,Sys.Audit,SDA.Audit,SDI.Audit,SN.Audit"
> pveum acl modify / --user supervision@pam --roles <YourRole>
> ```

The token value is shown **once only** — note the three fields:

```
"user"       : "manager@pve"
"tokenId"    : "manager"
"tokenValue" : "<value>"
```

Optional script variables: `PVE_APP_USER` (default `manager@pve`), `PVE_TOKEN_ID` (default `manager`), `PVE_COMMENT`. Preview mode: `./deploiement/10-proxmox-token.sh --dry-run`.

> ### Real QEMU VM disk usage — guest agent
>
> The Proxmox RRD `disk` only measures **LXC container** disk usage; for **QEMU VMs it is 0** (PVE aggregates QEMU disk usage at the datastore level only, never per VM). The app therefore reads real QEMU disk usage via the **guest agent** (`qemu-guest-agent`):
>
> - **Endpoint**: `GET /nodes/{n}/qemu/{vmid}/agent/get-fsinfo` — returns **one filesystem per partition** (mount point + device + `used-bytes`/`total-bytes`). Only filesystems backed by a VM disk (non-empty `disk` field) are kept. Real network mounts (NFS/CIFS) have no `disk` field → automatically excluded.
> - **Per-partition chart**: the Monitor tab shows **one chart per filesystem** (e.g. `/` on `sda1`, `/NFS` on `sda6`) — used space + fs size (partition allocation), with a legend. Data is stored in the InfluxDB `vm_fs` measurement (one series per mount point) + a total aggregate in `vm_metrics` (`disk_bytes`/`disk_alloc_bytes`).
> - **Required privilege**: `VM.GuestAgent.Audit` **only** (agent read). `VM.GuestAgent.Unrestricted` is **not needed** (that is the privilege to run commands inside the guest, unused here). The kit's `ManagerReader` role already includes it.
> - **Frequency**: the agent is queried **at most every 5 minutes** per VM (throttled in the poller) — disk usage changes slowly, no need to re-query on every 5 s tick.
> - **LXC**: no agent — a single rootfs filesystem, usage from the `disk` (used) / `maxdisk` (allocated) fields of `/cluster/resources`, already real.
> - **If the agent is absent / VM stopped / PVE without the endpoint**: the field is simply omitted (the chart "starts later", like I/O) — no error.
>
> **⚠️ PVE 9.1.1 caveat**: on that build the agent REST endpoints `agent/fs-info` ("not implemented") and `agent/exec` (HTTP 596 "Broken pipe") are **broken** — only **`agent/get-fsinfo`** works. That is why the app uses `get-fsinfo` (not `fs-info`/`exec`). On versions where `agent/exec` works, nothing changes on the app side.
>
> **⚠️ `pveum acl modify` pitfall**: `pveum acl modify <path> --user <u> --role <R>` **REPLACES** the user's role on that path. Running `pveum acl modify /vms --user manager@pve --role <R>` with a `<R>` that does **not** include `VM.Audit` **removes** the VM listing right → `/cluster/resources` returns no VMs → **empty inventory**. To add an agent right without breaking read access: either the role already includes `VM.Audit` (the kit's `ManagerReader` case), or use the additive ACL `pveum acl add <path> --user <u> --role <R>` (which **adds** a path/role without replacing).

## 3. Kit transfer

The `deploiement/` folder is **self-contained** (procedure + scripts + application tarball + systemd unit): move the **whole folder**, nothing else.

```bash
# development machine:
./deploiement/20-package-release.sh    # build + deploiement/releases/prox4u-<date>.tar.gz

# move the whole kit to the target:
scp -r deploiement root@<target>:/tmp/
```

The tarball (in `deploiement/releases/`) contains source + pre-built `dist/`; no secrets are included (`.env`, `clusters.json`, `data/`, `logs/` are excluded — with a built-in guard in the script).

## 4. Application installation

```bash
# target server, from the kit:
cd /tmp/deploiement
sudo useradd -r -s /usr/sbin/nologin proxmox
sudo mkdir -p /opt/prox4u
sudo tar -xzf releases/prox4u-*.tar.gz -C /opt/prox4u
cd /opt/prox4u
pnpm install --prod                  # runtime dependencies only (dist is pre-built)
sudo chown -R proxmox:proxmox /opt/prox4u
```

A single user owns both the app **and** the data: the InfluxDB container will run with the same uid/gid (§5), avoiding any permission conflict on `data/`.

## 5. Local configuration

The scripts are **numbered in execution order** — run them one at a time, **from the kit**, with the install directory as argument:

```bash
cd /tmp/deploiement

# .env: created from the template, INFLUX_UID/GID (uid/gid of the proxmox user)
# and EXPLORER_SESSION_KEY are filled automatically:
./30-env-setup.sh /opt/prox4u proxmox

# self-signed certificates (app + InfluxDB) — add the SAN for remote access:
TLS_SAN_EXTRA="IP:<app-server-ip>" ./40-tls-init.sh /opt/prox4u

# InfluxDB admin token (updates .env automatically):
./50-influxdb-init.sh /opt/prox4u

# data ownership for the non-root container:
sudo chown -R proxmox:proxmox /opt/prox4u/data
```

> The directory argument is optional: from the installed tree (`/opt/prox4u/deploiement/…`), the scripts default to their parent directory.

The only manual check left in `.env`: confirm `TLS_KEY` / `TLS_CERT` / `INFLUX_CA_CERT` / `INFLUX_URL` (pre-filled with the right values).

> The SAN matters: users' browsers reach the app via the server's IP/hostname (not `localhost`) — without a matching SAN, browsers reject the certificate.

**InfluxDB: two databases, created and consolidated automatically** — `raw` (all raw metrics, 31-day retention) and `consolidated` (5-minute consolidated metrics, **infinite** retention, for long-term history). Both are created at app startup; the consolidator runs every 5 minutes (restart-safe via `data/consolidation-state.json`, backfill in one-day chunks after a long outage); reads automatically switch to `consolidated` for long timeframes. Fallback to Proxmox RRD if InfluxDB is unavailable.

### InfluxDB 3 Core — limits and management (target: 500 VMs 24/7)

InfluxDB 3 Core has hard limits (5 databases / 2000 tables / 500 columns — no impact here)
and **time** limits that matter: `--query-file-limit` (default 432 files = 72 h;
1 Parquet file / table / 10-minute block), **no compaction**, **no DELETE**,
**immutable** retention. The app manages these gaps with no new dependency (details:
`docs/plan-limites-influxdb3.md`):

- **Write backpressure**: sized queue (`INFLUX_QUEUE_MAX`, default 20 000) +
  larger batches (`INFLUX_FLUSH_MAX_LINES`, default 1 000) + dead-letter after
  `INFLUX_FLUSH_MAX_RETRIES` (default 3) consecutive failures. Drop counters exposed
  in `/api/health` (`influx` section) + alerts.
- **Chunked long-term queries**: windows > ~69 days are split into chunks of
  `INFLUX_QUERY_CHUNK_DAYS` (default 30 days = 4 320 files < `INFLUX_QUERY_FILE_LIMIT`) —
  the "1 year" sensor/SMART history view works.
- **Self-monitoring**: `GET /api/influxdb` (status, write counters, query stats,
  file headroom) + `influxdb_self` self-telemetry (1 line/tick) + alerts
  `influxdb-down` / `influxdb-write-drops` / `influxdb-file-limit`.
- **Archiving**: an archiver exports `consolidated` beyond `INFLUX_ARCHIVE_AGE_DAYS`
  (default 90 days) to CSV (1 file / table / day) in `INFLUX_ARCHIVE_DIR`
  (default `data/influx-archive/`), every `INFLUX_ARCHIVE_INTERVAL_HOURS` (default 6 h),
  with state resume (`data/archive-state.json`).
- **"InfluxDB" module (vision + action)**: `/influxdb` page (KPIs, 24 h/7 d/30 d graphs,
  databases, archive) + overview widget. **Actions** (flush, archiving, database/table
  recreate/drop — `POST /api/influxdb/actions/*`) are restricted to the admin role
  **or** members of the `INFLUX_ACTION_GROUPS` groups (default
  `Administrateurs,Exploitations`, comma-separated names; empty = admin only). Each action
  is logged in the admin audit (`influxdb.action`). Details: `docs/plan-module-influxdb.md`.

**Retention strategy**:

| Tier | Retention | Mechanism |
|---|---|---|
| `raw` | 31 days | native InfluxDB purge (retention immutable at creation) |
| `consolidated` | ∞ (monitored) | 5/15-min buckets; file headroom tracked via `/api/influxdb` |
| `data/influx-archive/` | beyond 90 days | CSV export queryable outside InfluxDB (DuckDB/Excel) |

> If `consolidated` (∞) growth becomes critical: recreate it with finite retention
> (e.g. 2 years) — "Recreate database" button in the InfluxDB module (restricted to the
> `INFLUX_ACTION_GROUPS` groups) — and rely on the CSV archive for anything older.

## 6. Monitored endpoints

```bash
cd /opt/prox4u
cp clusters.example.json clusters.json    # fill in one block per cluster (§2)
chmod 600 clusters.json
```

- **`sites.json`** (already in the package, template `sites.example.json`): node → building mapping, **required for PRA** (N-1 failover + global cross-endpoint PRA). Each site (building) is bound to an endpoint via the `endpoint` field.

  | Field | Type | Role |
  |---|---|---|
  | `id` | string | Stable site identifier (slug) — used in URLs, the InfluxDB tag and the PRA site id. |
  | `name` | string | Display name (the building). |
  | `endpoint` | string | Id of the bound endpoint (cf. `clusters.json`). **Omitted = default** (the site applies to all endpoints). |
  | `nodes` | string[] | Names of the PVE nodes belonging to this building (as in Proxmox). |

  **Example** (`sites.example.json`):
  ```json
  {
    "sites": [
      { "id": "batiment-a", "name": "Building A — datacenter", "endpoint": "cluster-prod", "nodes": ["pve-node1", "pve-node2"] },
      { "id": "batiment-b", "name": "Building B — annex", "endpoint": "cluster-prod", "nodes": ["pve-node3"] },
      { "id": "site-agence", "name": "Branch site", "endpoint": "cluster-agence", "nodes": ["pve-agence1"] }
    ]
  }
  ```

  **Rules**:
  - **Map every node** to a building: an unmapped node shows up in the UI's "unmapped nodes" box and is **not covered by PRA**.
  - **PRA is only computed when nodes are spread across ≥ 2 sites** (single-node cluster, or all nodes on the same site → `na`).
  - The **global PRA** (cross-endpoint) reuses this same mapping: if a building goes down, the other buildings of **all** endpoints can absorb it (prerequisite: identical storage across sites — disk is excluded from the calculation).
  - After modifying `sites.json` → **restart** the application.

- **`overcommit.json`** (already in the package): overcommit thresholds + usage color code; sane defaults provided, hot-reloadable (no restart).

- **`health.json`** (already in the package, template `health.example.json`): **Health Score + PRA thresholds and penalties**; sane defaults provided, **hot-reloadable (no restart)**. Optional file — absent → built-in defaults.

  | Block | Fields | Role |
  |---|---|---|
  | `thresholds` | `warn`, `crit` | Cluster CPU/RAM usage: ≥ `warn` → warn penalty, > `crit` → crit penalty (%). |
  | | `praWarn`, `praCrit` | PRA absorption: ≥ `praWarn` → warn, > `praCrit` → crit (%). |
  | | `healthNominal`, `healthDegraded` | Score label: ≥ nominal → Nominal, ≥ degraded → Degraded, else Critical. |
  | `penalties` | `nodeDown`, `quorumLost`, `qdeviceDown`, `cpuCrit`/`cpuWarn`, `ramCrit`/`ramWarn`, `diskCrit`/`diskWarn`, `praCrit`/`praWarn` | Points removed from 100 for each penalty reason. |

  **Rules**: `crit ≥ warn`, `praCrit ≥ praWarn`, `healthNominal ≥ healthDegraded` (validated on load). After modification → **applied on the next tick, no restart**.

- **`audit.json`** (already in the package, template `audit.example.json`): **configuration score checks** (Audit / best-practices module); sane defaults provided, **hot-reloadable (no restart)**. Optional file — absent → built-in defaults.

  | Block | Fields | Role |
  |---|---|---|
  | `penalties` | `crit`, `warn`, `info` | Points removed from 100 per finding of each severity. |
  | `labelNominal`, `labelDegraded` | — | Score label: ≥ nominal → Compliant, ≥ degraded → To improve, else To review. |
  | `checks` | one block per check (`enabled` + thresholds) | Enable/disable each check + tune its thresholds (e.g. `stuck_snapshots.maxAgeDays`, `disk_service_life.warnPct`/`critPct`, `zfs_arc_max.maxPctOfRam`). |

  **Rules**: each check can be disabled (`"enabled": false`); thresholds only apply when the check is enabled. After modification → **applied on the next tick, no restart**. The full check catalog (why / how / thresholds) is in the `audit` skill.

## 7. Start + verification

```bash
cd /opt/prox4u
./up.sh                                # InfluxDB (Docker) + Explorer + application
curl -k https://localhost:8080/api/health
docker compose ps                      # influxdb → "healthy"
tail -n 50 logs/server.log
```

Expected checks:

- `/api/health` → `200`;
- `docker compose ps` → InfluxDB container **healthy**;
- `logs/server.log` → line `InfluxDB prêt : bases raw (31 j) + consolidated (∞)` (or "RRD fallback" if InfluxDB is disabled);
- browser on `https://<server-ip>:8080` (self-signed certificate: accept the exception) → **LIVE** badge, endpoints listed in the sidebar, Health Score computed;
- `logs/server.log`: one tick per endpoint with no PVE authentication error.

> The InfluxDB API port 8181 is bound to **localhost + `INFLUX_LAN_BIND`** (the app connects locally via 127.0.0.1). `INFLUX_LAN_BIND` is auto-filled by `30-env-setup.sh` with the server's IP: it exposes the API on the internal network **for the Proxmox nodes' Telegraf agents only** (local metrics writes: SMART, temperatures, ZFS…). Set `INFLUX_LAN_BIND=` empty to go back to localhost-only. Explorer (8888) stays reachable.

## 8. Boot persistence

```bash
cd /opt/prox4u

# stop the manual instance (port 8080 will be taken by systemd):
./server.sh stop

# the unit is in the kit (installed copy in the tree, durable after reboot):
sudo cp deploiement/prox4u.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now prox4u
systemctl status prox4u
```

InfluxDB and Explorer are Docker containers with `restart: unless-stopped` → they start with the Docker service at boot. The systemd unit restarts the app on crash (`Restart=always`) and at boot.

## 9. Day-2 operations

| Operation | Commands |
|---|---|
| **Update** | `./deploiement/20-package-release.sh` (dev) → `scp deploiement/releases/prox4u-*.tar.gz target:/tmp/` → `sudo tar -xzf /tmp/prox4u-*.tar.gz -C /opt/prox4u` → `pnpm install --prod` → `sudo chown -R proxmox:proxmox /opt/prox4u` → `sudo systemctl restart prox4u` |
| **PVE token rotation** | on the PVE: `pveum user token del manager@pve manager && pveum user token add manager@pve manager --privsep 0` → update `clusters.json` → `sudo systemctl restart prox4u` |
| **Remove an endpoint** | remove the block from `clusters.json` (+ its site in `sites.json`) → restart |
| **Logs** | `logs/server.log` (app) · `docker compose logs influxdb` |
| **Backup** | all state is in `data/` (InfluxDB, consolidator state, **CSV archive `data/influx-archive/`**, TLS certificates, admin token) — copy `data/` + `.env` + `clusters.json` + `sites.json` |

> **PBS (phase 1B)**: the Proxmox Backup Server token will be created the same way by commands (`pbs config add-user` + token via API) — procedure to be completed when PBS is deployed.

## 10. Node agent (Telegraf)

Optional but recommended: the PVE API does not expose **local metrics** (disk SMART,
temperatures, ZFS ARC, systemd units, host I/O, per-NIC network, cluster quorum detail,
pending reboot, pending security updates). The **Telegraf** agent collects them on each PVE
node and pushes them to InfluxDB (`raw` database).

> Without the agent, the application runs in **degraded mode**: no SMART/temperatures, no
> per-disk I/O or per-VM-interface traffic, and the 5 agent-based audit checks
> (`disk_errors`, `disk_service_life`, `failed_units`, `pending_reboot`, `security_updates`)
> stay silent.

### 10.1 Running it

On **each PVE node** (bare-metal — not inside a VM/CT), as **root**, with the kit script:

```bash
export TELEGRAF_INFLUX_TOKEN="<InfluxDB admin token>"   # = INFLUX_TOKEN from the app .env
bash 60-telegraf-nodes.sh            # or --dry-run to preview (nothing is executed)
```

The script is **idempotent and re-runnable** (redeployment): the existing `telegraf.conf` is
backed up (`.bak.<ts>`), the exec scripts are overwritten, Telegraf is (re)started. If Telegraf
is already installed, it does **not** re-download the InfluxData GPG key nor re-run `apt`
(the LAN→internet network can be flaky).

### 10.2 Environment variables

| Variable | Required | Default | Note |
|---|---|---|---|
| `TELEGRAF_INFLUX_TOKEN` | **yes** | — | InfluxDB API token (= `INFLUX_TOKEN` from the app `.env`). **Different in prod** → pass the prod token |
| `INFLUX_URL` | no | `https://192.168.1.180:8181` | InfluxDB address — **must be passed in prod** if different (default = lab) |
| `INFLUX_BUCKET` | no | `raw` | target database |
| `INFLUX_ORG` | no | `influxdb` | organization (`influxdb_v2` plugin) |
| `PING_TARGET` | no | = host:port of `INFLUX_URL` | ping target (plugin currently disabled — no `CAP_NET_RAW`) |
| `NODE_TAG` | no | `hostname` | `node` tag written to InfluxDB — **must match the node name in PVE** (otherwise the app does not consume the data) |

> The InfluxData GPG key (fingerprint `24C9…F927`) is the vendor's **official signing key** —
> identical in every environment, and no longer downloaded on redeployment.

### 10.3 Verification

The script **self-tests** at the end of the run (service active + InfluxDB write confirmed).
Then, from the prox4u server, confirm the tables are populated:

```bash
cd prox4u && TOK=$(grep '^INFLUX_TOKEN=' .env | cut -d= -f2)
curl -sk https://localhost:8181/api/v3/query_sql -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d '{"db":"raw","q":"SELECT table_name FROM information_schema.tables WHERE table_name IN ('\''smart_device'\'','\''sensors'\'','\''zfs'\'','\''systemd_units'\'','\''disk'\'','\''diskio'\'','\''cpu'\'','\''mem'\'','\''system'\'','\''dm_names'\'','\''net'\'','\''net_if_mac'\'','\''node_hardware'\'','\''quorum_detail'\'','\''reboot_pending'\'','\''security_updates'\'')"}'
```

**16 tables** expected (10 native plugins + 6 exec scripts). The agent-based audit checks
activate on the next poller tick (5-min caches). Troubleshooting on the node:
`journalctl -u telegraf -n 30 --no-pager`.

## 11. Centreon — account, API token & NSCA (« Alarmes & Centreon » module)

Optional: the « Alarmes & Centreon » module (`centreon-nsca` family) provisions passive
services on a **Centreon central** (versions **22 → 26**) and sends NSCA frames to it. The kit
script prepares the central, **idempotently**:

1. permission group `groupeprox4u` (CLAPI `ACLGROUP`);
2. account `prox4u` (CLAPI `CONTACT`, `contact_admin=1` → **global admin**: full API/CLAPI
   rights, robust across 22→26) + membership in the group;
3. **API token** generated + inserted in the DB (`security_token` +
   `security_authentication_tokens`, 21.10+ schema; fallback `token` table ≤ 20.x) — shown
   **once only**;
4. **NSCA password** generated + written to `nsca.cfg` on the chosen poller(s) (best-effort —
   the `nsca` daemon is a centreon-engine add-on, install it if missing).

### 11.1 Procedure (admin, on the central)

The script is **self-contained** (a single file, ~420 lines) — dependencies `curl`, `python3`,
`openssl`, `mysql`, all present by default on a Centreon central. It must run **as root on the
central** (DB access is required for the token).

**Step 1 — Copy the script to the central.** From the dev machine (or the Prox4u server, where
the kit lives in `deploiement/`):

```bash
scp deploiement/70-centreon-setup.sh root@<central-ip>:/root/
```

**Step 2 — Preview (nothing is executed, no prompts).** On the central, as root:

```bash
bash /root/70-centreon-setup.sh --dry-run
```

**Step 3 — Real run (interactive).** The admin enters, as prompted:

```bash
bash /root/70-centreon-setup.sh
```

1. **Centreon admin login** (default `admin`) + **password** (masked entry);
2. **`prox4u` account password** (entry + confirmation);
3. **Poller(s) selection** for the NSCA password (list from the DB + selection).

The script creates the group + account + token + NSCA password, then **self-verifies** (token
accepted by the new API `/api/latest/` via the `X-AUTH-TOKEN` header + NSCA listener over TCP)
and prints a **summary** at the end.

**Step 4 — Enter the summary into Prox4u.** Copy the summary config into **Admin → Centreon
(NSCA)** (see §11.3). The token and the NSCA password appear **once only** (§11.3).

**Step 5 — Check the NSCA daemon** (best-effort): the script writes `nsca.cfg` and TCP-tests
the listener, but installing/starting the `nsca` daemon (centreon-engine add-on) on the poller
is the admin's job (on-screen warnings).

**Re-run / maintenance** (idempotent — re-runnable with no side effects):

| Flag | Effect |
|---|---|
| *(none)* | recreates what is missing, reuses existing token/NSCA password |
| `--dry-run` | preview, nothing is executed |
| `--rotate-token` | new API token (the old one is revoked) |
| `--rotate-nsca` | new NSCA password (rewrites `nsca.cfg`) |
| `--remove` | cleans up group/account/token (services created by the module are **kept**) |

### 11.2 Environment variables

| Variable | Default | Note |
|---|---|---|
| `CENTRON_URL` | `http://localhost/centreon` | central base URL (the script runs on the central) |
| `GROUP_NAME` | `groupeprox4u` | permission group name |
| `USER_LOGIN` | `prox4u` | account login |
| `USER_EMAIL` | `prox4u@localhost` | account email |
| `NSCA_PORT` | `5668` | NSCA listener port |
| `NSCA_CFG_PATH` | `/etc/centreon/nsca.cfg` | `nsca.cfg` path on the poller |
| `NSCA_CHECK_COMMAND` | `/usr/bin/centengine -c /etc/centengine/centengine.cfg --external-command` | check submission to centengine — **verify** per environment |

### 11.3 Prox4u config (Page 3)

After the run, enter the printed summary into Prox4u (Admin → Centreon (NSCA)): **Transport**
REST (URL = `CENTRON_URL`, user = `prox4u`, token = printed) + **NSCA** (server = poller IP,
port, password = printed).

> ⚠ The token and the NSCA password are shown **once only** (and stored in the DB). If lost,
> re-run with `--rotate-token` / `--rotate-nsca`.
>
> ⚠ **NSCA**: the `nsca` daemon (centreon-engine add-on) must be installed + running on the
> poller. The script writes `nsca.cfg` and TCP-tests the listener, but installing the daemon is
> the admin's job (best-effort, on-screen warnings).
