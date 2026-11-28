import type { FastifyInstance, FastifyReply } from 'fastify';
import type { MetricsTimeframe, VmDiskioPoint, VmDiskioResponse, VmDiskioSeries } from '@prox4u/shared';
import { mapperLabel, parsePveMapperName } from '@prox4u/shared';
import { influxTsToUnix } from '../../core/influx.js';
import { fanOutQuery } from '../../core/influx-shards.js';
import type { AppContext, EndpointRuntime } from '../../core/poller.js';
import { DISKIO_CACHE_TTL_MS, HOST_DISKIO_TF, diskioRateSql, normRate, sqlStr, type InfluxRow } from '../nodesensors/system-routes.js';

/**
 * GET /api/vm-diskio?endpoint=&vmid=&timeframe= — I/O disque PAR DISQUE d'une
 * VM, depuis le nœud hôte (Telegraf diskio) — l'agrégat Proxmox (vm_metrics)
 * ne distingue pas les disques de la VM ni IOPS/saturation.
 *
 * Principe : les disques PVE (LVM-thin) sont des LV device-mapper, vus côté
 * hôte comme `dm-N` sans nom. Le mapping dm-N → LV (`vg--vm--<vmid>--disk--<n>`)
 * est écrit par l'agent Telegraf (plugin exec → table `dm_names`, script
 * /usr/local/lib/prox4u-telegraf-dm-names.sh, deploiement/60-telegraf-nodes.sh)
 * — l'API PVE ne l'expose pas.
 *
 * Dégradations attendues (vrai matériel) :
 *  - `noMapping` : table `dm_names` absente (agent pas encore (re)déployé) ;
 *  - `insufficientData` : mapping présent mais aucun LV dm pour cette VM
 *    (stockage ZFS/dir — pas de device-mapper par VM, ou VM sans volume).
 */

/** Résolution d'endpoint — même contrat que routes.ts (copie locale : éviter l'import circulaire). */
function resolveEndpoint(ctx: AppContext, id: string | undefined, reply: FastifyReply): EndpointRuntime | null {
  const wanted = id ?? ctx.config.defaultEndpointId;
  const ep = ctx.endpoints.find((e) => e.id === wanted);
  if (!ep) {
    reply.code(404).send({ error: `unknown endpoint: ${wanted}` });
    return null;
  }
  return ep;
}

function influxReady(ctx: AppContext): boolean {
  return !!ctx.influx && ctx.influx.enabled;
}

/**
 * Dernier point par (node, dm) — le script exec réécrit la table toutes les 10 s,
 * une fenêtre de 1 h suffit et écarte les dm-N supprimés (LV effacés) plus
 * tôt que ça.
 */
export function latestDmMapping(rows: InfluxRow[]): Map<string, { node: string; dm: string; mapper: string }> {
  const out = new Map<string, { node: string; dm: string; mapper: string }>();
  for (const r of rows) {
    const dm = String(r.dm ?? '');
    const mapper = String(r.mapper_name ?? '');
    if (!dm || !mapper) continue;
    const node = String(r.node ?? '');
    const k = `${node}/${dm}`;
    if (!out.has(k)) out.set(k, { node, dm, mapper }); // lignes triées time DESC
  }
  return out;
}

export function registerVmDiskioRoute(app: FastifyInstance, ctx: AppContext): void {
  const cache = new Map<string, { at: number; value: VmDiskioResponse }>();

  app.get('/api/vm-diskio', async (req, reply) => {
    const q = req.query as { endpoint?: string; vmid?: string; timeframe?: string };
    const ep = resolveEndpoint(ctx, q.endpoint, reply);
    if (!ep) return;

    const vmid = Number(q.vmid);
    if (!Number.isInteger(vmid) || vmid <= 0) {
      reply.code(400).send({ error: 'vmid (entier positif) requis' });
      return;
    }
    const tf = q.timeframe as MetricsTimeframe;
    if (!HOST_DISKIO_TF[tf]) {
      reply.code(400).send({ error: `timeframe must be one of ${Object.keys(HOST_DISKIO_TF).join(', ')}` });
      return;
    }

    const key = `${ep.id}/${vmid}/${tf}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < DISKIO_CACHE_TTL_MS) {
      reply.send(cached.value);
      return;
    }

    const none = (source: VmDiskioResponse['source']): VmDiskioResponse => ({
      timeframe: tf,
      vmid,
      series: [],
      source,
    });

    let body: VmDiskioResponse = none('insufficientData');
    if (influxReady(ctx)) {
      try {
        // 1) mapping dm-N → LV (fenêtre 1 h, dernier point par (node, dm))
        const mapRows = await fanOutQuery<InfluxRow>(ctx, 'raw',
          `SELECT node, dm, mapper_name FROM dm_names WHERE time >= now() - INTERVAL '1 hour' ORDER BY time DESC`,
        );
        const dmLatest = latestDmMapping(mapRows);
        if (dmLatest.size === 0) {
          body = none('noMapping');
        } else {
          // 2) disques de la VM (QEMU : LV `vm-<vmid>-disk-<n>` ; les CT `base-<ctid>-`
          //    ne sont pas demandés ici — vue VM = QEMU)
          const devices = [...dmLatest.values()].filter((d) => {
            const p = parsePveMapperName(d.mapper);
            return p.kind === 'vm' && p.id === vmid;
          });
          if (devices.length === 0) {
            body = none('insufficientData');
          } else {
            const { bucket, bucketSec, window } = HOST_DISKIO_TF[tf];
            const series: VmDiskioSeries[] = [];
            // Groupement par nœud : une VM = un nœud courant, mais une migration
            // passée peut laisser de l'historique sur l'ancien nœud.
            const byNode = new Map<string, typeof devices>();
            for (const d of devices) {
              const list = byNode.get(d.node) ?? [];
              list.push(d);
              byNode.set(d.node, list);
            }
            for (const [node, devs] of byNode) {
              const names = devs.map((d) => sqlStr(d.dm));
              const rows = await fanOutQuery<InfluxRow>(ctx, 'raw',
                diskioRateSql(`node = ${sqlStr(node)} AND name IN (${names.join(',')})`, bucket, bucketSec, window),
              );
              const byDev = new Map<string, VmDiskioPoint[]>();
              for (const r of rows) {
                const dev = String(r.name ?? '');
                const t = influxTsToUnix(r.t as string | number | null);
                if (t <= 0) continue;
                const list = byDev.get(dev) ?? [];
                list.push({
                  t,
                  readBps: normRate(r.read_bps),
                  writeBps: normRate(r.write_bps),
                  iops: normRate(r.iops),
                  busyPct: normRate(r.busy_pct),
                  awaitMs: normRate(r.await_ms),
                });
                byDev.set(dev, list);
              }
              const ordered = [...devs].sort((a, b) => a.dm.localeCompare(b.dm, undefined, { numeric: true }));
              for (const d of ordered) {
                const points = (byDev.get(d.dm) ?? []).sort((a, b) => a.t - b.t);
                series.push({ node: d.node, device: d.dm, mapperName: d.mapper, label: mapperLabel(d.mapper), points });
              }
            }
            series.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
            body = { timeframe: tf, vmid, series, source: 'influx' };
          }
        }
      } catch (err) {
        const msg = (err as Error).message ?? '';
        // Table dm_names absente = agent pas encore (re)déployé → état lisible, pas une erreur.
        // Message InfluxDB 3 Core réel : "Error during planning: table 'public.iox.dm_names' not found".
        if (/cannot find table|not found|does not exist/i.test(msg)) {
          body = none('noMapping');
        } else {
          ctx.logger.warn(`vm-diskio(${key}) : InfluxDB indisponible (${msg})`);
          body = none('insufficientData');
        }
      }
    }

    cache.set(key, { at: Date.now(), value: body });
    reply.send(body);
  });
}
