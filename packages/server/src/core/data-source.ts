import type {
  AgentFsUsage,
  NodeBridge,
  NodeNic,
  PveNodeStatus,
  PvePool,
  PveStorage,
  PveVmResource,
  PveVmSnapshot,
  RrddataPoint,
  VmAgentNetIf,
  VmConfigInfo,
  VmOsInfo,
} from '@prox4u/shared';

export type Timeframe = 'hour' | 'day' | 'week' | 'month' | 'year';

// VmConfigInfo vit dans @prox4u/shared (source unique des types server/web) — re-exporté
// pour ne pas casser les imports existants (prox4u-client, mock-source).
export type { VmConfigInfo };

/** Réseau d'un nœud (GET /nodes/{n}/network, parsé). */
export interface NodeNetwork {
  node: string;
  online: boolean;
  ip: string | null;
  nics: NodeNic[];
  bridges: NodeBridge[];
}

/**
 * Source de données du dashboard. Deux implémentations :
 *  - Prox4uClient (cluster réel, API PVE 9)
 *  - MockSource (démo multi-bâtiments, déterministe)
 */
export interface DataSource {
  readonly isMock: boolean;

  /** statut du cluster + nœuds (online, cpu, mem, uptime, rootfs…) */
  getNodes(): Promise<PveNodeStatus[]>;

  /** toutes les VMs/CTs du cluster (avec cpuAlloc joint depuis la config) */
  getResources(): Promise<PveVmResource[]>;

  /** datastores avec capacités (used/total en octets, null si indisponible) */
  getStorage(): Promise<PveStorage[]>;

  /** pools Proxmox (= équipes) */
  getPools(): Promise<PvePool[]>;

  /** config d'une VM (cpuAlloc, os, pool, nets) — mise en cache par l'appelant */
  getVmConfig(node: string, vmid: number, type: 'qemu' | 'lxc'): Promise<VmConfigInfo | null>;

  /** liste des snapshots d'une VM (GET /nodes/{n}/{type}/{vmid}/snapshot) — à la demande, hors poller */
  getVmSnapshots(node: string, vmid: number, type: 'qemu' | 'lxc'): Promise<PveVmSnapshot[]>;

  /** interfaces du guest agent QEMU (IP+MAC par interface) — [] si VM arrêtée / agent absent */
  getVmAgentNets(node: string, vmid: number): Promise<VmAgentNetIf[]>;

  /** interfaces d'un conteneur LXC (PVE ≥ 9, netns lu côté hôte — fonctionne avec ip=manual) — [] si arrêté */
  getLxcInterfaces(node: string, vmid: number): Promise<VmAgentNetIf[]>;

  /**
   * usage disque RÉEL PAR FILESYSTEM d'une VM QEMU via l'agent invité (get-fsinfo,
   * fs sur disques VM). Une entrée par point de montage / partition. `null` si VM arrêtée
   * / agent absent / PVE sans l'endpoint ; `[]` si agent vivant mais aucun fs sur disque VM.
   * Source fiable d'usage disque par VM QEMU (le RRD `disk` vaut 0, `maxdisk` n'est que l'allocation).
   */
  getAgentFsUsage(node: string, vmid: number): Promise<AgentFsUsage[] | null>;

  /**
   * OS réel d'une VM QEMU via l'agent invité (QGA guest-get-osinfo) — GET
   * /nodes/{n}/qemu/{vmid}/agent/get-osinfo. Renvoie la distro + version + noyau.
   * `null` si VM arrêtée / agent absent / PVE sans l'endpoint (le repli famille OS
   * se fait côté appelant sur la config `ostype`).
   */
  getOsInfo(node: string, vmid: number): Promise<VmOsInfo | null>;

  /**
   * Bundle des données agent d'une VM, toutes mises en cache dans le client (fsinfo 5 min,
   * osinfo 5 min, interfaces 60 s) — source unique partagée entre le poller et la route
   * proxmox-inventory. `fs`/`osinfo` seulement pour QEMU tournant ; `nets` pour QEMU/LXC.
   */
  getAgentBundle(
    node: string,
    vmid: number,
    type: 'qemu' | 'lxc',
    status: string,
  ): Promise<{ fs: AgentFsUsage[] | null; osinfo: VmOsInfo | null; nets: VmAgentNetIf[] }>;

  /** Lecture seule du cache usage disque (aucun fetch) — undefined si jamais interrogé / périmé. */
  cachedFsUsage(node: string, vmid: number): AgentFsUsage[] | undefined;

  /** réseau des nœuds (NICs + ponts) — topologie auto-découverte */
  getNetwork(): Promise<NodeNetwork[]>;

  /** historique RRD (nœud ou VM) */
  getRrddata(
    kind: 'node' | 'vm',
    node: string,
    vmid: number | undefined,
    timeframe: Timeframe,
    vmType?: 'qemu' | 'lxc',
  ): Promise<RrddataPoint[]>;
}
