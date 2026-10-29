/**
 * Inventaire Proxmox consolidé (plugin proxmox-inventory) — types + builders purs.
 *
 * Un « inventaire » est une vue à plat d'UNE machine par ligne (QEMU ou LXC),
 * multi-endpoints, avec les champs multi-valeurs (disques par filesystem,
 * interfaces, IPs) et un export TXT/CSV/JSON qui respecte la vue filtrée.
 * Les fonctions sont pures (aucun effet de bord) et testées dans
 * proxmox-inventory.test.ts, comme storage-inventory / network-inventory.
 */

// --- Types de données ------------------------------------------------------------------

/** Un filesystem d'une VM (agent get-fsinfo, ou rootfs LXC). */
export interface InvDisk {
  /** point de montage (ex. `/`, `/NFS`) */
  mountpoint: string;
  /** périphérique/partition (ex. `sda1`, `dm-1`) — informationnel, pas une clé */
  dev: string | null;
  totalMb: number | null;
  usedMb: number | null;
  freeMb: number | null;
  usedPct: number | null;
}

/** Une interface réseau telle que vue par l'agent (QEMU) ou le netns (LXC). */
export interface InvInterface {
  name: string;
  mac: string | null;
  /** « ip/prefix » (v4 + v6), loopback/link-local exclus (déjà filtrés côté client) */
  ips: string[];
  ipv4: string[];
  ipv6: string[];
}

/** Une ligne d'inventaire : une VM (QEMU ou LXC) avec ses champs multi-valeurs. */
export interface InvVm {
  /** id de l'endpoint (cluster) d'origine */
  host: string;
  vmid: number;
  name: string;
  node: string;
  type: 'qemu' | 'lxc';
  status: string;
  template: boolean;
  /** famille OS (Linux/Windows/LXC/Autre) — depuis la config PVE */
  osType: string | null;
  cpuCores: number | null;
  /** % des cœurs alloués en cours d'utilisation */
  cpuPct: number | null;
  ramAllocMb: number | null;
  ramUsedMb: number | null;
  ramUsedPct: number | null;
  uptimeS: number | null;
  tags: string[];
  notes: string | null;
  disks: InvDisk[];
  interfaces: InvInterface[];
  /** toutes les IPs (v4 + v6), aplaties */
  ips: string[];
}

/** Inventaire d'un endpoint. */
export interface ProxmoxInventoryEndpoint {
  endpointId: string;
  endpointName: string;
  vms: InvVm[];
}

/** Réponse GET /api/proxmox-inventory. */
export interface ProxmoxInventoryResponse {
  /** unix ms */
  generatedAt: number;
  endpoints: ProxmoxInventoryEndpoint[];
}

// --- Filtres / tri / recherche ----------------------------------------------------------

export interface InvFilter {
  /** recherche texte libre (nom, os, ip, note, tag, nœud, vmid…) */
  search: string;
  /** '' = tous */
  node: string;
  /** '' | 'qemu' | 'lxc' */
  type: string;
  /** '' | 'running' | 'stopped' | 'paused' | 'unknown' */
  status: string;
  cpuMin: number | null;
  cpuMax: number | null;
  ramMin: number | null;
  ramMax: number | null;
  /** plage sur le volume total (Mo) */
  diskMin: number | null;
  diskMax: number | null;
}

export const DEFAULT_INV_FILTER: InvFilter = {
  search: '', node: '', type: '', status: '',
  cpuMin: null, cpuMax: null, ramMin: null, ramMax: null, diskMin: null, diskMax: null,
};

export type InvSortKey =
  | 'name' | 'vmid' | 'node' | 'type' | 'status'
  | 'cpuCores' | 'cpuPct' | 'ramAllocMb' | 'ramUsedMb' | 'ramUsedPct'
  | 'uptimeS' | 'diskMb';
export type InvSortDir = 'asc' | 'desc';

/** Volume total (Mo) d'une VM (somme des disques), null si aucun. */
export function invTotalDiskMb(v: InvVm): number | null {
  const vals = v.disks.map((d) => d.totalMb).filter((x): x is number => x != null);
  return vals.length > 0 ? vals.reduce((s, x) => s + x, 0) : null;
}

const STATUS_ORDER: Record<string, number> = { running: 0, paused: 1, stopped: 2, unknown: 3 };

/** Recherche globale + filtres colonne (nœud/type/état + plages CPU/RAM/volume). */
export function filterInvRows(vms: InvVm[], f: InvFilter): InvVm[] {
  const q = f.search.trim().toLowerCase();
  return vms.filter((v) => {
    if (f.node && v.node !== f.node) return false;
    if (f.type && v.type !== f.type) return false;
    if (f.status && v.status !== f.status) return false;
    if (f.cpuMin != null && (v.cpuPct ?? 0) < f.cpuMin) return false;
    if (f.cpuMax != null && (v.cpuPct ?? 0) > f.cpuMax) return false;
    if (f.ramMin != null && (v.ramUsedMb ?? 0) < f.ramMin) return false;
    if (f.ramMax != null && (v.ramUsedMb ?? 0) > f.ramMax) return false;
    const disk = invTotalDiskMb(v) ?? 0;
    if (f.diskMin != null && disk < f.diskMin) return false;
    if (f.diskMax != null && disk > f.diskMax) return false;
    if (q) {
      const hay = [
        v.name, String(v.vmid), v.node, v.type, v.status, v.osType ?? '',
        ...v.ips, ...v.tags, v.notes ?? '',
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Tri stable ; nulls last pour les clés numériques. */
export function sortInvRows(vms: InvVm[], key: InvSortKey, dir: InvSortDir): InvVm[] {
  const sign = dir === 'asc' ? 1 : -1;
  const val = (v: InvVm): number | string | null => {
    switch (key) {
      case 'name': return v.name;
      case 'node': return v.node;
      case 'type': return v.type;
      case 'status': return STATUS_ORDER[v.status] ?? 99;
      case 'cpuCores': return v.cpuCores;
      case 'cpuPct': return v.cpuPct;
      case 'ramAllocMb': return v.ramAllocMb;
      case 'ramUsedMb': return v.ramUsedMb;
      case 'ramUsedPct': return v.ramUsedPct;
      case 'uptimeS': return v.uptimeS;
      case 'diskMb': return invTotalDiskMb(v);
      case 'vmid': return v.vmid;
    }
  };
  return [...vms].sort((a, b) => {
    const av = val(a); const bv = val(b);
    // nulls last, quel que soit le sens
    if (av == null && bv == null) return a.vmid - b.vmid;
    if (av == null) return 1;
    if (bv == null) return -1;
    let cmp: number;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    if (cmp === 0) cmp = a.vmid - b.vmid;
    return cmp * sign;
  });
}

// --- Résumé agrégé ----------------------------------------------------------------------

export interface InvSummary {
  total: number;
  running: number;
  stopped: number;
  ramAllocMb: number;
  ramUsedMb: number;
  cpuCores: number;
  cpuPctAvg: number;
  agentOk: number;
}

/** Agrégats pour l'en-tête (RAM/CPU cumulés, compteurs d'état). */
export function invSummary(vms: InvVm[]): InvSummary {
  const running = vms.filter((v) => v.status === 'running').length;
  const ramAlloc = vms.reduce((s, v) => s + (v.ramAllocMb ?? 0), 0);
  const ramUsed = vms.reduce((s, v) => s + (v.ramUsedMb ?? 0), 0);
  const cores = vms.reduce((s, v) => s + (v.cpuCores ?? 0), 0);
  const withCpu = vms.filter((v) => v.cpuPct != null);
  const cpuAvg = withCpu.length > 0
    ? withCpu.reduce((s, v) => s + (v.cpuPct ?? 0), 0) / withCpu.length
    : 0;
  const agentOk = vms.filter((v) => v.interfaces.length > 0 || v.disks.length > 0).length;
  return {
    total: vms.length,
    running,
    stopped: vms.length - running,
    ramAllocMb: Math.round(ramAlloc * 10) / 10,
    ramUsedMb: Math.round(ramUsed * 10) / 10,
    cpuCores: Math.round(cores * 10) / 10,
    cpuPctAvg: Math.round(cpuAvg * 10) / 10,
    agentOk,
  };
}

// --- Exports (respectent la vue filtrée) -------------------------------------------------

const NA = 'N/A';

function diskStr(d: InvDisk): string {
  return `${d.mountpoint} ${Math.round(d.usedMb ?? 0)}/${Math.round(d.totalMb ?? 0)}Mo (${Math.round(d.usedPct ?? 0)}%)`;
}
function ifaceStr(i: InvInterface): string {
  return `${i.name} ${i.mac ?? ''} ${(i.ips.join(', ') || '')}`.replace(/\s+/g, ' ').trim();
}

/** TXT : tableau aligné + bloc détail par VM. */
export function invToTxt(vms: InvVm[]): string {
  const L: string[] = [];
  L.push(`INVENTAIRE PROXMOX — ${vms.length} VM(s)`);
  L.push('='.repeat(78));
  L.push(' VMID  Nœud         Type  État      CPU%  RAM used/all (Mo)  Nom');
  L.push('-'.repeat(78));
  for (const v of [...vms].sort((a, b) => a.node.localeCompare(b.node) || a.vmid - b.vmid)) {
    const ram = v.ramAllocMb != null ? `${Math.round(v.ramUsedMb ?? 0)}/${Math.round(v.ramAllocMb)}` : NA;
    const cpu = v.cpuPct != null ? v.cpuPct.toFixed(1) : NA;
    L.push(`${String(v.vmid).padStart(5)}  ${pad(v.node, 10)} ${pad(v.type, 5)} ${pad(v.status || '?', 8)} ${cpu.padStart(5)} ${ram.padStart(18)}  ${v.name || v.vmid}`);
  }
  L.push('');
  for (const v of [...vms].sort((a, b) => a.node.localeCompare(b.node) || a.vmid - b.vmid)) {
    L.push(`[${v.vmid}] ${v.name || v.vmid} — ${v.node} (${v.type}, ${v.status || '?'})`);
    if (v.osType) L.push(`    OS       : ${v.osType}`);
    if (v.disks.length) {
      L.push('    Disques  :');
      for (const d of v.disks) L.push(`       ${pad(d.mountpoint, 12)} ${Math.round(d.usedMb ?? 0)} / ${Math.round(d.totalMb ?? 0)} Mo (${Math.round(d.usedPct ?? 0)}%)  ${d.dev ?? ''}`);
    }
    if (v.interfaces.length) {
      L.push('    Réseaux  :');
      for (const i of v.interfaces) L.push(`       ${pad(i.name, 8)} ${pad(i.mac ?? '?', 14)} ${pad('', 5)} ${i.ips.join(', ') || NA}`);
    }
    if (v.tags.length) L.push(`    Tags     : ${v.tags.join(', ')}`);
    if (v.notes) L.push(`    Notes    : ${v.notes}`);
    L.push('');
  }
  return L.join('\n');
}

/** CSV : séparateur `;`, UTF-8 BOM (Excel), multi-valeurs `|`. */
export function invToCsv(vms: InvVm[]): string {
  const header = ['Nom', 'VMID', 'Host', 'Nœud', 'Type', 'État', 'OS type', 'CPU (cœurs)', 'CPU (%)',
    'RAM all. (Mo)', 'RAM used (Mo)', 'RAM (%)', 'Uptime (s)', 'Disques', 'Interfaces', 'IPs',
    'Tags', 'Notes', 'Template'];
  const esc = (x: unknown) => `"${String(x ?? NA).replace(/"/g, '""')}"`;
  const lines = [header.join(';')];
  for (const v of vms) {
    lines.push([
      v.name, v.vmid, v.host, v.node, v.type, v.status, v.osType,
      v.cpuCores, v.cpuPct, v.ramAllocMb, v.ramUsedMb, v.ramUsedPct, v.uptimeS,
      v.disks.map(diskStr).join('|') || NA,
      v.interfaces.map(ifaceStr).join('|') || NA,
      v.ips.join('|') || NA,
      v.tags.join('|') || NA, v.notes, v.template ? 'oui' : 'non',
    ].map(esc).join(';'));
  }
  return '\ufeff' + lines.join('\r\n');
}

/** JSON : structure hiérarchique (objets imbriqués disques/interfaces/IPs). */
export function invToJson(vms: InvVm[]): string {
  const out = vms.map((v) => ({
    name: v.name, vmid: v.vmid, host: v.host, node: v.node, type: v.type,
    status: v.status, template: v.template,
    os: { type: v.osType },
    cpu: { cores: v.cpuCores, usage_pct: v.cpuPct },
    ram: { allocated_mb: v.ramAllocMb, used_mb: v.ramUsedMb, used_pct: v.ramUsedPct },
    uptime_s: v.uptimeS,
    disks: v.disks.map((d) => ({ mountpoint: d.mountpoint, dev: d.dev, total_mb: d.totalMb, used_mb: d.usedMb, free_mb: d.freeMb, used_pct: d.usedPct })),
    interfaces: v.interfaces.map((i) => ({ name: i.name, mac: i.mac, ipv4: i.ipv4, ipv6: i.ipv6, ips: i.ips })),
    ips: v.ips, tags: v.tags, notes: v.notes,
  }));
  return JSON.stringify(out, null, 2);
}

export function invToFormat(fmt: 'txt' | 'csv' | 'json', vms: InvVm[]): string {
  if (fmt === 'csv') return invToCsv(vms);
  if (fmt === 'json') return invToJson(vms);
  return invToTxt(vms);
}

// --- Helpers internes --------------------------------------------------------------------

function pad(s: string, n: number): string {
  s = String(s ?? '');
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
