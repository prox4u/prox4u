import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MultiDashboardSnapshot, VmSummary } from '@prox4u/shared';
import type { Poller } from '../../core/poller.js';
import { AlarmEngine } from './engine.js';
import { NscaStore } from './store.js';

// Mock de l'envoi NSCA (pas de vrai daemon en test) — les trames sont capturées.
vi.mock('./nsca.js', () => ({
  sendNsca: vi.fn(async () => ({ ok: true, code: null, message: 'trame acceptée (mock)' })),
}));
import { sendNsca } from './nsca.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const sendNscaMock = sendNsca as unknown as { mock: { calls: unknown[][] } };
/** Trames envoyées (2ᵉ argument de sendNsca : `host\tsvc\tcode\toutput`). */
function framesSent(): string[] {
  return sendNscaMock.mock.calls.map((c) => String(c[1]));
}

/**
 * Engine v2 (GitHub #5) : hystérésis de sortie, durée minimale de firing
 * (suppression), auto-résolution (clear de l'ack). Les trames coulent TOUJOURS
 * aux transitions réelles — l'anti-flapping est au niveau de la machine à états.
 */
describe('AlarmEngine v2 (hystérésis / suppression / ack)', () => {
  let dir: string;
  let store: NscaStore;
  let engine: AlarmEngine;
  let vm: VmSummary;
  let vms: VmSummary[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-27T12:00:00Z'));
    dir = mkdtempSync(path.join(tmpdir(), 'nsca-engine-'));
    store = new NscaStore(path.join(dir, 'centreon-nsca.json'), logger);
    store.init();
    // Module actif, heartbeat/check hôte OFF (pas de trame périodique en test).
    store.setConfig({ enabled: true, okHeartbeatSeconds: 0, hostCheckSeconds: 0 });
    vm = { vmid: 100, name: 'vm-100', status: 'running', cpuPct: 10 } as unknown as VmSummary;
    vms = [vm];
    const multi = {
      endpoints: [{ id: 'e1', snapshot: { vms, nodes: [], cluster: { quorumState: null, qdevice: 'unknown' } } }],
    } as unknown as MultiDashboardSnapshot;
    const poller = { getMulti: () => multi } as unknown as Poller;
    engine = new AlarmEngine(store, poller, dir, logger, 3_600_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function createRule(over: Record<string, unknown> = {}) {
    return store.createRule({
      name: 'CPU test',
      target: { kind: 'vm', endpointId: 'e1', vmid: 100, label: 'vm-100' },
      metric: 'cpu_pct',
      operator: '>',
      threshold: 90,
      confirmSeconds: 0,
      severity: 'crit',
      pollerId: 'linux',
      centreonHost: 'vm-100',
      centreonService: 'Prox4u-Alarm-CPU',
      messageTemplate: '{{vm}} CPU {{value}}%',
      active: true,
      recoveryThreshold: 80,
      suppressSeconds: 0,
      acknowledgedAt: null,
      acknowledgedBy: null,
      provisionStatus: 'ok',
      provisionMessage: '',
      lastSendState: null,
      lastSendMessage: '',
      lastAlarmAt: null,
      lastOkSendAt: null,
      lastOutput: '',
      currentState: 'ok',
      ...over,
    });
  }

  async function tickWithCpu(v: number, advanceMs = 15_000) {
    vm.cpuPct = v;
    vi.advanceTimersByTime(advanceMs);
    await engine.tick();
  }

  it('anti-flapping : oscillation autour du seuil → 1 seule alarme (critère d\'acceptation)', async () => {
    const rule = createRule(); // seuil 90, récupération 80
    for (const v of [95, 88, 93, 87, 96, 85]) await tickWithCpu(v);
    expect(framesSent()).toHaveLength(1); // une seule trame (l'alarme initiale)
    expect(framesSent()[0]).toContain('vm-100\tProx4u-Alarm-CPU\t2\t'); // code CRITICAL
    expect(store.ruleById(rule.id)!.currentState).toBe('crit'); // toujours en alarme
  });

  it('récupération hystérésis : valeur ≤ seuil de récupération → trame code 0', async () => {
    const rule = createRule();
    await tickWithCpu(95);
    expect(framesSent()).toHaveLength(1);
    await tickWithCpu(85); // zone morte (80 < 85 < 90) → pas de récup
    expect(framesSent()).toHaveLength(1);
    await tickWithCpu(75); // ≤ 80 → récupération
    expect(framesSent()).toHaveLength(2);
    expect(framesSent()[1]).toContain('\t0\t'); // code OK
    expect(store.ruleById(rule.id)!.currentState).toBe('ok');
  });

  it('sans hystérésis (recoveryThreshold null) : la même oscillation fait boucler', async () => {
    const rule = createRule({ recoveryThreshold: null });
    for (const v of [95, 88, 93]) await tickWithCpu(v);
    // 95 → ALARME · 88 → RÉCUP (88 < 90) · 93 → ALARME → boucle
    expect(framesSent()).toHaveLength(3);
    expect(store.ruleById(rule.id)!.currentState).toBe('crit');
  });

  it('durée minimale de firing (suppressSeconds) : pas de récupération avant la durée', async () => {
    const rule = createRule({ suppressSeconds: 300 });
    await tickWithCpu(95); // ALARME à T0
    expect(framesSent()).toHaveLength(1);
    await tickWithCpu(75, 60_000); // T0+60 s < 300 s → pas de récup
    expect(framesSent()).toHaveLength(1);
    expect(store.ruleById(rule.id)!.currentState).toBe('crit');
    await tickWithCpu(75, 300_000); // T0+360 s ≥ 300 s → récupération
    expect(framesSent()).toHaveLength(2);
    expect(store.ruleById(rule.id)!.currentState).toBe('ok');
  });

  it('auto-résolution : la récupération réinitialise l\'ack', async () => {
    const rule = createRule();
    await tickWithCpu(95); // ALARME
    store.updateRule(rule.id, { acknowledgedAt: Date.now(), acknowledgedBy: 'alice' });
    await tickWithCpu(75); // RÉCUP
    const r = store.ruleById(rule.id)!;
    expect(r.currentState).toBe('ok');
    expect(r.acknowledgedAt).toBeNull();
    expect(r.acknowledgedBy).toBeNull();
  });

  it('valeur null (VM absente du snapshot) → pas de transition', async () => {
    const rule = createRule();
    vms.length = 0; // VM disparue du snapshot
    await engine.tick();
    expect(framesSent()).toHaveLength(0);
    expect(store.ruleById(rule.id)!.currentState).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Métriques capteurs (GitHub #4) — source InfluxDB raw (node-sensors),
// seuil effectif perso ≤ firmware, cycle alarme → récupération.
// ---------------------------------------------------------------------------

describe('AlarmEngine — règles capteurs (GitHub #4)', () => {
  let dir: string;
  let store: NscaStore;
  let engine: AlarmEngine;
  let sensorData: import('@prox4u/shared').SensorAlarmData;
  let thresholds: Record<string, number>;
  let sensorFetchCount = 0;

  beforeEach(() => {
    sensorFetchCount = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-27T12:00:00Z'));
    dir = mkdtempSync(path.join(tmpdir(), 'nsca-engine-sensor-'));
    store = new NscaStore(path.join(dir, 'centreon-nsca.json'), logger);
    store.init();
    store.setConfig({ enabled: true, okHeartbeatSeconds: 0, hostCheckSeconds: 0 });
    // Données capteurs : disque /dev/sda (SMART) + capteur amdgpu mem + unités.
    sensorData = {
      smart: [{ node: 'proxmox1', device: '/dev/sda', model: 'WDC', serialNo: null, healthOk: true, tempC: 35, powerOnHours: null, powerCycleCount: null, reallocatedSectors: null, pendingSectors: null, uncorrectableSectors: null, udmaCrcErrors: null, percentageUsed: null, availableSpare: null, criticalWarning: null, lastSeen: 1 }],
      sensors: [{ node: 'proxmox1', chip: 'amdgpu-pci-2300', feature: 'mem', tempInput: 70, tempCrit: 110, fanInput: null, inInput: null, lastSeen: 1 }],
      zfs: [],
      zfsPools: [{ node: 'proxmox1', arcHits: null, arcMisses: null, arcSize: null, arcCacheSize: null, poolName: 'rpool', poolState: 'ONLINE', poolSize: null, poolAllocated: null, poolFree: null, lastSeen: 1 }],
      failedUnits: [],
      units: [{ node: 'proxmox1', name: 'pve-firewall.service', active: 'active', sub: 'running', load: 'loaded', lastSeen: 1 }],
    };
    thresholds = {};
    const multi = {
      endpoints: [{ id: 'e1', snapshot: { vms: [], nodes: [{ node: 'proxmox1', online: true }], cluster: { quorumState: null, qdevice: 'unknown' } } }],
    } as unknown as MultiDashboardSnapshot;
    const poller = { getMulti: () => multi } as unknown as Poller;
    engine = new AlarmEngine(
      store,
      poller,
      dir,
      logger,
      3_600_000,
      async () => { sensorFetchCount += 1; return sensorData; },
      () => thresholds,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function createSensorRule(over: Record<string, unknown> = {}) {
    return store.createRule({
      name: 'SMART test',
      target: { kind: 'node', endpointId: 'e1', node: 'proxmox1', device: '/dev/sda', label: 'proxmox1 / /dev/sda' },
      metric: 'smart_temp_c',
      operator: '>',
      threshold: 80,
      confirmSeconds: 0,
      severity: 'crit',
      pollerId: 'linux',
      centreonHost: 'proxmox1',
      centreonService: 'Prox4u-Alarm-SMART-TEMP',
      messageTemplate: '{{vm}} SMART {{value}}°C (seuil {{threshold}})',
      active: true,
      recoveryThreshold: null,
      suppressSeconds: 0,
      acknowledgedAt: null,
      acknowledgedBy: null,
      provisionStatus: 'ok',
      provisionMessage: '',
      lastSendState: null,
      lastSendMessage: '',
      lastAlarmAt: null,
      lastOkSendAt: null,
      lastOutput: '',
      currentState: 'ok',
      ...over,
    });
  }

  it('cycle complet : température SMART > seuil → ALARME, puis < seuil → RÉCUP (critère d\'acceptation)', async () => {
    const rule = createSensorRule();
    sensorData.smart[0].tempC = 85; // > 80
    vi.advanceTimersByTime(15_000);
    await engine.tick();
    expect(framesSent()).toHaveLength(1);
    expect(framesSent()[0]).toContain('proxmox1\tProx4u-Alarm-SMART-TEMP\t2\t'); // CRITICAL
    expect(store.ruleById(rule.id)!.currentState).toBe('crit');
    sensorData.smart[0].tempC = 70; // < 80
    vi.advanceTimersByTime(15_000);
    await engine.tick();
    expect(framesSent()).toHaveLength(2);
    expect(framesSent()[1]).toContain('\t0\t'); // OK
    expect(store.ruleById(rule.id)!.currentState).toBe('ok');
  });

  it('smart_health : FAILED (0) avec op « = » seuil 0 → ALARME, PASSED (1) → RÉCUP', async () => {
    const rule = createSensorRule({
      name: 'SMART health',
      metric: 'smart_health',
      operator: '=',
      threshold: 0,
      centreonService: 'Prox4u-Alarm-SMART-HEALTH',
      messageTemplate: '{{vm}} SMART health = {{value}}',
    });
    sensorData.smart[0].healthOk = false;
    vi.advanceTimersByTime(15_000);
    await engine.tick();
    expect(framesSent()).toHaveLength(1);
    expect(framesSent()[0]).toContain('\t2\t');
    sensorData.smart[0].healthOk = true;
    vi.advanceTimersByTime(15_000);
    await engine.tick();
    expect(framesSent()).toHaveLength(2);
    expect(framesSent()[1]).toContain('\t0\t');
    expect(store.ruleById(rule.id)!.currentState).toBe('ok');
  });

  it('sensor_temp_c : le seuil EFFECTIF (perso ≤ firmware) prime sur le seuil de la règle', async () => {
    // Règle seuil 100, mais seuil perso = 85 → l'alarme suit le perso.
    const rule = createSensorRule({
      name: 'Sensor temp',
      metric: 'sensor_temp_c',
      threshold: 100,
      target: { kind: 'node', endpointId: 'e1', node: 'proxmox1', chip: 'amdgpu-pci-2300', feature: 'mem', label: 'proxmox1 / amdgpu-pci-2300/mem' },
      centreonService: 'Prox4u-Alarm-SENSOR-TEMP',
      messageTemplate: '{{vm}} {{metric}} {{value}} (seuil {{threshold}})',
    });
    thresholds['proxmox1/amdgpu-pci-2300/mem'] = 85;
    sensorData.sensors[0].tempInput = 90; // 85 < 90 < 100 → ALARME (seuil effectif 85)
    vi.advanceTimersByTime(15_000);
    await engine.tick();
    expect(framesSent()).toHaveLength(1);
    expect(framesSent()[0]).toContain('\t2\t');
    expect(framesSent()[0]).toContain('seuil 85'); // le message affiche le seuil EFFECTIF
    // sans seuil perso → seuil firmware (110) : 90 < 110 → pas d'alarme
    expect(store.ruleById(rule.id)!.currentState).toBe('crit');
    thresholds = {};
    sensorData.sensors[0].tempInput = 90;
    vi.advanceTimersByTime(15_000);
    await engine.tick(); // 90 < 110 → RÉCUP
    expect(framesSent()).toHaveLength(2);
    expect(framesSent()[1]).toContain('\t0\t');
  });

  it('systemd_unit_failed : unité échouée → ALARME, saine → RÉCUP ; unité inconnue → pas de transition (pas de faux OK)', async () => {
    const rule = createSensorRule({
      name: 'Unit systemd',
      metric: 'systemd_unit_failed',
      operator: '=',
      threshold: 0,
      target: { kind: 'node', endpointId: 'e1', node: 'proxmox1', unit: 'pve-firewall.service', label: 'proxmox1 / pve-firewall.service' },
      centreonService: 'Prox4u-Alarm-SYSTEMD-UNIT',
      messageTemplate: '{{vm}} unité {{metric}} = {{value}}',
    });
    // unité saine (connue, non échouée) → valeur 1 → pas d'alarme (op = 0)
    vi.advanceTimersByTime(15_000);
    await engine.tick();
    expect(framesSent()).toHaveLength(0);
    // unité échouée → valeur 0 → ALARME
    sensorData.failedUnits.push({ node: 'proxmox1', name: 'pve-firewall.service', active: 'failed', sub: 'failed', load: 'loaded', lastSeen: 1 });
    vi.advanceTimersByTime(15_000);
    await engine.tick();
    expect(framesSent()).toHaveLength(1);
    expect(framesSent()[0]).toContain('\t2\t');
    // unité saine de nouveau → RÉCUP
    sensorData.failedUnits.length = 0;
    vi.advanceTimersByTime(15_000);
    await engine.tick();
    expect(framesSent()).toHaveLength(2);
    expect(store.ruleById(rule.id)!.currentState).toBe('ok');
    // unité inconnue (agent down) → valeur null → pas de transition (reste ok)
    sensorData.units.length = 0;
    vi.advanceTimersByTime(15_000);
    await engine.tick();
    expect(framesSent()).toHaveLength(2);
    expect(store.ruleById(rule.id)!.currentState).toBe('ok');
  });

  it('zfs_pool_state : pool DEGRADED (0) → ALARME, ONLINE (1) → RÉCUP', async () => {
    const rule = createSensorRule({
      name: 'ZFS pool',
      metric: 'zfs_pool_state',
      operator: '=',
      threshold: 0,
      target: { kind: 'node', endpointId: 'e1', node: 'proxmox1', pool: 'rpool', label: 'proxmox1 / rpool' },
      centreonService: 'Prox4u-Alarm-ZFS-POOL',
      messageTemplate: '{{vm}} pool {{metric}} = {{value}}',
    });
    sensorData.zfsPools[0].poolState = 'DEGRADED';
    vi.advanceTimersByTime(15_000);
    await engine.tick();
    expect(framesSent()).toHaveLength(1);
    expect(framesSent()[0]).toContain('\t2\t');
    sensorData.zfsPools[0].poolState = 'ONLINE';
    vi.advanceTimersByTime(15_000);
    await engine.tick();
    expect(framesSent()).toHaveLength(2);
    expect(framesSent()[1]).toContain('\t0\t');
    expect(store.ruleById(rule.id)!.currentState).toBe('ok');
  });

  it('une seule lecture capteur par tick (partagée entre toutes les règles)', async () => {
    createSensorRule();
    createSensorRule({ name: 'SMART health', metric: 'smart_health', operator: '=', threshold: 0 });
    vi.advanceTimersByTime(15_000);
    await engine.tick();
    expect(sensorFetchCount).toBe(1); // 2 règles capteurs → 1 fetch
  });

  it('pas de règle capteur active → aucune lecture capteur', async () => {
    createSensorRule({ active: false });
    vi.advanceTimersByTime(15_000);
    await engine.tick();
    expect(sensorFetchCount).toBe(0);
  });
});
