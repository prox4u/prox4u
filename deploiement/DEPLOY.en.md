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

## 6. Monitored endpoints

```bash
cd /opt/prox4u
cp clusters.example.json clusters.json    # fill in one block per cluster (§2)
chmod 600 clusters.json
```

- **`sites.json`** (already in the package): adapt the node → building mapping to the real topology — required for PRA.
- **`overcommit.json`** (already in the package): overcommit thresholds + usage color code; sane defaults provided, hot-reloadable (no restart).

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
| **Backup** | all state is in `data/` (InfluxDB, consolidator state, TLS certificates, admin token) — copy `data/` + `.env` + `clusters.json` + `sites.json` |

> **PBS (phase 1B)**: the Proxmox Backup Server token will be created the same way by commands (`pbs config add-user` + token via API) — procedure to be completed when PBS is deployed.
