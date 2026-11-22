import { describe, expect, it } from 'vitest';
import {
  AUDIT_PENALTIES,
  auditLabelKey,
  checkBridgeWithoutPorts,
  checkCpuHostType,
  checkMemoryOvercommit,
  checkNodeVersionMismatch,
  checkPrivilegedContainers,
  checkQemuWithoutAgent,
  checkThinPoolOverprovisioning,
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
  runAudit,
  DEFAULT_AUDIT_CONFIG,
  type AuditInput,
  type AuditSmartDisk,
} from './audit.js';
import { DEFAULT_OVERCOMMIT_CONFIG } from './overcommit.js';
import type {
  NodeHealth,
  StorageVolume,
  VmSummary,
} from './types.js';

const GB = 1024 ** 3;

// --- Fixtures -------------------------------------------------------------------

const node = (over: Partial<NodeHealth> = {}): NodeHealth => ({
  node: 'n1',
  online: true,
  siteId: null,
  cpuPct: 10,
  ramPct: 20,
  diskPct: 30,
  uptimeSec: 1000,
  severity: 'ok',
  cpus: 8,
  memUsedBytes: 20 * GB,
  memTotalBytes: 128 * GB,
  rootfsUsedBytes: 50 * GB,
  rootfsTotalBytes: 100 * GB,
  loadavg: [1, 1, 1],
  version: '9.1.1',
  cpuAllocCores: 4,
  ramAllocBytes: 100 * GB,
  ...over,
});

const vm = (over: Partial<VmSummary> = {}): VmSummary => ({
  vmid: 100,
  name: 'vm1',
  type: 'qemu',
  status: 'running',
  node: 'n1',
  cpuPct: 10,
  memBytes: 4 * GB,
  maxmemBytes: 8 * GB,
  diskBytes: 10 * GB,
  maxdiskBytes: 40 * GB,
  cpuAllocCores: 2,
  os: 'Linux',
  uptimeSec: 100,
  netInBps: 0,
  netOutBps: 0,
  diskReadBps: 0,
  diskWriteBps: 0,
  ipAddresses: ['10.0.0.10'],
  agentActive: null,
  ...over,
});

const volume = (over: Partial<StorageVolume> = {}): StorageVolume => ({
  storage: 'local-lvmthin',
  type: 'lvmthin',
  children: [],
  totalBytes: 100 * GB,
  usedBytes: 50 * GB,
  allocatedBytes: 60 * GB,
  thinCapable: true,
  hasDisks: true,
  ratio: 0.6,
  kind: 'overcommit',
  tone: 'ok',
  ...over,
});

const input = (over: Partial<AuditInput> = {}): AuditInput => ({
  endpointId: 'ep1',
  nodes: [],
  vms: [],
  storages: [],
  storageVolumes: [],
  bridges: [],
  bonds: [],
  replications: [],
  zfsArc: [],
  smartDisks: [],
  failedUnits: [],
  rebootPending: [],
  securityUpdates: [],
  overcommit: DEFAULT_OVERCOMMIT_CONFIG,
  config: DEFAULT_AUDIT_CONFIG,
  ...over,
});

// --- checkQemuWithoutAgent ------------------------------------------------------

describe('checkQemuWithoutAgent', () => {
  it('QEMU en marche + agent inactif (false) → 1 constat crit', () => {
    const f = checkQemuWithoutAgent(input({ vms: [vm({ agentActive: false })] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('crit');
    expect(f[0].check).toBe('guests.qemu_without_agent');
    expect(f[0].target.kind).toBe('vm');
    expect(f[0].target.vmid).toBe(100);
  });

  it('agent actif (true) → aucun constat', () => {
    expect(checkQemuWithoutAgent(input({ vms: [vm({ agentActive: true })] }))).toHaveLength(0);
  });

  it('agent inconnu (null, 1ers ticks) → aucun constat (pas de faux positif)', () => {
    expect(checkQemuWithoutAgent(input({ vms: [vm({ agentActive: null })] }))).toHaveLength(0);
  });

  it('QEMU arrêtée + agent inactif → aucun constat', () => {
    expect(checkQemuWithoutAgent(input({ vms: [vm({ status: 'stopped', agentActive: false })] }))).toHaveLength(0);
  });

  it('LXC + agent inactif → aucun constat (le check ne concerne que QEMU)', () => {
    expect(checkQemuWithoutAgent(input({ vms: [vm({ type: 'lxc', agentActive: false })] }))).toHaveLength(0);
  });
});

// --- checkPrivilegedContainers --------------------------------------------------

describe('checkPrivilegedContainers', () => {
  it('LXC privilégié (unprivileged=false) → 1 constat warn', () => {
    const f = checkPrivilegedContainers(input({ vms: [vm({ type: 'lxc', unprivileged: false })] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warn');
    expect(f[0].check).toBe('guests.privileged_containers');
  });

  it('LXC non privilégié (unprivileged=true) → aucun constat', () => {
    expect(checkPrivilegedContainers(input({ vms: [vm({ type: 'lxc', unprivileged: true })] }))).toHaveLength(0);
  });

  it('LXC config inconnue (unprivileged=undefined) → aucun constat', () => {
    expect(checkPrivilegedContainers(input({ vms: [vm({ type: 'lxc' })] }))).toHaveLength(0);
  });

  it('QEMU unprivileged=false → aucun constat (le check ne concerne que LXC)', () => {
    expect(checkPrivilegedContainers(input({ vms: [vm({ unprivileged: false })] }))).toHaveLength(0);
  });
});

// --- checkCpuHostType -----------------------------------------------------------

describe('checkCpuHostType', () => {
  it('QEMU sans cpu=host (cpuHost=false) → 1 constat info', () => {
    const f = checkCpuHostType(input({ vms: [vm({ cpuHost: false })] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('info');
    expect(f[0].check).toBe('guests.cpu_host_type');
  });

  it('QEMU cpu=host (cpuHost=true) → aucun constat', () => {
    expect(checkCpuHostType(input({ vms: [vm({ cpuHost: true })] }))).toHaveLength(0);
  });

  it('QEMU config inconnue (cpuHost=undefined) → aucun constat', () => {
    expect(checkCpuHostType(input({ vms: [vm()] }))).toHaveLength(0);
  });

  it('LXC cpuHost=false → aucun constat (le check ne concerne que QEMU)', () => {
    expect(checkCpuHostType(input({ vms: [vm({ type: 'lxc', cpuHost: false })] }))).toHaveLength(0);
  });
});

// --- checkBridgeWithoutPorts ----------------------------------------------------

describe('checkBridgeWithoutPorts', () => {
  it('pont sans port physique → 1 constat warn (cible nœud)', () => {
    const f = checkBridgeWithoutPorts(input({ bridges: [{ node: 'n1', name: 'vmbr9', ports: [] }] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warn');
    expect(f[0].check).toBe('network.bridge_without_ports');
    expect(f[0].target.kind).toBe('node');
    expect(f[0].params).toMatchObject({ node: 'n1', bridge: 'vmbr9' });
  });

  it('pont avec port physique → aucun constat', () => {
    expect(checkBridgeWithoutPorts(input({ bridges: [{ node: 'n1', name: 'vmbr0', ports: ['eth0'] }] }))).toHaveLength(0);
  });
});

// --- checkThinPoolOverprovisioning ----------------------------------------------

describe('checkThinPoolOverprovisioning', () => {
  it('pool thin tone=warn → 1 constat warn', () => {
    const f = checkThinPoolOverprovisioning(input({ storageVolumes: [volume({ tone: 'warn' })] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warn');
    expect(f[0].check).toBe('storage.thin_pool_overprovisioning');
    expect(f[0].target.kind).toBe('storage');
  });

  it('pool thin tone=crit → 1 constat crit', () => {
    const f = checkThinPoolOverprovisioning(input({ storageVolumes: [volume({ tone: 'crit' })] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('crit');
  });

  it('pool thin tone=ok → aucun constat', () => {
    expect(checkThinPoolOverprovisioning(input({ storageVolumes: [volume({ tone: 'ok' })] }))).toHaveLength(0);
  });

  it('volume non thin tone=warn → aucun constat', () => {
    expect(
      checkThinPoolOverprovisioning(input({ storageVolumes: [volume({ thinCapable: false, tone: 'warn' })] })),
    ).toHaveLength(0);
  });

  it('pool thin sans disque (hasDisks=false) → aucun constat', () => {
    expect(
      checkThinPoolOverprovisioning(input({ storageVolumes: [volume({ hasDisks: false, tone: 'warn' })] })),
    ).toHaveLength(0);
  });

  it('LUN parent + VG enfant : le VG enfant (thin, tone=warn) est détecté', () => {
    const lun = volume({
      storage: 'lun1',
      type: 'iscsi',
      thinCapable: false,
      tone: 'na',
      children: [volume({ storage: 'vg1', type: 'lvmthin', tone: 'warn' })],
    });
    const f = checkThinPoolOverprovisioning(input({ storageVolumes: [lun] }));
    expect(f).toHaveLength(1);
    expect(f[0].params).toMatchObject({ storage: 'vg1' });
  });
});

// --- checkMemoryOvercommit ------------------------------------------------------

describe('checkMemoryOvercommit', () => {
  // ratio = (ramAlloc + 0.10 * memTotal) / memTotal ; ram ok ≤1, warn ≤1.2, >1.2 crit
  it('RAM sous-allouée (ratio ok) → aucun constat', () => {
    // 100/128 + 0.10 = 0.881 → ok
    expect(checkMemoryOvercommit(input({ nodes: [node({ ramAllocBytes: 100 * GB })] }))).toHaveLength(0);
  });

  it('RAM sur-allouée (ratio warn) → 1 constat warn', () => {
    // 120/128 + 0.10 = 1.0375 → warn
    const f = checkMemoryOvercommit(input({ nodes: [node({ ramAllocBytes: 120 * GB })] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warn');
    expect(f[0].check).toBe('system.memory_overcommit');
    expect(f[0].target.kind).toBe('node');
  });

  it('RAM fortement sur-allouée (ratio crit) → 1 constat crit', () => {
    // 150/128 + 0.10 = 1.272 → crit
    const f = checkMemoryOvercommit(input({ nodes: [node({ ramAllocBytes: 150 * GB })] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('crit');
  });

  it('nœud hors ligne → aucun constat', () => {
    expect(checkMemoryOvercommit(input({ nodes: [node({ online: false, ramAllocBytes: 150 * GB })] }))).toHaveLength(0);
  });

  it('RAM totale inconnue (null) → aucun constat', () => {
    expect(checkMemoryOvercommit(input({ nodes: [node({ memTotalBytes: null, ramAllocBytes: 150 * GB })] }))).toHaveLength(0);
  });
});

// --- checkNodeVersionMismatch ---------------------------------------------------

describe('checkNodeVersionMismatch', () => {
  it('versions hétérogènes → 1 constat info (cible cluster)', () => {
    const f = checkNodeVersionMismatch(
      input({ nodes: [node({ node: 'n1', version: '9.1.1' }), node({ node: 'n2', version: '9.0.3' })] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('info');
    expect(f[0].check).toBe('system.node_version_mismatch');
    expect(f[0].target.kind).toBe('cluster');
  });

  it('versions homogènes → aucun constat', () => {
    expect(
      checkNodeVersionMismatch(input({ nodes: [node({ node: 'n1' }), node({ node: 'n2' })] })),
    ).toHaveLength(0);
  });

  it('nœud hors ligne ignoré (sa version ne compte pas)', () => {
    expect(
      checkNodeVersionMismatch(
        input({ nodes: [node({ node: 'n1', version: '9.1.1' }), node({ node: 'n2', online: false, version: '9.0.3' })] }),
      ),
    ).toHaveLength(0);
  });
});

// --- checkAutostart (Phase 2) ----------------------------------------------------

describe('checkAutostart', () => {
  it('N VMs sans autostart → 1 constat info agrégé (cible cluster)', () => {
    const f = checkAutostart(
      input({ vms: [vm({ vmid: 1, autostart: false }), vm({ vmid: 2, autostart: false }), vm({ vmid: 3, autostart: true })] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('info');
    expect(f[0].check).toBe('guests.autostart');
    expect(f[0].params).toMatchObject({ count: 2 });
    expect(f[0].target.kind).toBe('cluster');
  });

  it('toutes autostart=true (ou inconnu) → aucun constat', () => {
    expect(
      checkAutostart(input({ vms: [vm({ vmid: 1, autostart: true }), vm({ vmid: 2 })] })),
    ).toHaveLength(0);
  });

  it('désactivé (enabled=false) → aucun constat', () => {
    const cfg = { ...DEFAULT_AUDIT_CONFIG, checks: { ...DEFAULT_AUDIT_CONFIG.checks, 'guests.autostart': { enabled: false } } };
    expect(checkAutostart(input({ vms: [vm({ autostart: false })], config: cfg }))).toHaveLength(0);
  });
});

// --- checkStuckSnapshots (Phase 2) -----------------------------------------------

describe('checkStuckSnapshots', () => {
  it('snapshot le plus vieux > maxAgeDays → 1 constat warn par VM', () => {
    const f = checkStuckSnapshots(input({ vms: [vm({ vmid: 1, oldestSnapshotAgeDays: 10 }), vm({ vmid: 2, oldestSnapshotAgeDays: 3 })] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warn');
    expect(f[0].check).toBe('guests.stuck_snapshots');
    expect(f[0].params).toMatchObject({ days: 10 });
    expect(f[0].target.vmid).toBe(1);
  });

  it('snapshot jeune (≤ maxAgeDays) ou absent (null) → aucun constat', () => {
    expect(
      checkStuckSnapshots(input({ vms: [vm({ vmid: 1, oldestSnapshotAgeDays: 7 }), vm({ vmid: 2, oldestSnapshotAgeDays: null }), vm({ vmid: 3 })] })),
    ).toHaveLength(0);
  });

  it('seuil ajustable (maxAgeDays=2) → snapshot de 3 j flaggé', () => {
    const cfg = { ...DEFAULT_AUDIT_CONFIG, checks: { ...DEFAULT_AUDIT_CONFIG.checks, 'guests.stuck_snapshots': { enabled: true, maxAgeDays: 2 } } };
    expect(checkStuckSnapshots(input({ vms: [vm({ oldestSnapshotAgeDays: 3 })], config: cfg }))).toHaveLength(1);
  });
});

// --- checkReplicationState (Phase 2) ---------------------------------------------

describe('checkReplicationState', () => {
  it('jamais abouti (lastEndAgeHours=null) → constat « never »', () => {
    const f = checkReplicationState(input({ replications: [{ vmid: 1, node: 'n1', name: 'vm1', lastResult: null, lastEndAgeHours: null }] }));
    expect(f).toHaveLength(1);
    expect(f[0].messageKey).toBe('audit.finding.replication_state.never');
    expect(f[0].severity).toBe('warn');
  });

  it('dernière en échec (lastResult≠ok) → constat « failed »', () => {
    const f = checkReplicationState(input({ replications: [{ vmid: 1, node: 'n1', name: 'vm1', lastResult: 'error', lastEndAgeHours: 2 }] }));
    expect(f).toHaveLength(1);
    expect(f[0].messageKey).toBe('audit.finding.replication_state.failed');
    expect(f[0].params).toMatchObject({ hours: 2 });
  });

  it('ok mais obsolète (> maxStalenessHours) → constat « stale »', () => {
    const f = checkReplicationState(input({ replications: [{ vmid: 1, node: 'n1', name: 'vm1', lastResult: 'ok', lastEndAgeHours: 30 }] }));
    expect(f).toHaveLength(1);
    expect(f[0].messageKey).toBe('audit.finding.replication_state.stale');
  });

  it('ok et récente (≤ maxStalenessHours) → aucun constat', () => {
    expect(
      checkReplicationState(input({ replications: [{ vmid: 1, node: 'n1', name: 'vm1', lastResult: 'ok', lastEndAgeHours: 2 }] })),
    ).toHaveLength(0);
  });

  it('aucun job → aucun constat', () => {
    expect(checkReplicationState(input({}))).toHaveLength(0);
  });
});

// --- checkBondMembers (Phase 2) ---------------------------------------------------

describe('checkBondMembers', () => {
  it('bond à 1 esclave (< minMembers) → 1 constat warn', () => {
    const f = checkBondMembers(input({ bonds: [{ node: 'n1', name: 'bond0', slaves: ['eth0'] }] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warn');
    expect(f[0].check).toBe('network.bond_members');
    expect(f[0].params).toMatchObject({ members: 1 });
  });

  it('bond à 2 esclaves (≥ minMembers) → aucun constat', () => {
    expect(checkBondMembers(input({ bonds: [{ node: 'n1', name: 'bond0', slaves: ['eth0', 'eth1'] }] }))).toHaveLength(0);
  });

  it('aucun bond → aucun constat', () => {
    expect(checkBondMembers(input({}))).toHaveLength(0);
  });
});

// --- checkZfsArcMax (Phase 2) -----------------------------------------------------

describe('checkZfsArcMax', () => {
  it('ARC max > maxPctOfRam % de la RAM → 1 constat warn', () => {
    // 100 Go d'ARC max sur 100 Go de RAM = 100 % > 75 %
    const f = checkZfsArcMax(input({ zfsArc: [{ node: 'n1', arcMaxBytes: 100 * GB, memTotalBytes: 100 * GB }] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warn');
    expect(f[0].check).toBe('system.zfs_arc_max');
    expect(f[0].params).toMatchObject({ pct: 100, threshold: 75 });
  });

  it('ARC max ≤ maxPctOfRam % (50 %) → aucun constat', () => {
    expect(checkZfsArcMax(input({ zfsArc: [{ node: 'n1', arcMaxBytes: 50 * GB, memTotalBytes: 100 * GB }] }))).toHaveLength(0);
  });

  it('pas de données ZFS (RAM 0 / ARC 0) → aucun constat', () => {
    expect(checkZfsArcMax(input({ zfsArc: [{ node: 'n1', arcMaxBytes: 0, memTotalBytes: 100 * GB }] }))).toHaveLength(0);
  });
});

// --- checkDiskErrors -------------------------------------------------------------

const disk = (over: Partial<AuditSmartDisk> = {}): AuditSmartDisk => ({
  node: 'n1',
  device: 'sda',
  model: 'TOSHIBA MN10ADA800S',
  healthOk: true,
  reallocatedSectors: 0,
  pendingSectors: 0,
  uncorrectableSectors: 0,
  udmaCrcErrors: 0,
  percentageUsed: null,
  ...over,
});

describe('checkDiskErrors', () => {
  it('healthOk=false → 1 constat crit (cible nœud)', () => {
    const f = checkDiskErrors(input({ smartDisks: [disk({ healthOk: false })] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('crit');
    expect(f[0].check).toBe('disks.disk_errors');
    expect(f[0].target.kind).toBe('node');
    expect(f[0].params).toMatchObject({ node: 'n1', device: 'sda' });
  });

  it('secteurs réalloués > 0 → 1 constat crit', () => {
    expect(checkDiskErrors(input({ smartDisks: [disk({ reallocatedSectors: 12 })] }))).toHaveLength(1);
  });

  it('erreurs CRC > 0 → 1 constat crit', () => {
    expect(checkDiskErrors(input({ smartDisks: [disk({ udmaCrcErrors: 3 })] }))).toHaveLength(1);
  });

  it('disque sain (healthOk=true, secteurs 0) → aucun constat', () => {
    expect(checkDiskErrors(input({ smartDisks: [disk()] }))).toHaveLength(0);
  });

  it('healthOk=null (pas de SMART) + secteurs null → aucun constat (pas de faux positif)', () => {
    expect(
      checkDiskErrors(
        input({
          smartDisks: [
            disk({ healthOk: null, reallocatedSectors: null, pendingSectors: null, uncorrectableSectors: null, udmaCrcErrors: null }),
          ],
        }),
      ),
    ).toHaveLength(0);
  });

  it('2 disques en erreur → 2 constats', () => {
    expect(checkDiskErrors(input({ smartDisks: [disk({ device: 'sda', healthOk: false }), disk({ device: 'sdb', pendingSectors: 5 })] }))).toHaveLength(2);
  });
});

// --- checkDiskServiceLife --------------------------------------------------------

describe('checkDiskServiceLife', () => {
  it('usure ≥ critPct (95 % ≥ 90) → 1 constat crit', () => {
    const f = checkDiskServiceLife(input({ smartDisks: [disk({ device: 'nvme0n1', percentageUsed: 95 })] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('crit');
    expect(f[0].check).toBe('disks.disk_service_life');
    expect(f[0].params).toMatchObject({ device: 'nvme0n1', pct: 95 });
  });

  it('usure ≥ warnPct (85 % ≥ 80) → 1 constat warn', () => {
    const f = checkDiskServiceLife(input({ smartDisks: [disk({ device: 'nvme0n1', percentageUsed: 85 })] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warn');
  });

  it('usure < warnPct (50 %) → aucun constat', () => {
    expect(checkDiskServiceLife(input({ smartDisks: [disk({ device: 'nvme0n1', percentageUsed: 50 })] }))).toHaveLength(0);
  });

  it('percentageUsed=null (pas de NVMe) → aucun constat', () => {
    expect(checkDiskServiceLife(input({ smartDisks: [disk({ percentageUsed: null })] }))).toHaveLength(0);
  });

  it('seuils custom (warnPct 50 / critPct 60) → 55 % = warn, 65 % = crit', () => {
    const cfg = { ...DEFAULT_AUDIT_CONFIG, checks: { ...DEFAULT_AUDIT_CONFIG.checks, 'disks.disk_service_life': { enabled: true, warnPct: 50, critPct: 60 } } };
    expect(checkDiskServiceLife(input({ smartDisks: [disk({ percentageUsed: 55 })], config: cfg }))[0].severity).toBe('warn');
    expect(checkDiskServiceLife(input({ smartDisks: [disk({ percentageUsed: 65 })], config: cfg }))[0].severity).toBe('crit');
  });
});

// --- checkFailedUnits ------------------------------------------------------------

describe('checkFailedUnits', () => {
  it('1 unité en échec → 1 constat warn (cible nœud)', () => {
    const f = checkFailedUnits(input({ failedUnits: [{ node: 'n1', name: 'openipmi.service' }] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warn');
    expect(f[0].check).toBe('system.failed_units');
    expect(f[0].target.kind).toBe('node');
    expect(f[0].params).toMatchObject({ node: 'n1', unit: 'openipmi.service' });
  });

  it('aucune unité en échec → aucun constat', () => {
    expect(checkFailedUnits(input({ failedUnits: [] }))).toHaveLength(0);
  });

  it('2 unités en échec (2 nœuds) → 2 constats', () => {
    expect(checkFailedUnits(input({ failedUnits: [{ node: 'n1', name: 'a.service' }, { node: 'n2', name: 'b.service' }] }))).toHaveLength(2);
  });
});

// --- checkPendingReboot ----------------------------------------------------------

describe('checkPendingReboot', () => {
  it('1 nœud en attente → 1 constat info (cible nœud)', () => {
    const f = checkPendingReboot(input({ rebootPending: [{ node: 'n1' }] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('info');
    expect(f[0].check).toBe('system.pending_reboot');
    expect(f[0].target.kind).toBe('node');
    expect(f[0].params).toMatchObject({ node: 'n1' });
  });

  it('aucun nœud en attente → aucun constat', () => {
    expect(checkPendingReboot(input({ rebootPending: [] }))).toHaveLength(0);
  });
});

// --- checkSecurityUpdates --------------------------------------------------------

describe('checkSecurityUpdates', () => {
  it('count ≥ warnCount (10 ≥ 5) → 1 constat info', () => {
    const f = checkSecurityUpdates(input({ securityUpdates: [{ node: 'n1', count: 10 }] }));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('info');
    expect(f[0].check).toBe('system.security_updates');
    expect(f[0].params).toMatchObject({ node: 'n1', count: 10, threshold: 5 });
  });

  it('count < warnCount (3 < 5) → aucun constat', () => {
    expect(checkSecurityUpdates(input({ securityUpdates: [{ node: 'n1', count: 3 }] }))).toHaveLength(0);
  });

  it('count = 0 → aucun constat', () => {
    expect(checkSecurityUpdates(input({ securityUpdates: [{ node: 'n1', count: 0 }] }))).toHaveLength(0);
  });

  it('seuil custom (warnCount 2) → 2 = info', () => {
    const cfg = { ...DEFAULT_AUDIT_CONFIG, checks: { ...DEFAULT_AUDIT_CONFIG.checks, 'system.security_updates': { enabled: true, warnCount: 2 } } };
    expect(checkSecurityUpdates(input({ securityUpdates: [{ node: 'n1', count: 2 }], config: cfg }))).toHaveLength(1);
  });
});

// --- runAudit (score + tri + compteurs) -----------------------------------------

describe('runAudit', () => {
  it('aucun constat → score 100, label conforme, tous les checks passés', () => {
    const r = runAudit(input({ nodes: [node()], vms: [vm({ agentActive: true })] }));
    expect(r.score).toBe(100);
    expect(r.labelKey).toBe('audit.label.compliant');
    expect(r.findings).toHaveLength(0);
    expect(r.checksPassed).toBe(r.checksTotal);
  });

  it('score = 100 − Σ pénalités (crit −10, warn −5, info −1)', () => {
    // 1 crit (qemu sans agent) + 1 warn (LXC privilégié) + 1 info (cpu != host)
    const r = runAudit(
      input({
        vms: [
          vm({ vmid: 1, agentActive: false }), // crit
          vm({ vmid: 2, type: 'lxc', unprivileged: false }), // warn
          vm({ vmid: 3, cpuHost: false }), // info
        ],
      }),
    );
    expect(r.counts).toMatchObject({ crit: 1, warn: 1, info: 1 });
    expect(r.score).toBe(100 - (AUDIT_PENALTIES.crit + AUDIT_PENALTIES.warn + AUDIT_PENALTIES.info));
  });

  it('score borné à 0 (beaucoup de constats critiques)', () => {
    const vms = Array.from({ length: 15 }, (_, i) => vm({ vmid: i, agentActive: false })); // 15 crit = −150
    const r = runAudit(input({ vms }));
    expect(r.score).toBe(0);
    expect(r.labelKey).toBe('audit.label.toReview');
  });

  it('constats triés par sévérité (crit → warn → info)', () => {
    const r = runAudit(
      input({
        vms: [
          vm({ vmid: 3, cpuHost: false }), // info
          vm({ vmid: 2, type: 'lxc', unprivileged: false }), // warn
          vm({ vmid: 1, agentActive: false }), // crit
        ],
      }),
    );
    expect(r.findings.map((f) => f.severity)).toEqual(['crit', 'warn', 'info']);
  });

  it('checksPassed décompte les checks sans constat', () => {
    // 1 seul check échoue (qemu sans agent) → checksPassed = total − 1
    const r = runAudit(input({ vms: [vm({ agentActive: false })] }));
    expect(r.checksPassed).toBe(r.checksTotal - 1);
  });
});

// --- auditLabelKey --------------------------------------------------------------

describe('auditLabelKey', () => {
  it('≥80 conforme · 50–79 à améliorer · <50 à revoir', () => {
    expect(auditLabelKey(100)).toBe('audit.label.compliant');
    expect(auditLabelKey(80)).toBe('audit.label.compliant');
    expect(auditLabelKey(79)).toBe('audit.label.toImprove');
    expect(auditLabelKey(50)).toBe('audit.label.toImprove');
    expect(auditLabelKey(49)).toBe('audit.label.toReview');
    expect(auditLabelKey(0)).toBe('audit.label.toReview');
  });
});
