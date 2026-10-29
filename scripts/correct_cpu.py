#!/usr/bin/env python3
"""Corriger le cpu_pct historique (déflété ÷cpus) de node_metrics.

Usage: python3 correct_cpu.py <db.csv> <outfile.lp> <boundary_iso_utc>
- Lit le CSV node_metrics exporté (colonnes : cluster,cpu_pct,disk_pct,net_in_bps,net_out_bps,node,ram_pct,time).
- Pour node='proxmox' et time < boundary : cpu_pct *= 24 (inverse du ÷24 du bug).
- Écrit la line protocol corrigée dans outfile.lp.
"""
import csv, sys, datetime

def to_ns(t):
    dt = datetime.datetime.fromisoformat(t)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return int(dt.timestamp() * 1_000_000_000)

def esc(s):
    return str(s).replace("\\", "\\\\").replace(",", "\\,").replace(" ", "\\ ")

def main():
    csv_path, out, boundary_iso = sys.argv[1], sys.argv[2], sys.argv[3]
    boundary_ns = to_ns(boundary_iso)
    FACTOR = 24
    lines, corrected, skipped = [], 0, 0
    with open(csv_path, newline="") as f:
        for r in csv.DictReader(f):
            node = r["node"]
            t_ns = to_ns(r["time"])
            def fnum(k):
                v = r.get(k, "").strip()
                return float(v) if v != "" else None
            cpu = fnum("cpu_pct")
            if node == "proxmox" and t_ns < boundary_ns and cpu is not None:
                cpu = round(cpu * FACTOR, 4)
                corrected += 1
            fields = []
            if cpu is not None:
                fields.append(f"cpu_pct={cpu}")
            for k in ("disk_pct", "net_in_bps", "net_out_bps", "ram_pct"):
                v = fnum(k)
                if v is not None:
                    fields.append(f"{k}={v}")
            if not fields:
                skipped += 1
                continue
            tags = []
            cl = (r.get("cluster") or "").strip()
            if cl:
                tags.append(f"cluster={esc(cl)}")
            tags.append(f"node={esc(node)}")
            lines.append(f"node_metrics,{','.join(tags)} {','.join(fields)} {t_ns}")
    with open(out, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"lignes écrites: {len(lines)} | cpu_pct corrigés (×{FACTOR}): {corrected} | sans champ (ignorés): {skipped}")

if __name__ == "__main__":
    main()
