import type {
  NodeHealth,
  OvercommitConfig,
  StorageInfo,
  StorageVolume,
  VmSummary,
} from './types.js';
import { overcommitTone } from './overcommit.js';

/**
 * Audit / best-practices — 2ᵉ score de CONFIGURATION (en complément du health
 * score qui mesure les RESSOURCES). Inspiré du catalogue de 43 checks ProxMenux
 * (voir skill `monitoring-proxmenux` §2.3) : la plupart sont faisables via l'API
 * PVE avec les données déjà pollées.
 *
 * Formule déterministe du score (documentée) :
 *
 *   score = 100 − Σ pénalités, borné à [0, 100]
 *
 * Pénalités par CONSTAT (pas par check) :
 *   - critique : −10
 *   - vigilance : −5
 *   - info     : −1
 *
 * Libellés :  ≥ 80 Conforme · 50–79 À améliorer · < 50 À revoir
 *
 * Chaque constat porte une cible cliquable (VM / nœud / stockage / cluster) —
 * la page « Audit » navigue vers le détail concerné.
 */

export type AuditSeverity = 'info' | 'warn' | 'crit';

export type AuditTargetKind = 'vm' | 'node' | 'storage' | 'cluster';

/** Cible d'un constat — ce que la page « Audit » rend cliquable. */
export interface AuditTarget {
  kind: AuditTargetKind;
  /** endpoint (cluster) — toujours présent. */
  endpointId: string;
  /** nom du nœud (kind=node, ou localisation d'un constat VM/stockage). */
  node?: string;
  /** vmid (kind=vm). */
  vmid?: number;
  /** nom du datastore (kind=storage). */
  storage?: string;
  /** libellé lisible (nom VM / nœud / datastore / cluster). */
  label: string;
}

/** Un constat d'audit (un check peut produire plusieurs constats, un par cible). */
export interface AuditFinding {
  /** identifiant du check (ex. `guests.qemu_without_agent`). */
  check: string;
  severity: AuditSeverity;
  /** clé i18n du message (préfixe `audit.finding.`). */
  messageKey: string;
  /** paramètres du message i18n. */
  params?: Record<string, string | number>;
  target: AuditTarget;
}

export interface AuditCounts {
  crit: number;
  warn: number;
  info: number;
}

export interface AuditScore {
  /** score de configuration 0–100. */
  score: number;
  /** clé i18n du libellé (`audit.label.*`). */
  labelKey: string;
  /** constats triés par sévérité (crit → warn → info). */
  findings: AuditFinding[];
  counts: AuditCounts;
  /** nombre total de checks évalués. */
  checksTotal: number;
  /** nombre de checks passés (sans aucun constat). */
  checksPassed: number;
}

/** Pont d'un nœud (projet de `getNetwork()` — seules les données utiles aux checks). */
export interface AuditBridge {
  node: string;
  name: string;
  /** NICs physiques attachées (`bridge_ports`). */
  ports: string[];
}

/** Résultat d'audit d'un endpoint (GET /api/audit sans paramètre). */
export interface AuditEndpointResult extends AuditScore {
  endpointId: string;
  endpointName: string;
}

/** Réponse GET /api/audit (tous les endpoints). */
export interface AuditAllResponse {
  endpoints: AuditEndpointResult[];
}

/** Entrée structurée des checks — construite par le serveur (snapshot + réseau). */
export interface AuditInput {
  endpointId: string;
  nodes: NodeHealth[];
  vms: VmSummary[];
  storages: StorageInfo[];
  storageVolumes: StorageVolume[];
  /** ponts par nœud — vide si `getNetwork()` indisponible. */
  bridges: AuditBridge[];
  /** politique de surallocation (overcommit.json). */
  overcommit: OvercommitConfig;
}

/** Pénalités par sévérité (formule documentée ci-dessus). */
export const AUDIT_PENALTIES: Record<AuditSeverity, number> = {
  crit: 10,
  warn: 5,
  info: 1,
} as const;

/** Ordre d'affichage des sévérités (crit d'abord). */
const SEVERITY_ORDER: Record<AuditSeverity, number> = { crit: 0, warn: 1, info: 2 };

/** Libellé du score (clé i18n). */
export function auditLabelKey(score: number): string {
  if (score >= 80) return 'audit.label.compliant';
  if (score >= 50) return 'audit.label.toImprove';
  return 'audit.label.toReview';
}

// ---------------------------------------------------------------------------
// Checks (fonctions pures : AuditInput → AuditFinding[])
// ---------------------------------------------------------------------------

/** Cible VM (cliquable vers le détail VM). */
function vmTarget(input: AuditInput, vm: VmSummary): AuditTarget {
  return {
    kind: 'vm',
    endpointId: input.endpointId,
    node: vm.node,
    vmid: vm.vmid,
    label: vm.name || `VM ${vm.vmid}`,
  };
}

/** Cible nœud (cliquable vers la page nœud). */
function nodeTarget(input: AuditInput, node: string): AuditTarget {
  return { kind: 'node', endpointId: input.endpointId, node, label: node };
}

/** Cible stockage (cliquable vers la page stockage). */
function storageTarget(input: AuditInput, storage: string): AuditTarget {
  return { kind: 'storage', endpointId: input.endpointId, storage, label: storage };
}

/** Cible cluster (cliquable vers la page endpoint). */
function clusterTarget(input: AuditInput): AuditTarget {
  return { kind: 'cluster', endpointId: input.endpointId, label: input.endpointId };
}

/**
 * `guests.qemu_without_agent` (CRIT) — VM QEMU en cours dont l'agent invité est
 * inactif : pas de fsinfo/osinfo/IP, pas de sauvegarde fiable, monitoring dégradé.
 * `agentActive === null` (inconnu, 1ers ticks) ne produit PAS de constat — on ne
 * flag que l'inactif certain (`false`).
 */
export function checkQemuWithoutAgent(input: AuditInput): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const vm of input.vms) {
    if (vm.type === 'qemu' && vm.status === 'running' && vm.agentActive === false) {
      out.push({
        check: 'guests.qemu_without_agent',
        severity: 'crit',
        messageKey: 'audit.finding.qemu_without_agent',
        params: { name: vm.name || `VM ${vm.vmid}` },
        target: vmTarget(input, vm),
      });
    }
  }
  return out;
}

/**
 * `guests.privileged_containers` (WARN) — conteneur LXC privilégié
 * (`unprivileged=0`) : accès direct aux devices du hôte, surface d'attaque plus
 * large. `unprivileged === undefined` (config inconnue) ne produit pas de constat.
 */
export function checkPrivilegedContainers(input: AuditInput): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const vm of input.vms) {
    if (vm.type === 'lxc' && vm.unprivileged === false) {
      out.push({
        check: 'guests.privileged_containers',
        severity: 'warn',
        messageKey: 'audit.finding.privileged_containers',
        params: { name: vm.name || `CT ${vm.vmid}` },
        target: vmTarget(input, vm),
      });
    }
  }
  return out;
}

/**
 * `guests.cpu_host_type` (INFO) — VM QEMU (non template) sans `cpu=host` : le
 * type CPU virtuel peut limiter la migration live entre hétérogènes. Bonnes
 * pratiques recommandent `cpu=host` quand le parc est homogène.
 * `cpuHost === undefined` (config inconnue / LXC) ne produit pas de constat.
 */
export function checkCpuHostType(input: AuditInput): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const vm of input.vms) {
    if (vm.type === 'qemu' && vm.cpuHost === false) {
      out.push({
        check: 'guests.cpu_host_type',
        severity: 'info',
        messageKey: 'audit.finding.cpu_host_type',
        params: { name: vm.name || `VM ${vm.vmid}` },
        target: vmTarget(input, vm),
      });
    }
  }
  return out;
}

/**
 * `network.bridge_without_ports` (WARN) — pont Linux sans NIC physique attachée
 * (`bridge_ports` vide) : les VMs branchées dessus n'ont pas d'accès au réseau
 * externe (souvent une méconfig, parfois volontaire — d'où WARN).
 */
export function checkBridgeWithoutPorts(input: AuditInput): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const b of input.bridges) {
    if (b.ports.length === 0) {
      out.push({
        check: 'network.bridge_without_ports',
        severity: 'warn',
        messageKey: 'audit.finding.bridge_without_ports',
        params: { node: b.node, bridge: b.name },
        target: nodeTarget(input, b.node),
      });
    }
  }
  return out;
}

/**
 * `storage.thin_pool_overprovisioning` (WARN) — pool thin (lvmthin/zfs/rbd) dont
 * le ratio alloué/capacité dépasse la politique overcommit. La teinte est déjà
 * calculée par la politique (`StorageVolume.tone`) — on réutilise, pas de seuil
 * dupliqué.
 */
export function checkThinPoolOverprovisioning(input: AuditInput): AuditFinding[] {
  const out: AuditFinding[] = [];
  const seen = new Set<string>();
  const walk = (v: StorageVolume): void => {
    if (v.thinCapable && v.hasDisks && (v.tone === 'warn' || v.tone === 'crit') && !seen.has(v.storage)) {
      seen.add(v.storage);
      out.push({
        check: 'storage.thin_pool_overprovisioning',
        severity: v.tone === 'crit' ? 'crit' : 'warn',
        messageKey: 'audit.finding.thin_pool_overprovisioning',
        params: { storage: v.storage, ratio: v.ratio != null ? Math.round(v.ratio * 100) / 100 : 0 },
        target: storageTarget(input, v.storage),
      });
    }
    for (const c of v.children) walk(c);
  };
  for (const v of input.storageVolumes) walk(v);
  return out;
}

/**
 * `system.memory_overcommit` (WARN/CRIT) — RAM sur-allouée sur un nœud :
 * (Σ maxmem + provision hôte) / RAM physique au-delà de la politique
 * (`overcommit.ram`). Même formule que le ratio cluster (computeOvercommit),
 * appliquée par nœud. Nœuds hors ligne ignorés.
 */
export function checkMemoryOvercommit(input: AuditInput): AuditFinding[] {
  const out: AuditFinding[] = [];
  const provision = input.overcommit.hostRamProvisionPct / 100;
  for (const n of input.nodes) {
    if (!n.online || !n.memTotalBytes || n.memTotalBytes <= 0) continue;
    const ratio = (n.ramAllocBytes + provision * n.memTotalBytes) / n.memTotalBytes;
    const tone = overcommitTone(ratio, input.overcommit.ram);
    if (tone === 'warn' || tone === 'crit') {
      out.push({
        check: 'system.memory_overcommit',
        severity: tone,
        messageKey: 'audit.finding.memory_overcommit',
        params: { node: n.node, ratio: Math.round(ratio * 100) / 100 },
        target: nodeTarget(input, n.node),
      });
    }
  }
  return out;
}

/**
 * `system.node_version_mismatch` (INFO) — versions PVE hétérogènes entre nœuds
 * en ligne : risque de comportement divergent / migration. Une seule version →
 * pas de constat.
 */
export function checkNodeVersionMismatch(input: AuditInput): AuditFinding[] {
  const versions = new Set<string>();
  for (const n of input.nodes) {
    if (n.online && n.version) versions.add(n.version);
  }
  if (versions.size <= 1) return [];
  return [
    {
      check: 'system.node_version_mismatch',
      severity: 'info',
      messageKey: 'audit.finding.node_version_mismatch',
      params: { versions: [...versions].sort().join(', ') },
      target: clusterTarget(input),
    },
  ];
}

/** Catalogue des checks (ordre d'évaluation). */
const CHECKS: Array<(input: AuditInput) => AuditFinding[]> = [
  checkQemuWithoutAgent,
  checkPrivilegedContainers,
  checkCpuHostType,
  checkBridgeWithoutPorts,
  checkThinPoolOverprovisioning,
  checkMemoryOvercommit,
  checkNodeVersionMismatch,
];

/**
 * Exécute tous les checks et calcule le score de configuration.
 * Les constats sont triés par sévérité (crit → warn → info), puis par libellé.
 */
export function runAudit(input: AuditInput): AuditScore {
  const findings: AuditFinding[] = [];
  let checksPassed = 0;
  for (const check of CHECKS) {
    const f = check(input);
    findings.push(...f);
    if (f.length === 0) checksPassed++;
  }
  const counts: AuditCounts = { crit: 0, warn: 0, info: 0 };
  let penalty = 0;
  for (const f of findings) {
    counts[f.severity]++;
    penalty += AUDIT_PENALTIES[f.severity];
  }
  const score = Math.max(0, Math.min(100, 100 - penalty));
  findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.target.label.localeCompare(b.target.label),
  );
  return {
    score,
    labelKey: auditLabelKey(score),
    findings,
    counts,
    checksTotal: CHECKS.length,
    checksPassed,
  };
}
