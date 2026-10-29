import type { FastifyInstance } from 'fastify';
import {
  type AgentFsUsage,
  type InvInterface,
  type InvVm,
  type PveVmResource,
  type ProxmoxInventoryEndpoint,
  type VmAgentNetIf,
  type VmOsInfo,
  osFamilyFromId,
  ostypeFamily,
} from '@prox4u/shared';
import type { AppContext, EndpointRuntime, Poller } from '../../core/poller.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MB = 1024 * 1024;

interface CacheEntry<T> {
  at: number;
  value: T;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * % CPU d'une VM — même sémantique que le poller (vmCpuPct) :
 * LXC : `cpu` est une fraction 0..1 → ×100 ; QEMU : `cpu` est en cœurs (0..cpuAlloc)
 * → rapport à l'allocation ×100.
 */
function cpuPct(v: { type: string; cpu?: number | null; cpuAlloc?: number }): number | null {
  if (v.cpu == null) return null;
  if (v.type === 'lxc') return round1(v.cpu * 100);
  return v.cpuAlloc ? round1((v.cpu / v.cpuAlloc) * 100) : null;
}

/** Sépare les « ip/prefix » en v4 / v6 (la partie avant / contient « : » pour v6). */
function splitIps(ips: string[]): { ipv4: string[]; ipv6: string[] } {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  for (const ip of ips) {
    const addr = ip.split('/')[0];
    if (addr.includes(':')) ipv6.push(ip);
    else ipv4.push(ip);
  }
  return { ipv4, ipv6 };
}

/**
 * Famille OS d'une ligne : l'agent QGA (primaire, OS réel) sinon le code `ostype`
 * de la config (repli VMs arrêtées / sans agent) sinon la famille `os` (dernier recours).
 */
function vmOsFamily(v: PveVmResource, osinfo: VmOsInfo | null): string | null {
  if (osinfo?.id) return osFamilyFromId(osinfo.id);
  if (v.ostype) return ostypeFamily(v.ostype);
  return v.os ?? null;
}

/** Construit une ligne d'inventaire depuis la ressource PVE + données d'agent. */
function buildInvVm(ep: EndpointRuntime, v: PveVmResource, fs: AgentFsUsage[] | null, nets: VmAgentNetIf[], osinfo: VmOsInfo | null): InvVm {
  const ramAllocMb = v.maxmem ? round1(v.maxmem / MB) : null;
  const ramUsedMb = v.mem ? round1(v.mem / MB) : null;
  const ramUsedPct = v.maxmem && v.mem ? round1((v.mem / v.maxmem) * 100) : null;

  const disks: InvVm['disks'] = [];
  if (fs) {
    for (const f of fs) {
      disks.push({
        mountpoint: f.mountpoint,
        dev: f.dev,
        totalMb: round1(f.totalBytes / MB),
        usedMb: round1(f.usedBytes / MB),
        freeMb: round1((f.totalBytes - f.usedBytes) / MB),
        usedPct: f.totalBytes > 0 ? round1((f.usedBytes / f.totalBytes) * 100) : null,
      });
    }
  } else if (v.type === 'lxc' && v.maxdisk) {
    // LXC : un seul fs rootfs (allocation + usage depuis /cluster/resources).
    disks.push({
      mountpoint: '/',
      dev: null,
      totalMb: round1(v.maxdisk / MB),
      usedMb: round1((v.disk ?? 0) / MB),
      freeMb: round1((v.maxdisk - (v.disk ?? 0)) / MB),
      usedPct: v.maxdisk > 0 ? round1(((v.disk ?? 0) / v.maxdisk) * 100) : null,
    });
  }

  const interfaces: InvInterface[] = (nets ?? []).map((n) => {
    const { ipv4, ipv6 } = splitIps(n.ips);
    return { name: n.name, mac: n.mac, ips: n.ips, ipv4, ipv6 };
  });
  const ips = interfaces.flatMap((i) => i.ips);

  return {
    host: ep.id,
    vmid: v.vmid,
    name: v.name,
    node: v.node,
    type: v.type,
    status: v.status,
    template: !!v.template,
    osType: vmOsFamily(v, osinfo),
    osPretty: v.type === 'lxc' ? null : (osinfo?.prettyName ?? osinfo?.name ?? null),
    osKernel: osinfo?.kernelRelease ?? null,
    cpuCores: v.cpuAlloc ?? null,
    cpuPct: cpuPct(v),
    ramAllocMb,
    ramUsedMb,
    ramUsedPct,
    uptimeS: v.uptime ?? null,
    tags: v.tags ?? [],
    notes: v.notes ?? null,
    disks,
    interfaces,
    ips,
  };
}

/** Inventaire d'un endpoint : ressources + agent (fs, interfaces) en parallèle. */
async function computeInventory(ep: EndpointRuntime): Promise<ProxmoxInventoryEndpoint> {
  const vms = await ep.source.getResources();
  const out: InvVm[] = [];
  await Promise.all(
    vms.map(async (v) => {
      // Les appels agent sont mis en cache (60 s / timeout 8 s) et best-effort :
      // une VM arrêtée ou sans agent renvoie null / [] sans bloquer l'inventaire.
      const [fs, nets, osinfo] = await Promise.all([
        v.type === 'qemu' && v.status === 'running'
          ? ep.source.getAgentFsUsage(v.node, v.vmid)
          : Promise.resolve(null),
        v.type === 'qemu'
          ? ep.source.getVmAgentNets(v.node, v.vmid)
          : ep.source.getLxcInterfaces(v.node, v.vmid),
        v.type === 'qemu' && v.status === 'running'
          ? ep.source.getOsInfo(v.node, v.vmid)
          : Promise.resolve(null),
      ]);
      out.push(buildInvVm(ep, v, fs, nets, osinfo));
    }),
  );
  out.sort((a, b) => a.vmid - b.vmid);
  return { endpointId: ep.id, endpointName: ep.name, vms: out };
}

/**
 * Inventaire Proxmox consolidé (plugin proxmox-inventory) — une VM par ligne,
 * multi-endpoints, avec disques par filesystem (agent), interfaces + IPs, tags,
 * notes. Cache serveur 5 min par endpoint ; dégradé sur cache périmé en cas
 * d'indisponibilité (même pattern que supervision).
 */
export function registerProxInventory(app: FastifyInstance, ctx: AppContext, _poller: Poller): void {
  const cache = new Map<string, CacheEntry<ProxmoxInventoryEndpoint>>();

  app.get('/api/proxmox-inventory', async () => {
    const endpoints: ProxmoxInventoryEndpoint[] = [];
    for (const ep of ctx.endpoints) {
      const cached = cache.get(ep.id);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        endpoints.push(cached.value);
        continue;
      }
      try {
        const value = await computeInventory(ep);
        cache.set(ep.id, { at: Date.now(), value });
        endpoints.push(value);
      } catch (err) {
        if (cached) endpoints.push(cached.value);
        else ctx.logger.warn(`proxmox-inventory: endpoint ${ep.id} indisponible : ${(err as Error).message}`);
      }
    }
    return { generatedAt: Date.now(), endpoints };
  });
}
