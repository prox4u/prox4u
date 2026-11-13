import type { FastifyInstance, FastifyReply } from 'fastify';
import type { MetricsTimeframe, VmNetPoint, VmNetResponse, VmNetSeries } from '@prox4u/shared';
import { influxTsToUnix } from '../../core/influx.js';
import type { AppContext, EndpointRuntime, Poller } from '../../core/poller.js';
import {
  DISKIO_CACHE_TTL_MS,
  HOST_DISKIO_TF,
  netRateSql,
  normRate,
  sqlStr,
  type InfluxRow,
} from '../nodesensors/system-routes.js';

/**
 * GET /api/vm-net?endpoint=&vmid=&timeframe= — trafic réseau PAR INTERFACE
 * d'une VM, mesuré côté nœud hôte (Telegraf `net`, counters
 * bytes_recv/bytes_sent → débits).
 *
 * Principe : PVE (9.1/9.2) n'expose pas le trafic par interface d'une VM
 * (/cluster/resources et rrddata = agrégat par VM ; QGA network-get-interfaces
 * non implémenté et ne renvoie pas de compteurs de trafic de toute façon).
 * Chaque carte de VM est en revanche un device tap côté hôte (vnet* / tap* /
 * veth*) dont le MAC est celui de l'interface VM (config PVE net0/net1,
 * getVmConfig, cache 1 h). L'agent Telegraf écrit :
 *  - la table `net` (counters par interface, plugin net, 10 s) ;
 *  - la table `net_if_mac` (interface hôte → MAC, script exec, fenêtre 1 h).
 * Le joint carte VM ↔ tap se fait par MAC (minuscules) — robuste bridge /
 * SDN / OVS / LXC, sans dépendre du nommage des devices PVE.
 *
 * Dégradations :
 *  - `noMapping` : tables `net` / `net_if_mac` absentes (agent à (re)déployer) ;
 *  - `insufficientData` : VM absente du snapshot (poller en démarrage) ou
 *    config réseau non lue (aucune interface) ;
 *  - MAC non trouvée côté hôte (VM arrêtée → pas de tap ; SDN/OVS → MAC
 *    hôte différente) : série listée avec `hostIface=null` et points vides —
 *    jamais de valeur inventée.
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
 * Lignes `net_if_mac` (triées time DESC) → mapping MAC (minuscules) →
 * interface hôte. Le dernier point par interface gagne (script réécrit la
 * table toutes les 10 s) ; si un même MAC apparaît sur plusieurs devices
 * (paire veth), le premier rencontré (le plus récent) est conservé — les
 * deux extrémités d'une paire veth comptent le même trafic.
 */
export function latestIfMacMapping(rows: InfluxRow[]): Map<string, string> {
  const ifaceMac = new Map<string, string>();
  for (const r of rows) {
    const iface = String(r.iface ?? '');
    const mac = String(r.mac ?? '').toLowerCase();
    if (!iface || !mac) continue;
    if (!ifaceMac.has(iface)) ifaceMac.set(iface, mac);
  }
  const macIface = new Map<string, string>();
  for (const [iface, mac] of ifaceMac) {
    if (!macIface.has(mac)) macIface.set(mac, iface);
  }
  return macIface;
}

/** Libellé UI d'une carte : `net0 (vmbr0)`. */
export function vmNetLabel(iface: string, bridge: string): string {
  return bridge ? `${iface} (${bridge})` : iface;
}

/** Tri numérique des interfaces (net0 < net1 < net10). */
function sortNets(nets: VmNetSeries[]): VmNetSeries[] {
  return nets.sort((a, b) => a.iface.localeCompare(b.iface, undefined, { numeric: true }));
}

export function registerVmNetRoute(app: FastifyInstance, ctx: AppContext, poller: Poller): void {
  const cache = new Map<string, { at: number; value: VmNetResponse }>();

  app.get('/api/vm-net', async (req, reply) => {
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

    const body = await buildVmNet(ep, vmid, tf, ctx, poller);
    cache.set(key, { at: Date.now(), value: body });
    reply.send(body);
  });
}

/**
 * Construction de la réponse (hors cache) :
 *  1) snapshot poller → nœud + type de la VM (getVmConfig a besoin des deux) ;
 *  2) config PVE → cartes réseau (net0/net1, bridge, MAC) — cache 1 h ;
 *  3) `net_if_mac` (fenêtre 1 h) → MAC → tap hôte ;
 *  4) `net` (counters → débits) pour les tap résolus.
 * Une table absente (erreur SQL « not found ») = `noMapping`.
 */
async function buildVmNet(
  ep: EndpointRuntime,
  vmid: number,
  tf: MetricsTimeframe,
  ctx: AppContext,
  poller: Poller,
): Promise<VmNetResponse> {
  const none = (source: VmNetResponse['source']): VmNetResponse => ({
    timeframe: tf,
    vmid,
    series: [],
    source,
  });

  const vm = poller.getMulti()?.endpoints.find((e) => e.id === ep.id)?.snapshot?.vms.find((v) => v.vmid === vmid);
  if (!vm) return none('insufficientData');

  let config: Awaited<ReturnType<EndpointRuntime['source']['getVmConfig']>>;
  try {
    config = await ep.source.getVmConfig(vm.node, vmid, vm.type);
  } catch (err) {
    ctx.logger.warn(`vm-net(${ep.id}/${vmid}) : config PVE indisponible (${(err as Error).message})`);
    config = null;
  }
  const nets = config?.nets ?? [];
  if (nets.length === 0) return none('insufficientData');

  if (!influxReady(ctx)) return none('insufficientData');

  // 1) mapping interface hôte → MAC (fenêtre 1 h, dernier point par interface)
  let macIface: Map<string, string>;
  try {
    const mapRows = await ctx.influx!.querySql<InfluxRow>(
      ctx.influx!.rawDb,
      `SELECT iface, mac FROM net_if_mac WHERE node = ${sqlStr(vm.node)} AND time >= now() - INTERVAL '1 hour' ORDER BY time DESC`,
    );
    macIface = latestIfMacMapping(mapRows);
  } catch (err) {
    ctx.logger.warn(`vm-net(${ep.id}/${vmid}) : mapping net_if_mac indisponible (${(err as Error).message})`);
    return none('noMapping');
  }
  if (macIface.size === 0) return none('noMapping');

  // 2) cartes de la VM → tap hôte par MAC (minuscules)
  const series: VmNetSeries[] = sortNets(
    nets.map((n) => {
      const mac = n.mac ? n.mac.toLowerCase() : null;
      return {
        iface: n.iface,
        bridge: n.bridge,
        mac: n.mac ?? null,
        hostIface: mac ? (macIface.get(mac) ?? null) : null,
        label: vmNetLabel(n.iface, n.bridge),
        points: [],
      };
    }),
  );

  // 3) débits des tap résolus (1 requête `net` pour tous les devices de la VM)
  const hostIfaces = [...new Set(series.filter((s) => s.hostIface).map((s) => s.hostIface as string))];
  if (hostIfaces.length > 0) {
    let rows: InfluxRow[];
    try {
      const { bucket, bucketSec, window } = HOST_DISKIO_TF[tf];
      const where = `node = ${sqlStr(vm.node)} AND "interface" IN (${hostIfaces.map(sqlStr).join(', ')})`;
      rows = await ctx.influx!.querySql<InfluxRow>(ctx.influx!.rawDb, netRateSql(where, bucket, bucketSec, window));
    } catch (err) {
      ctx.logger.warn(`vm-net(${ep.id}/${vmid}) : table net indisponible (${(err as Error).message})`);
      return none('noMapping');
    }
    const byIface = new Map<string, VmNetPoint[]>();
    for (const r of rows) {
      const iface = String(r.iface ?? '');
      const t = influxTsToUnix(r.t as string | number | null);
      if (!iface || t <= 0) continue;
      const pts = byIface.get(iface) ?? [];
      pts.push({ t, inBps: normRate(r.in_bps), outBps: normRate(r.out_bps) });
      byIface.set(iface, pts);
    }
    for (const pts of byIface.values()) {
      pts.sort((a, b) => a.t - b.t);
    }
    for (const s of series) {
      if (s.hostIface) s.points = byIface.get(s.hostIface) ?? [];
    }
  }

  return { timeframe: tf, vmid, series, source: 'influx' };
}
