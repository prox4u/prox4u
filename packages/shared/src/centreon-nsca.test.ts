import { describe, expect, it } from 'vitest';
import {
  buildNscaFrame,
  clapiDeleteCommand,
  clapiProvisionCommands,
  conditionMet,
  defaultServiceName,
  escapeNscaField,
  evaluateAlarm,
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
