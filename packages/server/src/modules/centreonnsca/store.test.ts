import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLLERS } from '@prox4u/shared';
import { NscaStore, seedNscaFile } from './store.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function rule(over: Partial<Parameters<NscaStore['createRule']>[0]> = {}) {
  return {
    name: 'r1',
    target: { kind: 'vm' as const, endpointId: 'e1', vmid: 100, label: 'vm-100' },
    metric: 'cpu_pct' as const,
    operator: '>' as const,
    threshold: 90,
    confirmSeconds: 300,
    severity: 'crit' as const,
    pollerId: 'linux',
    centreonHost: 'vm-100',
    centreonService: 'Prox4u-Alarm-CPU',
    messageTemplate: '{{vm}} {{value}}',
    active: true,
    recoveryThreshold: null,
    suppressSeconds: 0,
    acknowledgedAt: null,
    acknowledgedBy: null,
    provisionStatus: 'ok' as const,
    provisionMessage: '',
    lastSendState: null,
    lastSendMessage: '',
    lastAlarmAt: null,
    lastOkSendAt: null,
    lastOutput: '',
    currentState: 'ok' as const,
    ...over,
  };
}

describe('NscaStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nsca-store-'));
    file = path.join(dir, 'centreon-nsca.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function fresh(): NscaStore {
    const s = new NscaStore(file, logger);
    s.init();
    return s;
  }

  it('seed : module désactivé, pollers par défaut, aucune règle', () => {
    const s = fresh();
    expect(s.getConfig().enabled).toBe(false);
    expect(s.listPollers()).toEqual(DEFAULT_POLLERS.map((p) => ({ ...p })));
    expect(s.listRules()).toEqual([]);
    expect(s.stats()).toEqual({
      activeRules: 0, inactiveRules: 0, alarms24h: 0, provisionOk: 0, provisionError: 0, provisionPending: 0,
    });
  });

  it('recharge un fichier existant (persistance)', () => {
    const s1 = fresh();
    s1.createRule(rule());
    const s2 = fresh();
    expect(s2.listRules()).toHaveLength(1);
    expect(s2.listRules()[0].name).toBe('r1');
  });

  it('migration v2 : une règle sans champs hystérésis/suppression/ack reçoit les défauts (GitHub #5)', () => {
    const s1 = fresh();
    const r = s1.createRule(rule());
    // Simule un fichier écrit avant la v2 (champs absents).
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    delete raw.rules[0].recoveryThreshold;
    delete raw.rules[0].suppressSeconds;
    delete raw.rules[0].acknowledgedAt;
    delete raw.rules[0].acknowledgedBy;
    writeFileSync(file, JSON.stringify(raw, null, 2));
    const s2 = new NscaStore(file, logger);
    s2.init();
    const migrated = s2.ruleById(r.id)!;
    expect(migrated.recoveryThreshold).toBeNull();
    expect(migrated.suppressSeconds).toBe(0);
    expect(migrated.acknowledgedAt).toBeNull();
    expect(migrated.acknowledgedBy).toBeNull();
  });

  it('createRule génère un id + horodatage', () => {
    const s = fresh();
    const r = s.createRule(rule());
    expect(r.id).toMatch(/^rule_/);
    expect(r.createdAt).toBeTruthy();
    expect(s.ruleById(r.id)).toBeDefined();
  });

  it('updateRule modifie un champ, laisse les autres', () => {
    const s = fresh();
    const r = s.createRule(rule());
    const updated = s.updateRule(r.id, { active: false, threshold: 50 });
    expect(updated.active).toBe(false);
    expect(updated.threshold).toBe(50);
    expect(updated.name).toBe('r1');
  });

  it('deleteRule supprime (et lève si absent)', () => {
    const s = fresh();
    const r = s.createRule(rule());
    s.deleteRule(r.id);
    expect(s.listRules()).toHaveLength(0);
    expect(() => s.deleteRule('nope')).toThrow('rule-not-found');
  });

  it('setPollers normalise les ids (slug depuis le nom) et déduplique', () => {
    const s = fresh();
    s.setPollers([
      { id: '', name: 'Linux' },
      { id: '', name: 'Windows' },
      { id: '', name: 'Infra' },
      { id: '', name: 'Linux' }, // slug dupliqué → ignoré
    ]);
    const ids = s.listPollers().map((p) => p.id);
    expect(ids).toEqual(['linux', 'windows', 'infra']);
  });

  it('setPollers conserve l’IP (destination NSCA) et la nettoie', () => {
    const s = fresh();
    s.setPollers([
      { id: 'linux', name: 'Linux', ip: '192.168.1.50' },
      { id: 'windows', name: 'Windows', ip: '   ' }, // IP vide → omise
    ]);
    expect(s.pollerById('linux')!.ip).toBe('192.168.1.50');
    expect(s.pollerById('windows')!.ip).toBeUndefined();
  });

  it('upsertMapping crée puis met à jour (override)', () => {
    const s = fresh();
    s.upsertMapping({ endpointId: 'e1', vmid: 100, vmName: 'vm-100', centreonHost: 'a' });
    s.upsertMapping({ endpointId: 'e1', vmid: 100, vmName: 'vm-100', centreonHost: 'b' });
    expect(s.listMappings()).toHaveLength(1);
    expect(s.listMappings()[0].centreonHost).toBe('b');
  });

  it('stats compte les alarmes 24 h et les statuts de provisioning', () => {
    const s = fresh();
    s.createRule(rule());
    s.createRule(rule({ name: 'r2', active: false, provisionStatus: 'error' }));
    const r1 = s.listRules()[0];
    s.updateRule(r1.id, { lastAlarmAt: Date.now() }); // alarme récente
    const st = s.stats();
    expect(st.activeRules).toBe(1);
    expect(st.inactiveRules).toBe(1);
    expect(st.alarms24h).toBe(1);
    expect(st.provisionOk).toBe(1);
    expect(st.provisionError).toBe(1);
  });

  it('seedNscaFile est stable (version 1)', () => {
    expect(seedNscaFile().version).toBe(1);
  });

  it('secrets .env : prévalent sur les valeurs du JSON (getConfig merge)', () => {
    const s = new NscaStore(file, logger, { restToken: 'env-token', nscaPassword: 'env-nsca', clapiPassword: 'env-clapi' });
    s.init();
    s.setConfig({ restToken: 'json-token', clapiPassword: 'json-clapi' });
    s.setConfig({ nsca: { password: 'json-nsca' } });
    // getConfig applique la prévalence .env
    const c = s.getConfig();
    expect(c.restToken).toBe('env-token');
    expect(c.clapiPassword).toBe('env-clapi');
    expect(c.nsca.password).toBe('env-nsca');
    // les autres champs du JSON sont conservés
    expect(c.enabled).toBe(false);
    // le JSON stocké n'est PAS modifié par l'override (pas de persistance de l'env)
    const s2 = new NscaStore(file, logger);
    s2.init();
    expect(s2.getConfig().restToken).toBe('json-token');
    expect(s2.getConfig().nsca.password).toBe('json-nsca');
  });

  it('envSecretFlags : true seulement si le secret .env est renseigné', () => {
    const s = new NscaStore(file, logger, { restToken: 'tok', nscaPassword: '', clapiPassword: '' });
    s.init();
    expect(s.envSecretFlags()).toEqual({ restToken: true, nscaPassword: false, clapiPassword: false });
  });

  it('sans secrets .env : getConfig renvoie la config du JSON telle quelle', () => {
    const s = fresh();
    s.setConfig({ restToken: 'json-token' });
    expect(s.getConfig().restToken).toBe('json-token');
    expect(s.envSecretFlags()).toEqual({ restToken: false, nscaPassword: false, clapiPassword: false });
  });
});
