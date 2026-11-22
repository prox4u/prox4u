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

/** Bond d'un nœud (projet de `getNetwork()`, `type: "bond"` + `bond_slaves`). */
export interface AuditBond {
  node: string;
  name: string;
  /** NICs esclaves du bond (`bond_slaves`, liste espace-séparée → tableau). */
  slaves: string[];
}

/** Job de réplication (projet de `GET /cluster/replication` — statut inclus). */
export interface AuditReplication {
  vmid: number;
  node: string;
  /** nom de la VM (joint depuis /cluster/resources) — repli « VM <vmid> ». */
  name: string;
  /** dernier résultat (« ok » / autre) — null si jamais exécuté. */
  lastResult: string | null;
  /** âge de la dernière fin en heures — null si jamais exécuté. */
  lastEndAgeHours: number | null;
}

/** ZFS ARC max d'un nœud (table Telegraf `zfs`, `arcstats_c_max`). */
export interface AuditZfsArc {
  node: string;
  /** taille max de l'ARC (octets). */
  arcMaxBytes: number;
  /** RAM totale du nœud (octets). */
  memTotalBytes: number;
}

/** SMART d'un disque (table Telegraf `smart_device`) — projection pour les checks disques. */
export interface AuditSmartDisk {
  node: string;
  device: string;
  /** modèle (lisible) — null si inconnu. */
  model: string | null;
  /** état SMART global — true=PASSED, false=FAILED, null=inconnu (pas de SMART). */
  healthOk: boolean | null;
  reallocatedSectors: number | null;
  pendingSectors: number | null;
  uncorrectableSectors: number | null;
  udmaCrcErrors: number | null;
  /** usure NVMe (0–100 %) — null si pas de NVMe / inconnu. */
  percentageUsed: number | null;
}

/** Unité systemd en échec (table Telegraf `systemd_units`, `active=failed` ou `load=error`). */
export interface AuditFailedUnit {
  node: string;
  name: string;
}

/** Nœud avec un redémarrage en attente (table Telegraf `reboot_pending`, `pending=1`). */
export interface AuditRebootPending {
  node: string;
}

/** Mises à jour de sécurité en attente sur un nœud (table Telegraf `security_updates`). */
export interface AuditSecurityUpdates {
  node: string;
  count: number;
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
  /** bonds par nœud — vide si `getNetwork()` indisponible ou aucun bond. */
  bonds: AuditBond[];
  /** jobs de réplication — vide si `GET /cluster/replication` indisponible ou aucun job. */
  replications: AuditReplication[];
  /** ZFS ARC max par nœud — vide si pas de données ZFS (agent non déployé). */
  zfsArc: AuditZfsArc[];
  /** disques SMART — vide si pas de données (agent non déployé). */
  smartDisks: AuditSmartDisk[];
  /** unités systemd en échec — vide si aucune. */
  failedUnits: AuditFailedUnit[];
  /** nœuds avec un redémarrage en attente — vide si aucun. */
  rebootPending: AuditRebootPending[];
  /** mises à jour de sécurité en attente par nœud — vide si aucune donnée. */
  securityUpdates: AuditSecurityUpdates[];
  /** politique de surallocation (overcommit.json). */
  overcommit: OvercommitConfig;
  /** configuration de l'audit (audit.json, hot-reload) — défauts si absent. */
  config: AuditConfig;
}

/** Pénalités par sévérité (défauts — formule documentée ci-dessus). */
export const AUDIT_PENALTIES: Record<AuditSeverity, number> = {
  crit: 10,
  warn: 5,
  info: 1,
} as const;

/**
 * Configuration de l'audit — externalisée dans `audit.json` (racine, hot-reload,
 * pattern `overcommit.json`). Fichier optionnel : absent → `DEFAULT_AUDIT_CONFIG`.
 *
 * Chaque check peut être **activé/désactivé** (`enabled`) et, s'il a des seuils,
 * ceux-ci sont ajustables sans toucher au code. Les 17 checks (P1+P2+P3) sont
 * implémentés et lisent cette config.
 */
export interface AuditConfig {
  /** Pénalités par sévérité (formule du score). */
  penalties: Record<AuditSeverity, number>;
  /** Libellé du score : ≥ nominal → Conforme, ≥ degraded → À améliorer, sinon À revoir. */
  labelNominal: number;
  labelDegraded: number;
  /** Paramètres par check (enabled + seuils). */
  checks: {
    // Phase 1 (livrés)
    'guests.qemu_without_agent': { enabled: boolean };
    'guests.privileged_containers': { enabled: boolean };
    'guests.cpu_host_type': { enabled: boolean };
    'network.bridge_without_ports': { enabled: boolean };
    'storage.thin_pool_overprovisioning': { enabled: boolean };
    'system.memory_overcommit': { enabled: boolean };
    'system.node_version_mismatch': { enabled: boolean };
    // Phase 2 (checks API)
    'guests.autostart': { enabled: boolean };
    'guests.stuck_snapshots': { enabled: boolean; maxAgeDays: number };
    'guests.replication_state': { enabled: boolean; maxStalenessHours: number };
    'network.bond_members': { enabled: boolean; minMembers: number };
    'system.zfs_arc_max': { enabled: boolean; maxPctOfRam: number };
    // Phase 3 (checks agent / Telegraf)
    'disks.disk_errors': { enabled: boolean };
    'disks.disk_service_life': { enabled: boolean; warnPct: number; critPct: number };
    'system.failed_units': { enabled: boolean };
    'system.pending_reboot': { enabled: boolean };
    'system.security_updates': { enabled: boolean; warnCount: number };
  };
}

/** Défauts de l'audit (tous checks activés, seuils documentés). */
export const DEFAULT_AUDIT_CONFIG: AuditConfig = {
  penalties: { ...AUDIT_PENALTIES },
  labelNominal: 80,
  labelDegraded: 50,
  checks: {
    'guests.qemu_without_agent': { enabled: true },
    'guests.privileged_containers': { enabled: true },
    'guests.cpu_host_type': { enabled: true },
    'network.bridge_without_ports': { enabled: true },
    'storage.thin_pool_overprovisioning': { enabled: true },
    'system.memory_overcommit': { enabled: true },
    'system.node_version_mismatch': { enabled: true },
    'guests.autostart': { enabled: true },
    'guests.stuck_snapshots': { enabled: true, maxAgeDays: 7 },
    'guests.replication_state': { enabled: true, maxStalenessHours: 24 },
    'network.bond_members': { enabled: true, minMembers: 2 },
    'system.zfs_arc_max': { enabled: true, maxPctOfRam: 75 },
    'disks.disk_errors': { enabled: true },
    'disks.disk_service_life': { enabled: true, warnPct: 80, critPct: 90 },
    'system.failed_units': { enabled: true },
    'system.pending_reboot': { enabled: true },
    'system.security_updates': { enabled: true, warnCount: 5 },
  },
};

/** Ordre d'affichage des sévérités (crit d'abord). */
const SEVERITY_ORDER: Record<AuditSeverity, number> = { crit: 0, warn: 1, info: 2 };

/** Libellé du score (clé i18n) — seuils pilotés par `audit.json`. */
export function auditLabelKey(score: number, nominal = 80, degraded = 50): string {
  if (score >= nominal) return 'audit.label.compliant';
  if (score >= degraded) return 'audit.label.toImprove';
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
  if (!input.config.checks['guests.qemu_without_agent'].enabled) return [];
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
  if (!input.config.checks['guests.privileged_containers'].enabled) return [];
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
  if (!input.config.checks['guests.cpu_host_type'].enabled) return [];
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
  if (!input.config.checks['network.bridge_without_ports'].enabled) return [];
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
  if (!input.config.checks['storage.thin_pool_overprovisioning'].enabled) return [];
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
  if (!input.config.checks['system.memory_overcommit'].enabled) return [];
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
  if (!input.config.checks['system.node_version_mismatch'].enabled) return [];
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

/**
 * `guests.autostart` (INFO) — VMs dont l'autostart est désactivé (défaut PVE) :
 * après un reboot du nœud, elles ne redémarreront pas d'elles-mêmes. Constat
 * AGRÉGÉ (un seul, avec un compteur) pour ne pas distordre le score — la revue
 * « qui doit autostarter » est une décision métier, pas une erreur.
 * `autostart === undefined` (config inconnue) n'est pas compté.
 */
export function checkAutostart(input: AuditInput): AuditFinding[] {
  if (!input.config.checks['guests.autostart'].enabled) return [];
  const count = input.vms.filter((v) => v.autostart === false).length;
  if (count === 0) return [];
  return [
    {
      check: 'guests.autostart',
      severity: 'info',
      messageKey: 'audit.finding.autostart',
      params: { count },
      target: clusterTarget(input),
    },
  ];
}

/**
 * `guests.stuck_snapshots` (WARN) — snapshot le plus vieux d'une VM plus âgé que
 * `maxAgeDays` : espace disque consommé, état obsolète, restauration risquée.
 * `oldestSnapshotAgeDays == null` (pas de snapshot / inconnu) ne produit pas de
 * constat.
 */
export function checkStuckSnapshots(input: AuditInput): AuditFinding[] {
  const cfg = input.config.checks['guests.stuck_snapshots'];
  if (!cfg.enabled) return [];
  const out: AuditFinding[] = [];
  for (const vm of input.vms) {
    if (vm.oldestSnapshotAgeDays != null && vm.oldestSnapshotAgeDays > cfg.maxAgeDays) {
      out.push({
        check: 'guests.stuck_snapshots',
        severity: 'warn',
        messageKey: 'audit.finding.stuck_snapshots',
        params: { name: vm.name || `VM ${vm.vmid}`, days: Math.round(vm.oldestSnapshotAgeDays) },
        target: vmTarget(input, vm),
      });
    }
  }
  return out;
}

/**
 * `guests.replication_state` (WARN) — job de réplication dont la dernière
 * exécution a échoué (`lastResult !== 'ok'`) ou n'a pas abouti depuis
 * `maxStalenessHours` : la copie distante n'est plus fiable en cas de sinistre.
 */
export function checkReplicationState(input: AuditInput): AuditFinding[] {
  const cfg = input.config.checks['guests.replication_state'];
  if (!cfg.enabled) return [];
  const out: AuditFinding[] = [];
  for (const r of input.replications) {
    const never = r.lastEndAgeHours == null;
    const failed = !never && r.lastResult !== 'ok';
    const stale = !never && !failed && r.lastEndAgeHours! > cfg.maxStalenessHours;
    if (!never && !failed && !stale) continue; // dernière réplication ok et récente
    const target = { kind: 'vm' as const, endpointId: input.endpointId, node: r.node, vmid: r.vmid, label: r.name };
    if (never) {
      out.push({ check: 'guests.replication_state', severity: 'warn', messageKey: 'audit.finding.replication_state.never', params: { name: r.name }, target });
    } else if (failed) {
      out.push({ check: 'guests.replication_state', severity: 'warn', messageKey: 'audit.finding.replication_state.failed', params: { name: r.name, hours: Math.round(r.lastEndAgeHours!) }, target });
    } else {
      out.push({ check: 'guests.replication_state', severity: 'warn', messageKey: 'audit.finding.replication_state.stale', params: { name: r.name, hours: Math.round(r.lastEndAgeHours!) }, target });
    }
  }
  return out;
}

/**
 * `network.bond_members` (WARN) — bond Linux avec moins de `minMembers` esclaves
 * configurés : la redondance est perdue (un seul chemin réseau). Un bond à 1
 * esclave n'a plus d'intérêt qu'une NIC simple.
 */
export function checkBondMembers(input: AuditInput): AuditFinding[] {
  const cfg = input.config.checks['network.bond_members'];
  if (!cfg.enabled) return [];
  const out: AuditFinding[] = [];
  for (const b of input.bonds) {
    if (b.slaves.length < cfg.minMembers) {
      out.push({
        check: 'network.bond_members',
        severity: 'warn',
        messageKey: 'audit.finding.bond_members',
        params: { node: b.node, bond: b.name, members: b.slaves.length },
        target: nodeTarget(input, b.node),
      });
    }
  }
  return out;
}

/**
 * `system.zfs_arc_max` (WARN) — taille max de l'ARC ZFS au-delà de
 * `maxPctOfRam` % de la RAM : l'ARC peut asphyxier les processus (ZFS cache
 * agressif). Le défaut ZFS (~50 % de la RAM) est sain ; un `zfs_arc_max` monté
 * à la main au-delà du seuil mérite une revue.
 */
export function checkZfsArcMax(input: AuditInput): AuditFinding[] {
  const cfg = input.config.checks['system.zfs_arc_max'];
  if (!cfg.enabled) return [];
  const out: AuditFinding[] = [];
  for (const z of input.zfsArc) {
    if (z.memTotalBytes > 0 && z.arcMaxBytes > 0) {
      const pct = (z.arcMaxBytes / z.memTotalBytes) * 100;
      if (pct > cfg.maxPctOfRam) {
        out.push({
          check: 'system.zfs_arc_max',
          severity: 'warn',
          messageKey: 'audit.finding.zfs_arc_max',
          params: { node: z.node, pct: Math.round(pct), threshold: cfg.maxPctOfRam },
          target: nodeTarget(input, z.node),
        });
      }
    }
  }
  return out;
}

/**
 * `disks.disk_errors` (CRIT) — disque SMART dégradé : état global FAILED ou
 * secteurs réalloués / en attente / non corrigeables / erreurs CRC > 0 : risque
 * de perte de données. `healthOk === null` (pas de SMART) et secteurs `null`
 * (non lus) ne produisent pas de constat (pas de faux positif).
 */
export function checkDiskErrors(input: AuditInput): AuditFinding[] {
  if (!input.config.checks['disks.disk_errors'].enabled) return [];
  const out: AuditFinding[] = [];
  for (const d of input.smartDisks) {
    const bad =
      d.healthOk === false ||
      (d.reallocatedSectors ?? 0) > 0 ||
      (d.pendingSectors ?? 0) > 0 ||
      (d.uncorrectableSectors ?? 0) > 0 ||
      (d.udmaCrcErrors ?? 0) > 0;
    if (bad) {
      out.push({
        check: 'disks.disk_errors',
        severity: 'crit',
        messageKey: 'audit.finding.disk_errors',
        params: { node: d.node, device: d.device, model: d.model ?? d.device },
        target: nodeTarget(input, d.node),
      });
    }
  }
  return out;
}

/**
 * `disks.disk_service_life` (WARN/CRIT) — usure NVMe (`percentage_used`) au-delà
 * de `warnPct` (warn) ou `critPct` (crit) : le SSD approche / atteint la fin de
 * sa durée de vie nominale. `percentageUsed === null` (pas de NVMe) → pas de
 * constat.
 */
export function checkDiskServiceLife(input: AuditInput): AuditFinding[] {
  const cfg = input.config.checks['disks.disk_service_life'];
  if (!cfg.enabled) return [];
  const out: AuditFinding[] = [];
  for (const d of input.smartDisks) {
    if (d.percentageUsed == null) continue;
    const sev = d.percentageUsed >= cfg.critPct ? 'crit' : d.percentageUsed >= cfg.warnPct ? 'warn' : null;
    if (sev) {
      out.push({
        check: 'disks.disk_service_life',
        severity: sev,
        messageKey: 'audit.finding.disk_service_life',
        params: { node: d.node, device: d.device, pct: Math.round(d.percentageUsed) },
        target: nodeTarget(input, d.node),
      });
    }
  }
  return out;
}

/**
 * `system.failed_units` (WARN) — unités systemd en échec (`active=failed` ou
 * `load=error`) : un service ou un montage n'a pas démarré. Un constat par unité.
 */
export function checkFailedUnits(input: AuditInput): AuditFinding[] {
  if (!input.config.checks['system.failed_units'].enabled) return [];
  const out: AuditFinding[] = [];
  for (const u of input.failedUnits) {
    out.push({
      check: 'system.failed_units',
      severity: 'warn',
      messageKey: 'audit.finding.failed_units',
      params: { node: u.node, unit: u.name },
      target: nodeTarget(input, u.node),
    });
  }
  return out;
}

/**
 * `system.pending_reboot` (INFO) — un redémarrage est en attente sur le nœud
 * (noyau / paquets mis à jour non appliqués). Un constat par nœud.
 */
export function checkPendingReboot(input: AuditInput): AuditFinding[] {
  if (!input.config.checks['system.pending_reboot'].enabled) return [];
  const out: AuditFinding[] = [];
  for (const r of input.rebootPending) {
    out.push({
      check: 'system.pending_reboot',
      severity: 'info',
      messageKey: 'audit.finding.pending_reboot',
      params: { node: r.node },
      target: nodeTarget(input, r.node),
    });
  }
  return out;
}

/**
 * `system.security_updates` (INFO) — `warnCount` correctifs de sécurité ou plus
 * en attente sur le nœud : exposition à des CVE connues. Un constat par nœud
 * (seuil `warnCount`).
 */
export function checkSecurityUpdates(input: AuditInput): AuditFinding[] {
  const cfg = input.config.checks['system.security_updates'];
  if (!cfg.enabled) return [];
  const out: AuditFinding[] = [];
  for (const s of input.securityUpdates) {
    if (s.count >= cfg.warnCount) {
      out.push({
        check: 'system.security_updates',
        severity: 'info',
        messageKey: 'audit.finding.security_updates',
        params: { node: s.node, count: s.count, threshold: cfg.warnCount },
        target: nodeTarget(input, s.node),
      });
    }
  }
  return out;
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
  checkAutostart,
  checkStuckSnapshots,
  checkReplicationState,
  checkBondMembers,
  checkZfsArcMax,
  checkDiskErrors,
  checkDiskServiceLife,
  checkFailedUnits,
  checkPendingReboot,
  checkSecurityUpdates,
];

/**
 * Métadonnées d'un check (catalogue « pourquoi / comment ») — consommé par la
 * page « Audit » pour documenter chaque check. Les textes sont des clés i18n
 * (`audit.check.<id>.title/.why/.how`) ; `thresholdKey` (optionnel) décrit le
 * seuil ajustable dans `audit.json`.
 */
export interface AuditCheckMeta {
  /** identifiant du check (ex. `guests.qemu_without_agent`). */
  id: string;
  /** phase de livraison (1 = API basique, 2 = API avancée, 3 = agent/Telegraf). */
  phase: 1 | 2 | 3;
  /** sévérité maximale que le check peut émettre. */
  severity: AuditSeverity;
  /** clé i18n du titre court. */
  titleKey: string;
  /** clé i18n du « pourquoi » (risque / bonne pratique). */
  whyKey: string;
  /** clé i18n du « comment » (source de la donnée + correction). */
  howKey: string;
  /** clé i18n du seuil ajustable — null si check booléen (pas de seuil). */
  thresholdKey: string | null;
}

/** Catalogue des 17 checks (ordre = ordre d'évaluation). */
export const CHECKS_META: AuditCheckMeta[] = [
  { id: 'guests.qemu_without_agent', phase: 1, severity: 'crit', titleKey: 'audit.check.qemu_without_agent.title', whyKey: 'audit.check.qemu_without_agent.why', howKey: 'audit.check.qemu_without_agent.how', thresholdKey: null },
  { id: 'guests.privileged_containers', phase: 1, severity: 'warn', titleKey: 'audit.check.privileged_containers.title', whyKey: 'audit.check.privileged_containers.why', howKey: 'audit.check.privileged_containers.how', thresholdKey: null },
  { id: 'guests.cpu_host_type', phase: 1, severity: 'info', titleKey: 'audit.check.cpu_host_type.title', whyKey: 'audit.check.cpu_host_type.why', howKey: 'audit.check.cpu_host_type.how', thresholdKey: null },
  { id: 'network.bridge_without_ports', phase: 1, severity: 'warn', titleKey: 'audit.check.bridge_without_ports.title', whyKey: 'audit.check.bridge_without_ports.why', howKey: 'audit.check.bridge_without_ports.how', thresholdKey: null },
  { id: 'storage.thin_pool_overprovisioning', phase: 1, severity: 'warn', titleKey: 'audit.check.thin_pool_overprovisioning.title', whyKey: 'audit.check.thin_pool_overprovisioning.why', howKey: 'audit.check.thin_pool_overprovisioning.how', thresholdKey: null },
  { id: 'system.memory_overcommit', phase: 1, severity: 'crit', titleKey: 'audit.check.memory_overcommit.title', whyKey: 'audit.check.memory_overcommit.why', howKey: 'audit.check.memory_overcommit.how', thresholdKey: null },
  { id: 'system.node_version_mismatch', phase: 1, severity: 'info', titleKey: 'audit.check.node_version_mismatch.title', whyKey: 'audit.check.node_version_mismatch.why', howKey: 'audit.check.node_version_mismatch.how', thresholdKey: null },
  { id: 'guests.autostart', phase: 2, severity: 'info', titleKey: 'audit.check.autostart.title', whyKey: 'audit.check.autostart.why', howKey: 'audit.check.autostart.how', thresholdKey: null },
  { id: 'guests.stuck_snapshots', phase: 2, severity: 'warn', titleKey: 'audit.check.stuck_snapshots.title', whyKey: 'audit.check.stuck_snapshots.why', howKey: 'audit.check.stuck_snapshots.how', thresholdKey: 'audit.check.stuck_snapshots.threshold' },
  { id: 'guests.replication_state', phase: 2, severity: 'warn', titleKey: 'audit.check.replication_state.title', whyKey: 'audit.check.replication_state.why', howKey: 'audit.check.replication_state.how', thresholdKey: 'audit.check.replication_state.threshold' },
  { id: 'network.bond_members', phase: 2, severity: 'warn', titleKey: 'audit.check.bond_members.title', whyKey: 'audit.check.bond_members.why', howKey: 'audit.check.bond_members.how', thresholdKey: 'audit.check.bond_members.threshold' },
  { id: 'system.zfs_arc_max', phase: 2, severity: 'warn', titleKey: 'audit.check.zfs_arc_max.title', whyKey: 'audit.check.zfs_arc_max.why', howKey: 'audit.check.zfs_arc_max.how', thresholdKey: 'audit.check.zfs_arc_max.threshold' },
  { id: 'disks.disk_errors', phase: 3, severity: 'crit', titleKey: 'audit.check.disk_errors.title', whyKey: 'audit.check.disk_errors.why', howKey: 'audit.check.disk_errors.how', thresholdKey: null },
  { id: 'disks.disk_service_life', phase: 3, severity: 'crit', titleKey: 'audit.check.disk_service_life.title', whyKey: 'audit.check.disk_service_life.why', howKey: 'audit.check.disk_service_life.how', thresholdKey: 'audit.check.disk_service_life.threshold' },
  { id: 'system.failed_units', phase: 3, severity: 'warn', titleKey: 'audit.check.failed_units.title', whyKey: 'audit.check.failed_units.why', howKey: 'audit.check.failed_units.how', thresholdKey: null },
  { id: 'system.pending_reboot', phase: 3, severity: 'info', titleKey: 'audit.check.pending_reboot.title', whyKey: 'audit.check.pending_reboot.why', howKey: 'audit.check.pending_reboot.how', thresholdKey: null },
  { id: 'system.security_updates', phase: 3, severity: 'info', titleKey: 'audit.check.security_updates.title', whyKey: 'audit.check.security_updates.why', howKey: 'audit.check.security_updates.how', thresholdKey: 'audit.check.security_updates.threshold' },
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
    penalty += input.config.penalties[f.severity];
  }
  const score = Math.max(0, Math.min(100, 100 - penalty));
  findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.target.label.localeCompare(b.target.label),
  );
  return {
    score,
    labelKey: auditLabelKey(score, input.config.labelNominal, input.config.labelDegraded),
    findings,
    counts,
    checksTotal: CHECKS.length,
    checksPassed,
  };
}
