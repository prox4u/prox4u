import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  getBezierPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useNodesState,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTranslation } from 'react-i18next';
import { Network, Server, Waypoints, Cpu, Shield } from 'lucide-react';
import {
  internalNetworkSegments,
  segmentKey,
  type ImpactResult,
  type NetworkTopology,
  type NodeBridge,
  type TopologySwitch,
  type TopologyVm,
} from '@prox4u/shared';
import { cn } from '../../../lib/utils';

/** Sélection d'un élément de la topologie (panneau détails). */
export interface TopologySelection {
  kind: 'switch' | 'node' | 'bridge' | 'segment' | 'vm' | 'iface';
  /** switch.id / nom du nœud / « nœud:pont » / « nœud:pont:vlan|natif » / vmid / « vmid:iface » */
  id: string;
}

/** Filtre de vue : ne montrer que les VMs utilisant au moins un des éléments choisis. */
export interface TopologyFilter {
  vlans: Set<number>;
  bridges: Set<string>;
  nics: Set<string>;
  /** Segments exacts (clés `segmentKey`) — sélection de réseau du déroulé. Vide = inactif. */
  networks: Set<string>;
}

interface Props {
  topology: NetworkTopology;
  /** nœuds « tombés » (simulation PRA N-1) — le reste est mis en surbrillance */
  failedNodes?: Set<string>;
  /** filtre de vue (VLANs / ponts / NICs) — undefined = pas de filtre */
  filter?: TopologyFilter;
  /** analyse d'impact incident — VMs impactées/dégradées surlignées */
  impact?: ImpactResult | null;
  /** élément sélectionné (panneau détails) — l'arête d'une interface est surlignée */
  selection?: TopologySelection | null;
  onSelect?: (sel: TopologySelection | null) => void;
}

// --- Dimensions du layout hiérarchique (switches → nœuds → ponts → [segments] → VMs)
const SW = { w: 210, h: 64 };
const ND = { w: 230, h: 78 };
const BR = { w: 165, h: 54 };
const SEG = { w: 96, h: 40 };
const VM = { w: 200, h: 62 };
const GAP_X = 48; // entre couloirs de nœuds
const GAP_BR = 20; // entre ponts d'un même nœud
const GAP_SEG = 12; // entre segments d'un même pont
const GAP_VM = 16; // entre VMs d'une même rangée
const Y_SWITCH = 0;
const Y_NODE = SW.h + 90;
const Y_BRIDGE = Y_NODE + ND.h + 80;
const Y_SEGMENT = Y_BRIDGE + BR.h + 70;
/** Marge du conteneur « localnetwork » (réseau interne Proxmox) autour des ponts. */
const ZONE_PAD = 16;

/** Palette des réseaux (pont + sous-réseau + VLAN) — couleurs vives lisibles sur fond sombre. */
const NET_PALETTE = [
  '#38bdf8', // sky
  '#a78bfa', // violet
  '#34d399', // emerald
  '#fbbf24', // amber
  '#f472b6', // pink
  '#fb923c', // orange
  '#22d3ee', // cyan
  '#a3e635', // lime
  '#e879f9', // fuchsia
  '#f87171', // red
];

interface SegmentSlot {
  vlan: number | null;
  x: number;
  w: number;
  /** toutes les VMs ayant une iface dans ce segment (arêtes) */
  vms: TopologyVm[];
  /** VMs dont c'est le segment principal (1er net) — positionnement */
  rowVms: TopologyVm[];
}

interface BridgeSlot {
  b: NodeBridge;
  x: number;
  w: number;
  segments: SegmentSlot[];
  /** toutes les VMs branchées sur ce pont (arêtes + trafic) */
  vms: TopologyVm[];
}

interface Lane {
  node: NetworkTopology['nodes'][number];
  x: number;
  w: number;
  bridges: BridgeSlot[];
}

/**
 * Layout déterministe : un couloir par nœud. Chaque pont contient ses segments
 * (pont+VLAN), qui contiennent les VMs. La couche segment n'est rendue que si des
 * VLANs existent (sinon pont→VM direct). Switches centrés au-dessus de leur portée.
 */
function layout(t: NetworkTopology): { nodes: Node[]; edges: Edge[] } {
  const hasVlans = t.vlans.length > 0;
  const Y_VM = hasVlans ? Y_SEGMENT + SEG.h + 70 : Y_BRIDGE + BR.h + 80;

  // Segments « réseau interne Proxmox » — ponts sans NIC physique (ex. bridge « nfs »).
  const mgmt = internalNetworkSegments(t);

  const swByGroup = new Map<string, TopologySwitch>();
  for (const s of t.switches) swByGroup.set(`${s.bridgeName}\u0000${s.subnet ?? ''}`, s);
  const groupOf = (b: NodeBridge): TopologySwitch | undefined =>
    swByGroup.get(`${b.name}\u0000${b.subnet ?? ''}`);

  const vmsByNode = new Map<string, TopologyVm[]>();
  for (const v of t.vms) {
    const list = vmsByNode.get(v.node) ?? [];
    list.push(v);
    vmsByNode.set(v.node, list);
  }

  // Couloirs de nœuds (ordre = ordre de l'API).
  const lanes: Lane[] = [];
  let cursor = 0;
  for (const node of t.nodes) {
    const nodeVms = vmsByNode.get(node.node) ?? [];
    const bridges: BridgeSlot[] = node.bridges.map((b) => {
      const vms = nodeVms.filter((v) => v.nets.some((n) => n.bridge === b.name));
      // Segments : groupées par le VLAN de leur iface sur ce pont (natif = null d'abord).
      const segByVlan = new Map<number | null, TopologyVm[]>();
      for (const v of vms) {
        const netOnBridge = v.nets.find((n) => n.bridge === b.name)!;
        const list = segByVlan.get(netOnBridge.tag) ?? [];
        list.push(v);
        segByVlan.set(netOnBridge.tag, list);
      }
      const segments: SegmentSlot[] = [...segByVlan.entries()]
        .map(([vlan, segVms]) => {
          const rowVms = segVms.filter((v) => v.nets[0]?.bridge === b.name && v.nets[0]?.tag === vlan);
          const w = Math.max(SEG.w, rowVms.length * (VM.w + GAP_VM) - (rowVms.length ? GAP_VM : 0));
          return { vlan, x: 0, w, vms: segVms, rowVms };
        })
        .sort((a, c) => (a.vlan ?? -1) - (c.vlan ?? -1));
      const segRowW = segments.reduce((s, x) => s + x.w, 0) + Math.max(0, segments.length - 1) * GAP_SEG;
      const w = Math.max(BR.w, segRowW);
      return { b, x: 0, w, segments, vms };
    });
    const rowW = bridges.reduce((s, x) => s + x.w, 0) + Math.max(0, bridges.length - 1) * GAP_BR;
    const w = Math.max(ND.w, rowW);
    lanes.push({ node, x: cursor, w, bridges });
    cursor += w + GAP_X;
  }

  // Couleurs par réseau (pont + sous-réseau + VLAN) : palette déterministe, ordre =
  // ordre d'apparition dans le layout. Un même réseau garde la même couleur partout
  // (arêtes, libellés d'interface, pastilles des nœuds pont/segment).
  const netKey = (b: NodeBridge, vlan: number | null) => `${b.name}\u0000${b.subnet ?? ''}\u0000${vlan ?? 'natif'}`;
  const netColor = new Map<string, string>();
  for (const lane of lanes)
    for (const br of lane.bridges)
      for (const seg of br.segments) {
        const k = netKey(br.b, seg.vlan);
        if (!netColor.has(k)) netColor.set(k, NET_PALETTE[netColor.size % NET_PALETTE.length]);
      }

  // Ponts centrés dans le couloir ; segments centrés sous chaque pont ; VMs sous leur segment.
  const vmX = new Map<number, number>();
  for (const lane of lanes) {
    const rowW = lane.bridges.reduce((s, x) => s + x.w, 0) + Math.max(0, lane.bridges.length - 1) * GAP_BR;
    let bx = lane.x + (lane.w - rowW) / 2;
    for (const br of lane.bridges) {
      br.x = bx;
      const segRowW = br.segments.reduce((s, x) => s + x.w, 0) + Math.max(0, br.segments.length - 1) * GAP_SEG;
      let sx = br.x + (br.w - segRowW) / 2;
      for (const seg of br.segments) {
        seg.x = sx;
        const vmRowW = seg.rowVms.length * (VM.w + GAP_VM) - (seg.rowVms.length ? GAP_VM : 0);
        let vx = seg.x + (seg.w - vmRowW) / 2;
        for (const v of seg.rowVms) {
          vmX.set(v.vmid, vx);
          vx += VM.w + GAP_VM;
        }
        sx += seg.w + GAP_SEG;
      }
      bx += br.w + GAP_BR;
    }
  }

  // Switches centrés au-dessus de leur portée, rangées empilées en cas de collision.
  const placed: { x1: number; x2: number; y: number }[] = [];
  const switchPos = new Map<string, { x: number; y: number }>();
  for (const s of t.switches) {
    const connected = lanes.filter((l) => l.bridges.some((br) => groupOf(br.b)?.id === s.id));
    const cx =
      connected.length === 0
        ? cursor / 2
        : (Math.min(...connected.map((l) => l.x)) + Math.max(...connected.map((l) => l.x + l.w))) / 2;
    let x = cx - SW.w / 2;
    let y = Y_SWITCH;
    for (;;) {
      if (!placed.some((p) => p.y === y && x < p.x2 + 24 && x + SW.w > p.x1 - 24)) break;
      y += SW.h + 36;
    }
    switchPos.set(s.id, { x, y });
    placed.push({ x1: x, x2: x + SW.w, y });
  }

  // --- Nœuds React Flow ---------------------------------------------------------
  const nodes: Node[] = [];
  // Zone « localnetwork » (réseau interne Proxmox) — conteneur en arrière-plan qui
  // englobe les ponts locaux et leurs VMs (ajouté en 1er → rendu derrière tout le reste).
  if (lanes.length > 0) {
    const zoneLeft = Math.min(...lanes.map((l) => l.x));
    const zoneRight = Math.max(...lanes.map((l) => l.x + l.w));
    const zoneTop = Y_BRIDGE - ZONE_PAD;
    const zoneBottom = Y_VM + VM.h + ZONE_PAD;
    nodes.push({
      id: 'zone:localnetwork',
      type: 'zone',
      position: { x: zoneLeft - ZONE_PAD, y: zoneTop },
      data: { labelKey: 'topo.zone.localnetwork', width: zoneRight - zoneLeft + 2 * ZONE_PAD, height: zoneBottom - zoneTop },
      draggable: false,
      selectable: false,
      connectable: false,
    });
  }
  for (const s of t.switches) {
    const p = switchPos.get(s.id)!;
    nodes.push({ id: `sw:${s.id}`, type: 'switch', position: { x: p.x, y: p.y }, data: { kind: 'switch', switch: s } });
  }
  for (const lane of lanes) {
    nodes.push({
      id: `nd:${lane.node.node}`,
      type: 'node',
      position: { x: lane.x + (lane.w - ND.w) / 2, y: Y_NODE },
      data: { kind: 'node', node: lane.node },
    });
    for (const br of lane.bridges) {
      nodes.push({
        id: `br:${lane.node.node}:${br.b.name}`,
        type: 'bridge',
        position: { x: br.x, y: Y_BRIDGE },
        // sans VLAN, le pont EST le réseau → pastille colorée ; avec VLAN, ce sont les segments
        data: {
          kind: 'bridge',
          node: lane.node.node,
          bridge: br.b,
          color: hasVlans ? undefined : netColor.get(netKey(br.b, null)),
          management: mgmt.has(segmentKey(br.b.name, null)),
        },
      });
      if (hasVlans) {
        for (const seg of br.segments) {
          nodes.push({
            id: `seg:${lane.node.node}:${br.b.name}:${seg.vlan ?? 'natif'}`,
            type: 'segment',
            position: { x: seg.x, y: Y_SEGMENT },
            data: {
              kind: 'segment',
              node: lane.node.node,
              bridge: br.b.name,
              vlan: seg.vlan,
              color: netColor.get(netKey(br.b, seg.vlan)),
              management: mgmt.has(segmentKey(br.b.name, seg.vlan)),
            },
          });
        }
      }
    }
  }
  for (const v of t.vms) {
    nodes.push({ id: `vm:${v.vmid}`, type: 'vm', position: { x: vmX.get(v.vmid) ?? 0, y: Y_VM }, data: { kind: 'vm', vm: v } });
  }

  // --- Arêtes --------------------------------------------------------------------
  const edges: Edge[] = [];
  const edgeWidth = (bps: number) => 1 + Math.min(3, Math.log10(1 + bps) / 3.5);
  for (const lane of lanes) {
    for (const br of lane.bridges) {
      const s = groupOf(br.b);
      if (!s) continue;
      const traffic = br.vms.reduce((sum, v) => sum + (v.netInBps ?? 0) + (v.netOutBps ?? 0), 0);
      edges.push({
        id: `e-sw-${s.id}-${lane.node.node}-${br.b.name}`,
        source: `sw:${s.id}`,
        target: `br:${lane.node.node}:${br.b.name}`,
        label: br.b.ports.length > 0 ? br.b.ports.join(' ') : undefined,
        animated: traffic > 0,
        style: { strokeWidth: edgeWidth(traffic), stroke: 'var(--color-primary)' },
        labelStyle: { fill: 'var(--color-muted-foreground)', fontSize: 10 },
        labelBgStyle: { fill: 'var(--color-card)' },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--color-primary)' },
      });
    }
  }
  for (const lane of lanes) {
    for (const br of lane.bridges) {
      if (hasVlans) {
        for (const seg of br.segments) {
          const segId = `seg:${lane.node.node}:${br.b.name}:${seg.vlan ?? 'natif'}`;
          const segTraffic = seg.vms.reduce((sum, v) => sum + (v.netInBps ?? 0) + (v.netOutBps ?? 0), 0);
          edges.push({
            id: `e-br-seg-${lane.node.node}-${br.b.name}-${seg.vlan ?? 'natif'}`,
            source: `br:${lane.node.node}:${br.b.name}`,
            target: segId,
            animated: segTraffic > 0,
            style: { strokeWidth: edgeWidth(segTraffic), stroke: netColor.get(netKey(br.b, seg.vlan))! },
          });
          for (const v of seg.vms) {
            const netIdx = v.nets.findIndex((n) => n.bridge === br.b.name && n.tag === seg.vlan);
            const net = v.nets[netIdx];
            const traffic = (v.netInBps ?? 0) + (v.netOutBps ?? 0);
            const color = netColor.get(netKey(br.b, seg.vlan))!;
            edges.push({
              id: `e-seg-vm-${lane.node.node}-${br.b.name}-${seg.vlan ?? 'natif'}-${v.vmid}`,
              source: segId,
              target: `vm:${v.vmid}`,
              type: 'iface',
              label: net?.iface,
              data: {
                vmid: v.vmid,
                iface: net?.iface ?? null,
                bridge: br.b.name,
                vlan: seg.vlan,
                mac: net?.mac ?? null,
                ip: net?.ip ?? null,
              },
              animated: v.status === 'running' && traffic > 0,
              style: { strokeWidth: edgeWidth(traffic), stroke: color },
              labelStyle: { fill: color, fontSize: 10, fontWeight: 600 },
              labelBgStyle: { fill: 'var(--color-card)', stroke: color, strokeWidth: 1 },
            });
          }
        }
      } else {
        for (const v of br.vms) {
          const netIdx = v.nets.findIndex((n) => n.bridge === br.b.name);
          const net = v.nets[netIdx];
          const traffic = (v.netInBps ?? 0) + (v.netOutBps ?? 0);
          const color = netColor.get(netKey(br.b, null))!;
          edges.push({
            id: `e-br-${lane.node.node}-${br.b.name}-${v.vmid}`,
            source: `br:${lane.node.node}:${br.b.name}`,
            target: `vm:${v.vmid}`,
            type: 'iface',
            label: net?.iface,
            data: {
              vmid: v.vmid,
              iface: net?.iface ?? null,
              bridge: br.b.name,
              vlan: null,
              mac: net?.mac ?? null,
              ip: net?.ip ?? null,
            },
            animated: v.status === 'running' && traffic > 0,
            style: { strokeWidth: edgeWidth(traffic), stroke: color },
            labelStyle: { fill: color, fontSize: 10, fontWeight: 600 },
            labelBgStyle: { fill: 'var(--color-card)', stroke: color, strokeWidth: 1 },
          });
        }
      }
    }
  }

  return { nodes, edges };
}

// --- Filtre + impact (fonctions pures du rendu) ------------------------------------

/** VMs visibles selon le filtre ; undefined = pas de filtre (toutes visibles). */
function computeVisibleVms(topology: NetworkTopology, filter?: TopologyFilter): Set<number> | undefined {
  if (!filter) return undefined;
  const active = filter.vlans.size > 0 || filter.bridges.size > 0 || filter.nics.size > 0 || filter.networks.size > 0;
  if (!active) return undefined;
  const portsByBridge = new Map<string, string[]>();
  for (const n of topology.nodes) for (const b of n.bridges) portsByBridge.set(`${n.node}\u0000${b.name}`, b.ports);
  const set = new Set<number>();
  for (const v of topology.vms) {
    if (
      v.nets.some((net) => {
        if (filter.networks.has(segmentKey(net.bridge, net.tag))) return true;
        if (net.tag !== null && filter.vlans.has(net.tag)) return true;
        if (filter.bridges.has(net.bridge)) return true;
        const ports = portsByBridge.get(`${v.node}\u0000${net.bridge}`) ?? [];
        return ports.some((p) => filter.nics.has(p));
      })
    )
      set.add(v.vmid);
  }
  return set;
}

/** Éléments supérieurs (switch/nœud/pont/segment) qui ont au moins une VM visible. */
function computeActiveUpper(topology: NetworkTopology, visibleVms: Set<number>): Set<string> {
  const hasVlans = topology.vlans.length > 0;
  const swIdByBridge = new Map<string, string>();
  for (const n of topology.nodes)
    for (const b of n.bridges) {
      const sw = topology.switches.find((s) => s.bridgeName === b.name && s.subnet === b.subnet);
      if (sw) swIdByBridge.set(`${n.node}\u0000${b.name}`, sw.id);
    }
  const active = new Set<string>();
  for (const v of topology.vms) {
    if (!visibleVms.has(v.vmid)) continue;
    active.add(`nd:${v.node}`);
    for (const net of v.nets) {
      active.add(`br:${v.node}:${net.bridge}`);
      if (hasVlans) active.add(`seg:${v.node}:${net.bridge}:${net.tag ?? 'natif'}`);
      const swId = swIdByBridge.get(`${v.node}\u0000${net.bridge}`);
      if (swId) active.add(`sw:${swId}`);
    }
  }
  return active;
}

// --- Nœuds custom ----------------------------------------------------------------

/**
 * Handles invisibles (haut/bas) : React Flow a besoin de points d'ancrage DOM pour
 * calculer les arêtes — sans eux, `getEdgePosition` échoue et aucune arête n'est rendue.
 */
function FlowHandles() {
  const style = { opacity: 0, pointerEvents: 'none' } as const;
  return (
    <>
      <Handle type="target" position={Position.Top} style={style} />
      <Handle type="source" position={Position.Bottom} style={style} />
    </>
  );
}

/**
 * Conteneur « localnetwork » (réseau interne Proxmox) : englobe les ponts locaux du
 * nœud et leurs VMs — l'équivalent de la zone SDN « localnetwork » de la GUI PVE.
 * Rendu en arrière-plan, non interactif, bordure pointillée distincte.
 */
function ZoneNode({ data }: NodeProps) {
  const { t } = useTranslation();
  const d = data as { labelKey: string; width: number; height: number };
  return (
    <div
      style={{ width: d.width, height: d.height }}
      className="pointer-events-none rounded-2xl border-2 border-dashed border-sky-400/40 bg-sky-400/[0.04]"
    >
      <div className="flex items-center gap-1.5 px-3 pt-2 text-[11px] font-semibold text-sky-300">
        <Network className="h-3.5 w-3.5 shrink-0" />
        {t(d.labelKey)}
      </div>
    </div>
  );
}

function SwitchNode({ data }: NodeProps) {
  const { t } = useTranslation();
  const s = (data as { switch: TopologySwitch }).switch;
  return (
    <div className="w-[210px] rounded-xl border border-indigo-400/50 bg-card px-3 py-2 shadow-md shadow-indigo-500/10">
      <FlowHandles />
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <Network className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="truncate">{s.name}</span>
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">
        {t('topo.legend.switch')} · {s.inferred ? t('topo.inferred') : '—'}
      </div>
    </div>
  );
}

function NodeServer({ data }: NodeProps) {
  const n = (data as { node: NetworkTopology['nodes'][number] }).node;
  return (
    <div className="w-[230px] rounded-xl border bg-card px-3 py-2 shadow-sm">
      <FlowHandles />
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <Server className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{n.node}</span>
        <span className={cn('ml-auto h-1.5 w-1.5 shrink-0 rounded-full', n.online ? 'bg-ok' : 'bg-crit')} />
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
        {n.ip ?? '—'} · {n.bridges.length} ponts · {n.nics.length} NICs
      </div>
    </div>
  );
}

function BridgeNode({ data }: NodeProps) {
  const d = data as { bridge: NodeBridge; color?: string; management?: boolean };
  const b = d.bridge;
  return (
    <div className="w-[165px] rounded-lg border bg-secondary px-2.5 py-1.5">
      <FlowHandles />
      <div className="flex items-center gap-1.5 text-[11px] font-semibold">
        {d.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: d.color }} />}
        <Waypoints className="h-3 w-3 shrink-0 text-primary" />
        <span className="truncate">{b.name}</span>
        {d.management && <Shield className="h-3 w-3 shrink-0 text-primary" aria-label="réseau interne Proxmox (sans NIC physique)" />}
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
        {b.ip ?? b.subnet ?? 'sans IP'}
        {b.ports.length > 0 ? ` · ${b.ports.join(' ')}` : ''}
      </div>
    </div>
  );
}

function SegmentNode({ data }: NodeProps) {
  const { t } = useTranslation();
  const d = data as { vlan: number | null; color?: string; management?: boolean };
  return (
    <div
      className="flex w-24 items-center justify-center gap-1 rounded-md border border-dashed bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground"
      style={d.color ? { borderColor: d.color } : undefined}
    >
      <FlowHandles />
      {d.color && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: d.color }} />}
      {d.vlan === null ? t('topo.vlan.native') : `${t('topo.vlan.label')} ${d.vlan}`}
      {d.management && <Shield className="h-3 w-3 shrink-0 text-primary" aria-label="réseau interne Proxmox (sans NIC physique)" />}
    </div>
  );
}

function statusDot(status: TopologyVm['status']): string {
  if (status === 'running') return 'bg-ok';
  if (status === 'stopped') return 'bg-muted-foreground/50';
  return 'bg-warn';
}

function VmNode({ data }: NodeProps) {
  const { t } = useTranslation();
  const v = (data as { vm: TopologyVm }).vm;
  const tone = (data as { impactTone?: 'crit' | 'warn' }).impactTone;
  const bps = (v.netInBps ?? 0) + (v.netOutBps ?? 0);
  return (
    <div
      className={cn(
        'w-[200px] rounded-lg border bg-card px-2.5 py-1.5 shadow-sm',
        tone === 'crit' && 'border-crit ring-2 ring-crit/40',
        tone === 'warn' && 'border-warn ring-2 ring-warn/40',
      )}
    >
      <FlowHandles />
      <div className="flex items-center gap-1.5 text-[11px] font-semibold">
        <Cpu className={cn('h-3 w-3 shrink-0', v.type === 'lxc' ? 'text-cyan-500' : 'text-violet-500')} />
        <span className="truncate">{v.name}</span>
        <span className={cn('ml-auto h-1.5 w-1.5 shrink-0 rounded-full', statusDot(v.status))} />
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
        {v.vmid} · {t(`topo.status.${v.status}`)}
        {bps > 0 ? ` · ${Math.round(bps / 1e6)} Mo/s` : ''}
      </div>
    </div>
  );
}

const nodeTypes = {
  zone: ZoneNode,
  switch: SwitchNode,
  node: NodeServer,
  bridge: BridgeNode,
  segment: SegmentNode,
  vm: VmNode,
};

// --- Arête custom : libellé d'interface posé sur SA courbe, collé à la VM -----------

/** Distance (px du graphe) entre le libellé et le haut de la VM. */
const LABEL_ABOVE_VM = 45;

/** Même formule que `getControlWithCurvature` (@xyflow/system) — pour recalculer les
 * points de contrôle d'une bezier identique à celle rendue par `getBezierPath`. */
function controlOffset(distance: number): number {
  return distance >= 0 ? 0.5 * distance : 6.25 * Math.sqrt(-distance);
}

/** Point de la courbe bezier (mêmes points de contrôle que `getBezierPath`) au paramètre t. */
function bezierPointAt(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  sourcePosition: Position,
  targetPosition: Position,
  t: number,
): { x: number; y: number } {
  const ctrl = (pos: Position, x1: number, y1: number, x2: number, y2: number) => {
    switch (pos) {
      case Position.Left:
        return { x: x1 - controlOffset(x1 - x2), y: y1 };
      case Position.Right:
        return { x: x1 + controlOffset(x2 - x1), y: y1 };
      case Position.Top:
        return { x: x1, y: y1 - controlOffset(y1 - y2) };
      default: // Bottom
        return { x: x1, y: y1 + controlOffset(y2 - y1) };
    }
  };
  const p1 = ctrl(sourcePosition, sourceX, sourceY, targetX, targetY);
  const p2 = ctrl(targetPosition, targetX, targetY, sourceX, sourceY);
  const u = 1 - t;
  return {
    x: u * u * u * sourceX + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * targetX,
    y: u * u * u * sourceY + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * targetY,
  };
}

/**
 * Arête segment/pont → VM : le libellé (net0, net1…) est posé SUR sa propre courbe, au
 * point le plus proche de l'ancre « juste au-dessus de la VM » (targetX, targetY − 45).
 * Chaque libellé est donc inambiguement associé à son interface — même quand les
 * courbes se croisent — tout en restant collé à la VM.
 */
function IfaceEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition = Position.Bottom,
    targetPosition = Position.Top,
    label,
    labelStyle,
    labelShowBg,
    labelBgStyle,
    style,
    markerEnd,
  } = props;
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  // t* : point de la courbe le plus proche (distance 2D) de l'ancre au-dessus de la VM.
  const ax = targetX;
  const ay = targetY - LABEL_ABOVE_VM;
  let bestT = 0.5;
  let bestDist = Infinity;
  for (let i = 1; i <= 32; i++) {
    const t = i / 32;
    const pt = bezierPointAt(sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, t);
    const dist = Math.hypot(pt.x - ax, pt.y - ay);
    if (dist < bestDist) {
      bestDist = dist;
      bestT = t;
    }
  }
  const p = bezierPointAt(sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, bestT);
  return (
    <BaseEdge
      id={id}
      path={path}
      label={label}
      labelX={p.x}
      labelY={p.y}
      labelStyle={labelStyle}
      labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle}
      style={style}
      markerEnd={markerEnd}
    />
  );
}

const edgeTypes = { iface: IfaceEdge };

// --- Composant principal -----------------------------------------------------------

export function TopologyFlow({ topology, failedNodes, filter, impact, selection, onSelect }: Props) {
  const base = useMemo(() => layout(topology), [topology]);
  // Mode contrôlé canonique : l'état détient positions + dimensions mesurées ; le drag
  // passe par onNodesChange (sans lui, React Flow n'applique aucun déplacement).
  const [nodes, setNodes] = useNodesState<Node>(base.nodes);
  const onNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [setNodes],
  );

  // Re-seed au changement de topologie → layout déterministe + positions remises à zéro.
  // On conserve les dimensions mesurées pour éviter un passage sans arêtes au re-rendu.
  useEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return base.nodes.map((n) => {
        const old = byId.get(n.id);
        return old?.measured ? { ...n, measured: old.measured } : n;
      });
    });
  }, [base, setNodes]);

  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);

  // fitView fiable : après le 1er paint (nœuds mesurés), on recadre sur la topologie.
  useEffect(() => {
    const id = requestAnimationFrame(() => rfRef.current?.fitView({ padding: 0.15, maxZoom: 1 }));
    return () => cancelAnimationFrame(id);
  }, [topology]);

  // Filtre : VMs visibles + éléments supérieurs actifs (les orphelins sont estompés).
  const visibleVms = useMemo(() => computeVisibleVms(topology, filter), [topology, filter]);
  const filterActive = visibleVms !== undefined;
  const activeUpper = useMemo(
    () => (filterActive ? computeActiveUpper(topology, visibleVms!) : undefined),
    [topology, visibleVms, filterActive],
  );

  // Impact incident : ensembles de vmids impactées / dégradées.
  const impactSets = useMemo(() => {
    if (!impact) return undefined;
    return {
      impacted: new Set(impact.impactedVms.map((v) => v.vmid)),
      degraded: new Set(impact.degradedVms.map((v) => v.vmid)),
    };
  }, [impact]);

  // Simulation PRA : nœuds tombés (et leurs ponts/VMs) estompés, switches orphelins aussi.
  const praDimmed = useMemo(() => {
    if (!failedNodes || failedNodes.size === 0) return undefined;
    const nodeFailed = new Set<string>();
    for (const n of topology.nodes) if (failedNodes.has(n.node)) nodeFailed.add(`nd:${n.node}`);
    const bridgeFailed = new Set<string>();
    for (const n of topology.nodes) {
      if (!nodeFailed.has(`nd:${n.node}`)) continue;
      for (const b of n.bridges) bridgeFailed.add(`br:${n.node}:${b.name}`);
    }
    const vmFailed = new Set<string>();
    for (const v of topology.vms) if (failedNodes.has(v.node)) vmFailed.add(`vm:${v.vmid}`);
    // un switch dont TOUS les nœuds sont tombés est hors service
    const swFailed = new Set<string>();
    for (const s of topology.switches) {
      const connected = topology.nodes.filter((n) => n.bridges.some((b) => b.name === s.bridgeName && b.subnet === s.subnet));
      if (connected.length > 0 && connected.every((n) => failedNodes.has(n.node))) swFailed.add(`sw:${s.id}`);
    }
    return new Set([...nodeFailed, ...bridgeFailed, ...vmFailed, ...swFailed]);
  }, [topology, failedNodes]);

  // --- Nœuds finaux : visibilité (filtre) + style (impact / PRA / orphelin) --------
  // Sans surcharge, on repasse le même objet (identité préservée) : React Flow garde
  // alors son nœud interne (dimensions + handles) et ne re-mesure pas → arêtes stables.
  const renderNodes = useMemo(() => {
    const out: Node[] = [];
    for (const n of nodes) {
      if (n.type === 'vm') {
        const vmid = Number(n.id.slice(3));
        if (filterActive && !visibleVms!.has(vmid)) continue; // masquée par le filtre
        let tone: 'crit' | 'warn' | undefined;
        if (impactSets?.impacted.has(vmid)) tone = 'crit';
        else if (impactSets?.degraded.has(vmid)) tone = 'warn';
        const dim = praDimmed?.has(n.id);
        if (!tone && !dim) {
          out.push(n);
          continue;
        }
        out.push({ ...n, data: { ...n.data, impactTone: tone }, style: dim ? { opacity: 0.3 } : undefined });
      } else {
        // couche supérieure : orpheline du filtre → estompée ; sinon PRA tombé → estompée
        const orphan = filterActive && !activeUpper!.has(n.id);
        const dim = orphan || praDimmed?.has(n.id);
        if (!dim) {
          out.push(n);
          continue;
        }
        out.push({ ...n, style: { opacity: orphan ? 0.18 : 0.3 } });
      }
    }
    return out;
  }, [nodes, filterActive, visibleVms, activeUpper, impactSets, praDimmed]);

  // --- Arêtes finales : masquage (filtre) + surlignage (impact / PRA / iface) -------
  const renderEdges = useMemo(() => {
    const out: Edge[] = [];
    const selIface = selection?.kind === 'iface' ? selection.id : null; // « vmid:iface »
    for (const e of base.edges) {
      if (filterActive && e.target.startsWith('vm:') && !visibleVms!.has(Number(e.target.slice(3)))) continue;
      let edge = e;
      if (praDimmed && (praDimmed.has(e.source) || praDimmed.has(e.target))) {
        edge = { ...edge, animated: false, style: { ...edge.style, strokeDasharray: '4 4', opacity: 0.3 } };
      }
      if (impactSets && e.target.startsWith('vm:')) {
        const vmid = Number(e.target.slice(3));
        if (impactSets.impacted.has(vmid)) edge = { ...edge, animated: false, style: { ...edge.style, stroke: 'var(--color-crit)', strokeWidth: 2.5 } };
        else if (impactSets.degraded.has(vmid)) edge = { ...edge, style: { ...edge.style, stroke: 'var(--color-warn)' } };
      }
      // interface sélectionnée → surlignage de son arête (VM concernée)
      const d = e.data as { vmid?: number; iface?: string | null } | undefined;
      if (selIface && d?.vmid != null && `${d.vmid}:${d.iface ?? ''}` === selIface) {
        edge = { ...edge, animated: false, style: { ...edge.style, stroke: 'var(--color-primary)', strokeWidth: 3 } };
      }
      out.push(edge);
    }
    return out;
  }, [base.edges, filterActive, visibleVms, impactSets, praDimmed, selection]);

  return (
    <div className="h-[560px] w-full overflow-hidden rounded-xl border bg-background/50">
      <ReactFlow
        nodes={renderNodes}
        onNodesChange={onNodesChange}
        edges={renderEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={2}
        onInit={(inst) => {
          rfRef.current = inst;
        }}
        onNodeClick={(_e, n) => {
          const d = n.data as {
            kind: TopologySelection['kind'];
            node?: { node: string };
            bridge?: NodeBridge;
            switch?: TopologySwitch;
            vm?: TopologyVm;
            vlan?: number | null;
          } & Record<string, unknown>;
          if (d.kind === 'switch' && d.switch) onSelect?.({ kind: 'switch', id: d.switch.id });
          else if (d.kind === 'node' && d.node) onSelect?.({ kind: 'node', id: d.node.node });
          else if (d.kind === 'bridge' && d.node && d.bridge) onSelect?.({ kind: 'bridge', id: `${d.node.node}:${d.bridge.name}` });
          else if (d.kind === 'segment') {
            const seg = d as unknown as { node: string; bridge: string; vlan: number | null };
            onSelect?.({ kind: 'segment', id: `${seg.node}:${seg.bridge}:${seg.vlan ?? 'natif'}` });
          } else if (d.kind === 'vm' && d.vm) onSelect?.({ kind: 'vm', id: String(d.vm.vmid) });
        }}
        onEdgeClick={(_e, edge) => {
          const d = edge.data as { vmid?: number; iface?: string | null } | undefined;
          if (d?.vmid != null && d.iface) onSelect?.({ kind: 'iface', id: `${d.vmid}:${d.iface}` });
        }}
        onPaneClick={() => onSelect?.(null)}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
