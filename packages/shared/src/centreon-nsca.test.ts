import { describe, expect, it } from 'vitest';
import {
  buildNscaFrame,
  buildNscaHostFrame,
  clapiDeleteCommand,
  clapiDeleteCommands,
  clapiProvisionCommands,
  conditionMet,
  defaultServiceName,
  escapeNscaField,
  evaluateAlarm,
  evaluateAlarmHysteresis,
  isSensorMetric,
  METRIC_IDS,
  nscaCfgContent,
  nscaReturnCode,
  renderOutput,
  resolveSensorThresholds,
  SENSOR_METRICS,
  sensorMetricValue,
  sensorTargetFields,
  shellQuote,
  suggestCenteronHost,
  type AlarmTarget,
  type MetricSample,
} from './centreon-nsca.js';
import type { FailedUnit, SensorAlarmData, SensorReading, SmartDevice, ZfsStatus } from './node-sensors.js';

describe('nscaReturnCode', () => {
  it('mappe sévérité → return code NSCA', () => {
    expect(nscaReturnCode('ok')).toBe(0);
    expect(nscaReturnCode('warn')).toBe(1);
    expect(nscaReturnCode('crit')).toBe(2);
    expect(nscaReturnCode('unknown')).toBe(3);
  });
});

describe('escapeNscaField', () => {
  it('échappe les points-virgules (séparateur Centreon)', () => {
    expect(escapeNscaField('host;service')).toBe('host\\;service');
  });
  it('échappe les retours à la ligne (fin de trame)', () => {
    expect(escapeNscaField('ligne1\nligne2')).toBe('ligne1\\nligne2');
    expect(escapeNscaField('ligne1\r\nligne2')).toBe('ligne1\\nligne2');
  });
  it('remplace les tabulations par des espaces', () => {
    expect(escapeNscaField('a\tb')).toBe('a b');
  });
  it("n'altère pas un champ propre", () => {
    expect(escapeNscaField('vm-web-01')).toBe('vm-web-01');
  });
});

describe('buildNscaFrame', () => {
  it('construit host\tservice\tcode\toutput\n', () => {
    expect(buildNscaFrame('vm-web-01', 'Prox4u-Alarm-CPU', 2, 'CPU > 90% (94%)')).toBe(
      'vm-web-01\tProx4u-Alarm-CPU\t2\tCPU > 90% (94%)\n',
    );
  });
  it('échappe les champs host/service contre l\'injection', () => {
    // Un `;` dans le nom d'hôte ne doit pas créer un champ parasite.
    expect(buildNscaFrame('h;ost', 'svc', 0, 'ok')).toBe('h\\;ost\tsvc\t0\tok\n');
  });
});

describe('buildNscaHostFrame', () => {
  it('construit host\tcode\toutput\n (3 champs, sans service — check hôte)', () => {
    expect(buildNscaHostFrame('ia-u24-01', 0, 'UP — VM running (Proxmox)')).toBe(
      'ia-u24-01\t0\tUP — VM running (Proxmox)\n',
    );
  });
  it('échappe le nom d\'hôte et l\'output contre l\'injection', () => {
    expect(buildNscaHostFrame('h;ost', 1, 'DOWN; arrêtée')).toBe('h\\;ost\t1\tDOWN\\; arrêtée\n');
  });
});

describe('renderOutput', () => {
  it('remplace les variables {{…}}', () => {
    expect(
      renderOutput('{{vm}} CPU {{value}}% (seuil {{threshold}}%)', {
        vm: 'vm-1',
        value: 94,
        threshold: 90,
      }),
    ).toBe('vm-1 CPU 94% (seuil 90%)');
  });
  it('garde les variables absentes (débogage)', () => {
    expect(renderOutput('{{vm}} {{missing}}', { vm: 'a' })).toBe('a {{missing}}');
  });
});

describe('defaultServiceName', () => {
  it('génère Prox4u-Alarm-<METRIQUE>', () => {
    expect(defaultServiceName('cpu_pct', '')).toBe('Prox4u-Alarm-CPU');
    expect(defaultServiceName('ram_pct', '')).toBe('Prox4u-Alarm-RAM');
    expect(defaultServiceName('disk_pct', '')).toBe('Prox4u-Alarm-DISK');
  });
  it("suffit le nom de règle (sanitised) en cas de collision de métrique", () => {
    expect(defaultServiceName('cpu_pct', 'CPU prod')).toBe('Prox4u-Alarm-CPU-CPU_prod');
  });
  it('cluster_quorum → Prox4u-Alarm-CLUSTER-QUORUM', () => {
    expect(defaultServiceName('cluster_quorum', '')).toBe('Prox4u-Alarm-CLUSTER-QUORUM');
  });
  it('cluster_qdevice → Prox4u-Alarm-CLUSTER-QDEVICE', () => {
    expect(defaultServiceName('cluster_qdevice', '')).toBe('Prox4u-Alarm-CLUSTER-QDEVICE');
  });
});

describe('METRIC_IDS', () => {
  it('inclut cluster_quorum (cible cluster)', () => {
    expect(METRIC_IDS).toContain('cluster_quorum');
  });
  it('inclut cluster_qdevice (cible cluster)', () => {
    expect(METRIC_IDS).toContain('cluster_qdevice');
  });
  it('inclut les 5 métriques capteurs (GitHub #4)', () => {
    for (const m of SENSOR_METRICS) expect(METRIC_IDS).toContain(m);
  });
});

describe('suggestCenteronHost', () => {
  it("utilise le hostname s'il existe, sinon le nom de la VM", () => {
    expect(suggestCenteronHost('VM-Web-01', 'web-01.local')).toBe('web-01.local');
    expect(suggestCenteronHost('VM Web 01')).toBe('vm-web-01');
  });
  it('retombe sur vm si vide', () => {
    expect(suggestCenteronHost('   ')).toBe('vm');
  });
});

describe('conditionMet', () => {
  it('compare selon l\'opérateur', () => {
    expect(conditionMet('>', 90, 94)).toBe(true);
    expect(conditionMet('>', 90, 90)).toBe(false);
    expect(conditionMet('<', 5, 3)).toBe(true);
    expect(conditionMet('=', 5, 5)).toBe(true);
    expect(conditionMet('!=', 5, 5)).toBe(false);
    expect(conditionMet('!=', 5, 6)).toBe(true);
  });
});

describe('evaluateAlarm', () => {
  const t0 = 1_000_000_000;
  it('ne déclenche pas sans échantillon', () => {
    const r = evaluateAlarm('>', 90, 300, [], t0);
    expect(r.firing).toBe(false);
    expect(r.value).toBeNull();
  });
  it('déclenche si toute la fenêtre dépasse le seuil', () => {
    const samples: MetricSample[] = [
      { t: t0 - 60_000, value: 95 },
      { t: t0 - 30_000, value: 96 },
      { t: t0, value: 94 },
    ];
    const r = evaluateAlarm('>', 90, 300, samples, t0);
    expect(r.firing).toBe(true);
    expect(r.value).toBe(94);
  });
  it('ne déclenche PAS si un échantillon de la fenêtre est sous le seuil', () => {
    const samples: MetricSample[] = [
      { t: t0 - 60_000, value: 95 },
      { t: t0 - 30_000, value: 50 }, // retour au nomimal dans la fenêtre
      { t: t0, value: 94 },
    ];
    const r = evaluateAlarm('>', 90, 300, samples, t0);
    expect(r.firing).toBe(false);
    expect(r.value).toBe(94);
  });
  it('ignore les échantillons hors fenêtre', () => {
    // Un seul échantillon récent sous le seuil, un ancien au-dessus :
    // fenêtre = 60 s, l'ancien (120 s) est hors fenêtre → pas de firing.
    const samples: MetricSample[] = [
      { t: t0 - 120_000, value: 99 },
      { t: t0, value: 10 },
    ];
    const r = evaluateAlarm('>', 90, 60, samples, t0);
    expect(r.firing).toBe(false);
  });
  it('valeur null si aucun échantillon dans la fenêtre', () => {
    const samples: MetricSample[] = [{ t: t0 - 600_000, value: 99 }];
    const r = evaluateAlarm('>', 90, 60, samples, t0);
    expect(r.firing).toBe(false);
    expect(r.value).toBe(99); // dernière valeur connue
  });
});

describe('evaluateAlarmHysteresis (moteur v2 — GitHub #5)', () => {
  const t0 = 1_000_000_000;
  it('aucun échantillon → trigger/recover false, value null', () => {
    const r = evaluateAlarmHysteresis('>', 90, 80, 300, [], t0);
    expect(r).toEqual({ trigger: false, recover: false, value: null });
  });
  it('aucun échantillon dans la fenêtre → trigger/recover false, value = dernière connue', () => {
    const r = evaluateAlarmHysteresis('>', 90, 80, 60, [{ t: t0 - 600_000, value: 99 }], t0);
    expect(r.trigger).toBe(false);
    expect(r.recover).toBe(false);
    expect(r.value).toBe(99);
  });
  it('trigger : toute la fenêtre au-dessus du seuil de déclenchement', () => {
    const samples: MetricSample[] = [
      { t: t0 - 60_000, value: 95 },
      { t: t0, value: 94 },
    ];
    const r = evaluateAlarmHysteresis('>', 90, 80, 300, samples, t0);
    expect(r.trigger).toBe(true);
    expect(r.recover).toBe(false);
  });
  it('pas de trigger si un échantillon de la fenêtre est sous le seuil', () => {
    const samples: MetricSample[] = [
      { t: t0 - 60_000, value: 95 },
      { t: t0, value: 85 },
    ];
    const r = evaluateAlarmHysteresis('>', 90, 80, 300, samples, t0);
    expect(r.trigger).toBe(false);
  });
  it('zone morte : valeur entre récupération et déclenchement → ni trigger ni recover', () => {
    const r = evaluateAlarmHysteresis('>', 90, 80, 0, [{ t: t0, value: 85 }], t0);
    expect(r.trigger).toBe(false); // 85 n'est pas > 90
    expect(r.recover).toBe(false); // 85 n'est pas ≤ 80
  });
  it('recover : valeur repassée du côté sûr du seuil de récupération', () => {
    const r = evaluateAlarmHysteresis('>', 90, 80, 0, [{ t: t0, value: 75 }], t0);
    expect(r.trigger).toBe(false);
    expect(r.recover).toBe(true); // 75 ≤ 80
  });
  it('recoveryThreshold null → comportement d\'origine (récupère dès que le seuil de déclenchement n\'est plus dépassé)', () => {
    // 85 < 90 → récupère (sans hystérésis), alors qu'avec récupération 80 ce serait zone morte.
    const r = evaluateAlarmHysteresis('>', 90, null, 0, [{ t: t0, value: 85 }], t0);
    expect(r.trigger).toBe(false);
    expect(r.recover).toBe(true);
  });
  it('opérateur « < » symétrique : déclenche <10, récupère ≥20', () => {
    expect(evaluateAlarmHysteresis('<', 10, 20, 0, [{ t: t0, value: 5 }], t0).trigger).toBe(true);
    expect(evaluateAlarmHysteresis('<', 10, 20, 0, [{ t: t0, value: 15 }], t0).recover).toBe(false); // zone morte
    expect(evaluateAlarmHysteresis('<', 10, 20, 0, [{ t: t0, value: 25 }], t0).recover).toBe(true);
  });
  it('anti-flapping : oscillation autour du seuil → 1 trigger, 0 recover (zone morte tient)', () => {
    // Oscillation 92/88 autour du seuil 90, récupération 80 : ni trigger ni recover
    // sur les creux (88 > 80) → la machine à états ne bascule qu'UNE fois.
    const seq = [95, 88, 93, 87, 96, 85];
    let triggers = 0;
    let recovers = 0;
    let firing = false;
    seq.forEach((v, i) => {
      const r = evaluateAlarmHysteresis('>', 90, 80, 0, [{ t: t0 + i * 15_000, value: v }], t0 + i * 15_000);
      if (r.trigger && !firing) { triggers += 1; firing = true; }
      else if (r.recover && firing) { recovers += 1; firing = false; }
    });
    expect(triggers).toBe(1);
    expect(recovers).toBe(0);
  });
  it('sans hystérésis, la même oscillation fait boucler (trigger/recover alternés)', () => {
    const seq = [95, 88, 93, 87, 96, 85];
    let transitions = 0;
    let firing = false;
    seq.forEach((v, i) => {
      const r = evaluateAlarmHysteresis('>', 90, null, 0, [{ t: t0 + i * 15_000, value: v }], t0 + i * 15_000);
      if (r.trigger && !firing) { transitions += 1; firing = true; }
      else if (r.recover && firing) { transitions += 1; firing = false; }
    });
    expect(transitions).toBeGreaterThan(2); // boucle alarme/récup
  });
});

describe('nscaCfgContent', () => {
  it('génère le fichier send_nsca.cfg (format NSCA : séparateur « = »)', () => {
    const cfg = nscaCfgContent({ server: 'central.example', port: 5668, encrypt: true, password: 'secret' });
    expect(cfg).toContain('server = central.example');
    expect(cfg).toContain('port = 5668');
    expect(cfg).toContain('encrypt = 1');
    expect(cfg).toContain('password = secret');
    expect(cfg).toContain('timeout = 15');
  });
});

describe('shellQuote', () => {
  it('entoure d\'un guillemet simple (tout est littéral)', () => {
    expect(shellQuote('vm-web-01')).toBe("'vm-web-01'");
    expect(shellQuote('a b c')).toBe("'a b c'");
    // métacaractères shell : restés littéraux, aucune interprétation possible
    expect(shellQuote('x";$(id)`rm`|&')).toBe("'x\";$(id)`rm`|&'");
  });
  it('échappe le guillemet simple interne', () => {
    expect(shellQuote("h'ost")).toBe("'h'\\''ost'");
  });
});

describe('clapiProvisionCommands', () => {
  it('produit la séquence add + setparam + génération + déploiement (args shell-quotés)', () => {
    const cmds = clapiProvisionCommands('vm-web-01', 'Prox4u-Alarm-CPU', 'Linux');
    expect(cmds).toEqual([
      "SERVICE -a add -v 'vm-web-01;Prox4u-Alarm-CPU'",
      "SERVICE -a setparam -v 'vm-web-01;Prox4u-Alarm-CPU;passive_checks_enabled;1'",
      "SERVICE -a setparam -v 'vm-web-01;Prox4u-Alarm-CPU;active_checks_enabled;0'",
      "SERVICE -a setparam -v 'vm-web-01;Prox4u-Alarm-CPU;is_volatile;1'",
      "SERVICE -a setparam -v 'vm-web-01;Prox4u-Alarm-CPU;max_check_attempts;1'",
      "SERVICE -a setparam -v 'vm-web-01;Prox4u-Alarm-CPU;check_command;check_dummy!0'",
      "POLLERGENERATE -v 'Linux'",
      "CFGMOVE -v 'Linux'",
    ]);
  });
  it('échappe les `;` dans les noms (convention Centreon \\;)', () => {
    const cmds = clapiProvisionCommands('h;ost', 'svc', 'Linux');
    expect(cmds[0]).toBe("SERVICE -a add -v 'h\\;ost;svc'");
  });
  it('neutralise l\'injection shell dans les noms (guillemet + $())', () => {
    const cmds = clapiProvisionCommands('x"$(id)"', 'svc', 'Linux');
    // tout le `-v` est un argument littéral : `$(id)` n'est pas interprété par le shell
    expect(cmds[0]).toBe("SERVICE -a add -v 'x\"$(id)\";svc'");
  });
});

describe('clapiDeleteCommand', () => {
  it('produit la commande de suppression (arg shell-quoté)', () => {
    expect(clapiDeleteCommand('vm-1', 'Prox4u-Alarm-CPU')).toBe(
      "SERVICE -a del -v 'vm-1;Prox4u-Alarm-CPU'",
    );
  });
});

describe('clapiDeleteCommands (GitHub #20)', () => {
  it('produit la séquence del + génération + déploiement (même fin que provision)', () => {
    const cmds = clapiDeleteCommands('vm-web-01', 'Prox4u-Alarm-CPU', 'Linux');
    expect(cmds).toEqual([
      "SERVICE -a del -v 'vm-web-01;Prox4u-Alarm-CPU'",
      "POLLERGENERATE -v 'Linux'",
      "CFGMOVE -v 'Linux'",
    ]);
  });
  it('échappe les `;` dans les noms (convention Centreon \\;)', () => {
    const cmds = clapiDeleteCommands('h;ost', 'svc', 'Linux');
    expect(cmds[0]).toBe("SERVICE -a del -v 'h\\;ost;svc'");
  });
});

// ---------------------------------------------------------------------------
// Métriques capteurs (source InfluxDB raw — module node-sensors, GitHub #4)
// ---------------------------------------------------------------------------

function smartDevice(over: Partial<SmartDevice> = {}): SmartDevice {
  return {
    node: 'proxmox1',
    device: '/dev/sda',
    model: 'WDC WDS500G2B0A',
    serialNo: 'SN123',
    healthOk: true,
    tempC: 35,
    powerOnHours: 1000,
    powerCycleCount: 10,
    reallocatedSectors: 0,
    pendingSectors: 0,
    uncorrectableSectors: 0,
    udmaCrcErrors: 0,
    percentageUsed: null,
    availableSpare: null,
    criticalWarning: null,
    lastSeen: 1_700_000_000,
    ...over,
  };
}

function sensorReading(over: Partial<SensorReading> = {}): SensorReading {
  return {
    node: 'proxmox1',
    chip: 'amdgpu-pci-2300',
    feature: 'mem',
    tempInput: 70,
    tempCrit: 110,
    fanInput: null,
    inInput: null,
    lastSeen: 1_700_000_000,
    ...over,
  };
}

function failedUnit(over: Partial<FailedUnit> = {}): FailedUnit {
  return {
    node: 'proxmox1',
    name: 'pve-firewall.service',
    active: 'failed',
    sub: 'failed',
    load: 'loaded',
    lastSeen: 1_700_000_000,
    ...over,
  };
}

function zfsPool(over: Partial<ZfsStatus> = {}): ZfsStatus {
  return {
    node: 'proxmox1',
    arcHits: null,
    arcMisses: null,
    arcSize: null,
    arcCacheSize: null,
    poolName: 'rpool',
    poolState: 'ONLINE',
    poolSize: null,
    poolAllocated: null,
    poolFree: null,
    lastSeen: 1_700_000_000,
    ...over,
  };
}

function sensorData(over: Partial<SensorAlarmData> = {}): SensorAlarmData {
  return {
    smart: [smartDevice()],
    sensors: [sensorReading()],
    zfs: [],
    zfsPools: [zfsPool()],
    failedUnits: [],
    units: [failedUnit({ active: 'active', sub: 'running' })],
    ...over,
  };
}

const nodeTarget = (over: Partial<AlarmTarget> = {}): AlarmTarget => ({
  kind: 'node',
  endpointId: 'e1',
  node: 'proxmox1',
  label: 'proxmox1',
  ...over,
});

describe('isSensorMetric / sensorTargetFields', () => {
  it('identifie les 5 métriques capteurs', () => {
    for (const m of SENSOR_METRICS) expect(isSensorMetric(m)).toBe(true);
    expect(isSensorMetric('cpu_pct')).toBe(false);
    expect(isSensorMetric('node_cpu_pct')).toBe(false);
    expect(isSensorMetric('cluster_quorum')).toBe(false);
  });
  it('liste les champs de cible requis par métrique', () => {
    expect(sensorTargetFields('smart_temp_c')).toEqual(['device']);
    expect(sensorTargetFields('smart_health')).toEqual(['device']);
    expect(sensorTargetFields('sensor_temp_c')).toEqual(['chip', 'feature']);
    expect(sensorTargetFields('systemd_unit_failed')).toEqual(['unit']);
    expect(sensorTargetFields('zfs_pool_state')).toEqual(['pool']);
    expect(sensorTargetFields('cpu_pct')).toEqual([]);
    expect(sensorTargetFields('node_online')).toEqual([]);
  });
});

describe('sensorMetricValue', () => {
  it('smart_temp_c : température du disque ciblé', () => {
    expect(sensorMetricValue('smart_temp_c', nodeTarget({ device: '/dev/sda' }), sensorData())).toBe(35);
  });
  it('smart_temp_c : 0 °C = pas de capteur → null (pas d\'échantillon)', () => {
    expect(sensorMetricValue('smart_temp_c', nodeTarget({ device: '/dev/sda' }), sensorData({ smart: [smartDevice({ tempC: 0 })] }))).toBeNull();
  });
  it('smart_temp_c : disque inconnu → null', () => {
    expect(sensorMetricValue('smart_temp_c', nodeTarget({ device: '/dev/sdb' }), sensorData())).toBeNull();
  });
  it('smart_health : 1 = PASSED, 0 = FAILED, null = inconnue (pas un échec)', () => {
    expect(sensorMetricValue('smart_health', nodeTarget({ device: '/dev/sda' }), sensorData())).toBe(1);
    expect(sensorMetricValue('smart_health', nodeTarget({ device: '/dev/sda' }), sensorData({ smart: [smartDevice({ healthOk: false })] }))).toBe(0);
    expect(sensorMetricValue('smart_health', nodeTarget({ device: '/dev/sda' }), sensorData({ smart: [smartDevice({ healthOk: null })] }))).toBeNull();
  });
  it('sensor_temp_c : température du capteur ciblé', () => {
    expect(sensorMetricValue('sensor_temp_c', nodeTarget({ chip: 'amdgpu-pci-2300', feature: 'mem' }), sensorData())).toBe(70);
  });
  it('sensor_temp_c : capteur inconnu ou sans lecture → null', () => {
    expect(sensorMetricValue('sensor_temp_c', nodeTarget({ chip: 'cpu-vid', feature: 'edge' }), sensorData())).toBeNull();
    expect(sensorMetricValue('sensor_temp_c', nodeTarget({ chip: 'amdgpu-pci-2300', feature: 'mem' }), sensorData({ sensors: [sensorReading({ tempInput: null })] }))).toBeNull();
  });
  it('systemd_unit_failed : 1 = saine (connue, non échouée)', () => {
    expect(sensorMetricValue('systemd_unit_failed', nodeTarget({ unit: 'pve-firewall.service' }), sensorData())).toBe(1);
  });
  it('systemd_unit_failed : 0 = échouée (présente dans failedUnits)', () => {
    const data = sensorData({ failedUnits: [failedUnit()] });
    expect(sensorMetricValue('systemd_unit_failed', nodeTarget({ unit: 'pve-firewall.service' }), data)).toBe(0);
  });
  it('systemd_unit_failed : unité inconnue → null (pas de faux OK — agent down / mauvais nom)', () => {
    expect(sensorMetricValue('systemd_unit_failed', nodeTarget({ unit: 'inconnue.service' }), sensorData())).toBeNull();
    // agent down : aucune unité connue
    expect(sensorMetricValue('systemd_unit_failed', nodeTarget({ unit: 'pve-firewall.service' }), sensorData({ units: [] }))).toBeNull();
  });
  it('zfs_pool_state : 1 = ONLINE, 0 = DEGRADED/OFFLINE, null = pool inconnue', () => {
    expect(sensorMetricValue('zfs_pool_state', nodeTarget({ pool: 'rpool' }), sensorData())).toBe(1);
    expect(sensorMetricValue('zfs_pool_state', nodeTarget({ pool: 'rpool' }), sensorData({ zfsPools: [zfsPool({ poolState: 'DEGRADED' })] }))).toBe(0);
    expect(sensorMetricValue('zfs_pool_state', nodeTarget({ pool: 'rpool' }), sensorData({ zfsPools: [zfsPool({ poolState: 'OFFLINE' })] }))).toBe(0);
    expect(sensorMetricValue('zfs_pool_state', nodeTarget({ pool: 'tank' }), sensorData())).toBeNull();
  });
  it('métrique non capteur → null (source snapshot, pas node-sensors)', () => {
    expect(sensorMetricValue('cpu_pct', nodeTarget({ device: '/dev/sda' }), sensorData())).toBeNull();
  });
});

describe('resolveSensorThresholds', () => {
  const target = nodeTarget({ chip: 'amdgpu-pci-2300', feature: 'mem' });
  it('sensor_temp_c : le seuil perso (≤ firmware) prime sur le seuil de la règle', () => {
    const data = sensorData(); // firmware 110
    const r = resolveSensorThresholds('sensor_temp_c', target, data, { 'proxmox1/amdgpu-pci-2300/mem': 85 }, { threshold: 100, recoveryThreshold: null, operator: '>' });
    expect(r.threshold).toBe(85);
  });
  it('sensor_temp_c : sans seuil perso → seuil firmware', () => {
    const data = sensorData(); // firmware 110
    const r = resolveSensorThresholds('sensor_temp_c', target, data, {}, { threshold: 100, recoveryThreshold: null, operator: '>' });
    expect(r.threshold).toBe(110);
  });
  it('sensor_temp_c : ni perso ni firmware (ni données) → seuil de la règle (repli)', () => {
    expect(resolveSensorThresholds('sensor_temp_c', target, null, {}, { threshold: 80, recoveryThreshold: null, operator: '>' }).threshold).toBe(80);
    expect(resolveSensorThresholds('sensor_temp_c', target, sensorData({ sensors: [] }), {}, { threshold: 80, recoveryThreshold: null, operator: '>' }).threshold).toBe(80);
    expect(resolveSensorThresholds('sensor_temp_c', target, sensorData({ sensors: [sensorReading({ tempCrit: null })] }), {}, { threshold: 80, recoveryThreshold: null, operator: '>' }).threshold).toBe(80);
  });
  it('les autres métriques capteurs : seuil de la règle inchangé', () => {
    const data = sensorData();
    expect(resolveSensorThresholds('smart_temp_c', nodeTarget({ device: '/dev/sda' }), data, { 'proxmox1/amdgpu-pci-2300/mem': 85 }, { threshold: 50, recoveryThreshold: null, operator: '>' }).threshold).toBe(50);
    expect(resolveSensorThresholds('systemd_unit_failed', nodeTarget({ unit: 'x.service' }), data, {}, { threshold: 0, recoveryThreshold: null, operator: '=' }).threshold).toBe(0);
  });
  it('cohérence hystérésis : récupération du mauvais côté du seuil effectif → repli sur le seuil de déclenchement', () => {
    // règle créée avec seuil 100 / récup 90 ; le seuil perso passe à 85 →
    // 90 ≥ 85 : la zone morte s\'inverserait → repli (pas de zone morte).
    const data = sensorData();
    const r = resolveSensorThresholds('sensor_temp_c', target, data, { 'proxmox1/amdgpu-pci-2300/mem': 85 }, { threshold: 100, recoveryThreshold: 90, operator: '>' });
    expect(r).toEqual({ threshold: 85, recoveryThreshold: 85 });
  });
  it('cohérence hystérésis : récupération cohérente → conservée (op « > »)', () => {
    const data = sensorData();
    const r = resolveSensorThresholds('sensor_temp_c', target, data, { 'proxmox1/amdgpu-pci-2300/mem': 85 }, { threshold: 100, recoveryThreshold: 75, operator: '>' });
    expect(r).toEqual({ threshold: 85, recoveryThreshold: 75 });
  });
  it('cohérence hystérésis : op « < » symétrique (récup doit être > seuil)', () => {
    // déclenche <1, récupère ≥2 → cohérent → conservée
    const ok = resolveSensorThresholds('smart_health', nodeTarget({ device: '/dev/sda' }), null, {}, { threshold: 1, recoveryThreshold: 2, operator: '<' });
    expect(ok.recoveryThreshold).toBe(2);
    // 0 ≤ 1 → du mauvais côté → repli sur le seuil de déclenchement
    const bad = resolveSensorThresholds('smart_health', nodeTarget({ device: '/dev/sda' }), null, {}, { threshold: 1, recoveryThreshold: 0, operator: '<' });
    expect(bad.recoveryThreshold).toBe(1);
  });
});
