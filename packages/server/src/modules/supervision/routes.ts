import type { FastifyInstance } from 'fastify';
import {
  buildTopology,
  matchAgentNetsByMac,
  primaryAgentIp,
  type NetworkTopology,
  type ParsedVmNet,
  type StorageInventoryEndpoint,
  type StorageVmRef,
  type TopologyVm,
  type VmAgentNetIf,
} from '@prox4u/shared';
import type { AppContext, EndpointRuntime, Poller } from '../../core/poller.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  at: number;
  value: T;
}

/**
 * Supervision — phase 1B.
 * Topologie réseau auto-découverte : NICs/ponts par nœud (GET /nodes/{n}/network),
 * VM→pont via `bridge=` des interfaces netN / mpN de la config, switches physiques inférés
 * (même nom de pont + même sous-réseau = même switch — builder pur testé dans shared).
 */
export function registerSupervision(app: FastifyInstance, ctx: AppContext, _poller: Poller): void {
  const topoCache = new Map<string, CacheEntry<NetworkTopology>>();
  const storageCache = new Map<string, CacheEntry<StorageInventoryEndpoint>>();

  /** Topologie de tous les endpoints (cache 5 min par endpoint). */
  app.get('/api/network-topology', async () => {
    const topologies: NetworkTopology[] = [];
    for (const ep of ctx.endpoints) {
      const cached = topoCache.get(ep.id);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        topologies.push(cached.value);
        continue;
      }
      try {
        const value = await computeTopology(ep);
        topoCache.set(ep.id, { at: Date.now(), value });
        topologies.push(value);
      } catch (err) {
        // Dégradation : cache périmé plutôt que rien ; sinon l'endpoint est omis.
        if (cached) topologies.push(cached.value);
        else ctx.logger.warn(`network-topology: endpoint ${ep.id} indisponible : ${(err as Error).message}`);
      }
    }
    return { topologies };
  });

  /**
   * Inventaire stockage → VMs (hypervision, vue type vCenter). Renvoie par endpoint
   * les datastores (capacité, type, nœuds, contenus) et les VMs avec leur champ
   * `storage` (datastore du disque). Le groupement VM→datastore et les agrégats
   * sont calculés côté client (fonctions pures shared/storage-inventory).
   */
  app.get('/api/storage-inventory', async () => {
    const endpoints: StorageInventoryEndpoint[] = [];
    for (const ep of ctx.endpoints) {
      const cached = storageCache.get(ep.id);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        endpoints.push(cached.value);
        continue;
      }
      try {
        const value = await computeStorageInventory(ep);
        storageCache.set(ep.id, { at: Date.now(), value });
        endpoints.push(value);
      } catch (err) {
        if (cached) endpoints.push(cached.value);
        else ctx.logger.warn(`storage-inventory: endpoint ${ep.id} indisponible : ${(err as Error).message}`);
      }
    }
    return { endpoints };
  });
}

/** Datastores + VMs (avec leur datastore) d'un endpoint, depuis sa source. */
async function computeStorageInventory(ep: EndpointRuntime): Promise<StorageInventoryEndpoint> {
  const [storages, resources] = await Promise.all([ep.source.getStorage(), ep.source.getResources()]);
  const vms: StorageVmRef[] = [];
  for (const r of resources) {
    if (r.template) continue; // les templates ne sont pas des workloads
    if (!r.storage) continue; // VM sans datastore connu → ignorée par l'inventaire
    vms.push({
      vmid: r.vmid,
      name: r.name,
      node: r.node,
      status: r.status,
      diskBytes: r.disk ?? 0,
      storage: r.storage,
    });
  }
  return { endpointId: ep.id, storages, vms };
}

/**
 * Complète les interfaces de config avec les IPs live du guest agent (jointure par MAC) :
 * - `nets[].ip` ← IP primaire (IPv4 d'abord) quand la config n'en a pas ;
 * - `agentIps` ← liste complète par interface (v4 + v6), absente si aucune jointure.
 */
export function enrichVmAgentIps(
  nets: ParsedVmNet[],
  agentNets: VmAgentNetIf[],
): { nets: ParsedVmNet[]; agentIps?: Record<string, string[]> } {
  const joined = matchAgentNetsByMac(nets, agentNets);
  if (joined.size === 0) return { nets };
  const agentIps = Object.fromEntries(joined);
  return {
    nets: nets.map((n) => {
      const ips = agentIps[n.iface];
      return !n.ip && ips?.length ? { ...n, ip: primaryAgentIp(ips) } : n;
    }),
    agentIps,
  };
}

/** Assemble la topologie d'un endpoint depuis sa source (réseau nœuds + ressources VMs). */
async function computeTopology(ep: EndpointRuntime): Promise<NetworkTopology> {
  const [nodeNets, resources] = await Promise.all([ep.source.getNetwork(), ep.source.getResources()]);

  // Interfaces VM depuis la config (cache 1 h côté client — déjà chaud via le poller).
  const vms: TopologyVm[] = [];
  for (const r of resources) {
    if (r.template) continue; // les templates ne sont pas des workloads réseau
    const cfg = await ep.source.getVmConfig(r.node, r.vmid, r.type);
    const nets = cfg?.nets ?? [];

    // IPs live par interface (VM en marche : guest agent QEMU / netns LXC PVE ≥ 9 — cache 60 s dans le client).
    const enriched =
      r.status === 'running'
        ? enrichVmAgentIps(
            nets,
            r.type === 'qemu'
              ? await ep.source.getVmAgentNets(r.node, r.vmid)
              : await ep.source.getLxcInterfaces(r.node, r.vmid),
          )
        : { nets };

    vms.push({
      vmid: r.vmid,
      name: r.name,
      type: r.type,
      status: r.status,
      node: r.node,
      nets: enriched.nets,
      agentIps: enriched.agentIps,
      netInBps: r.netin,
      netOutBps: r.netout,
    });
  }

  return buildTopology({
    endpointId: ep.id,
    nodes: nodeNets.map((n) => ({
      node: n.node,
      online: n.online,
      ip: n.ip,
      nics: n.nics,
      bridges: n.bridges,
    })),
    vms,
  });
}
