import { describe, expect, it } from 'vitest';
import {
  buildNscaFrame,
  buildNscaHostFrame,
  clapiDeleteCommand,
  clapiProvisionCommands,
  conditionMet,
  defaultServiceName,
  escapeNscaField,
  evaluateAlarm,
  evaluateAlarmHysteresis,
  METRIC_IDS,
  nscaCfgContent,
  nscaReturnCode,
  renderOutput,
  shellQuote,
  suggestCenteronHost,
  type MetricSample,
} from './centreon-nsca.js';

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
