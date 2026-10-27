#!/bin/bash
# Sonde réseau Proxmox (dev topologie 1B) — LECTURE SEULE, aucune modification.
# Affiche par endpoint : NICs/ponts/IPs de chaque nœud + interfaces VM (bridge=).
# Credentials lus depuis clusters.json (rien en dur) ; curl -sk (cert auto-signé).
set -euo pipefail
cd "$(dirname "$0")"

[ -f clusters.json ] || { echo "clusters.json introuvable dans $(pwd)"; exit 1; }

python3 - <<'EOF'
import json, subprocess

cfg = json.load(open('clusters.json'))
eps = cfg['endpoints'] if isinstance(cfg, dict) else cfg
for ep in eps:
    auth = f"PVEAPIToken={ep['user']}!{ep['tokenId']}={ep['tokenValue']}"
    url = ep['url'].rstrip('/')
    print(f"===== {ep['id']} ({url}) =====")

    def get(path):
        r = subprocess.run(['curl', '-sk', '-H', f'Authorization: {auth}', f'{url}/api2/json{path}'],
                           capture_output=True, text=True)
        try:
            return json.loads(r.stdout).get('data') or []
        except Exception:
            print(f"  ! erreur sur {path}: {r.stdout[:150]}")
            return []

    nodes = [n['name'] for n in get('/cluster/status') if n.get('type') == 'node']
    print(f"nœuds : {' '.join(nodes) or '(aucun)'}")
    for n in nodes:
        print(f"--- /nodes/{n}/network ---")
        for e in get(f'/nodes/{n}/network'):
            t = e.get('type')
            ip = e.get('cidr') or (e.get('ip') and f"{e['ip']}/{e.get('netmask')}")
            if t == 'bridge':
                print(f"  BRIDGE {str(e.get('iface','?')):12} ports={str(e.get('bridge_ports')):14} ip={ip} gw={e.get('gw') or e.get('gateway')} comment={e.get('comment','')!r}")
            elif t in ('eth', 'physical', 'vlan', 'linux-bridge'):
                print(f"  NIC    {str(e.get('iface','?')):12} type={str(t):12} ip={ip} up={e.get('up')} speed={e.get('speed')} comment={e.get('comment','')!r}")

    print("--- configs VM (net*/mp*) ---")
    for v in get('/cluster/resources?type=vm'):
        if v.get('template'):
            continue
        kind = 'lxc' if v['type'] == 'lxc' else 'qemu'
        cfg = get(f"/nodes/{v['node']}/{kind}/{v['vmid']}/config")
        nets = {k: val for k, val in cfg.items() if k.startswith(('net', 'mp')) and isinstance(val, str)}
        if nets:
            print(f"  VM {v['vmid']} {str(v.get('name','?')):15} ({v['node']}) : " + ' | '.join(f"{k}={val}" for k, val in sorted(nets.items())))
    print()
EOF
