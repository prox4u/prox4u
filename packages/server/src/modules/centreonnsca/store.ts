import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_POLLERS,
  defaultCenteronConfig,
  type AlarmRule,
  type AlarmStats,
  type CentreonConfig,
  type CentreonNscaFile,
  type CentreonPoller,
  type VmMapping,
} from '@prox4u/shared';

/**
 * Stockage du module Alarmes & Checks NSCA : un seul fichier
 * data/centreon-nsca.json (gitignoré, chmod 600), cache en mémoire +
 * écriture atomique (tmp → rename). Mêmes garanties que data/auth.json.
 *
 * Le mot de passe CLAPI / NSCA y est stocké en clair (fichier chmod 600,
 * gitignoré) mais N'EST JAMAIS loggué ni renvoyé en clair par l'API
 * (masqué côté routes).
 */

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Fichier initial : module désactivé, pollers par défaut, aucune règle. */
export function seedNscaFile(): CentreonNscaFile {
  return {
    version: 1,
    config: defaultCenteronConfig(),
    pollers: DEFAULT_POLLERS.map((p) => ({ ...p })),
    mappings: [],
    rules: [],
  };
}

/** Secrets Centreon fournis par le .env (CENTREON_*) — prévalent sur le JSON. */
export interface CentreonEnvSecrets {
  restToken: string;
  nscaPassword: string;
  clapiPassword: string;
}

export class NscaStore {
  private file: CentreonNscaFile | null = null;

  constructor(
    private filePath: string,
    private logger: Pick<Console, 'info' | 'warn' | 'error'>,
    private envSecrets: CentreonEnvSecrets = { restToken: '', nscaPassword: '', clapiPassword: '' },
  ) {}

  /** Charge (ou crée) le fichier. Fail-fast si corrompu. */
  init(): void {
    if (existsSync(this.filePath)) {
      let raw: string;
      try {
        raw = readFileSync(this.filePath, 'utf8');
      } catch (err) {
        throw new Error(`data/centreon-nsca.json illisible : ${(err as Error).message}`);
      }
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        throw new Error(`data/centreon-nsca.json invalide (JSON) : ${(err as Error).message}`);
      }
      const f = data as CentreonNscaFile;
      if (f.version !== 1 || !Array.isArray(f.rules) || !Array.isArray(f.pollers) || !f.config) {
        throw new Error('data/centreon-nsca.json invalide : structure inattendue (version/config/pollers/mappings/rules)');
      }
      this.file = f;
      this.logger.info(`nsca : ${f.rules.length} règle(s), ${f.pollers.length} poller(s) chargés depuis data/centreon-nsca.json`);
      return;
    }
    const seeded = seedNscaFile();
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.file = seeded;
    this.persist();
    this.logger.info('nsca : data/centreon-nsca.json créé (module désactivé, pollers par défaut, aucune règle)');
  }

  get data(): CentreonNscaFile {
    if (!this.file) throw new Error('NscaStore non initialisé');
    return this.file;
  }

  /** Écriture atomique : tmp + rename, permissions 600. */
  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file, null, 2));
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath);
  }

  // ---------- Configuration ----------

  /**
   * Config effective : le fichier data/centreon-nsca.json, avec les secrets du
   * .env (CENTREON_*) en PRÉVALENCE quand ils sont renseignés. Les secrets ne
   * transitent donc plus par l'UI — ils vivent dans le .env du serveur.
   */
  getConfig(): CentreonConfig {
    const c = this.data.config;
    const e = this.envSecrets;
    if (!e.restToken && !e.nscaPassword && !e.clapiPassword) return c;
    return {
      ...c,
      ...(e.restToken ? { restToken: e.restToken } : {}),
      ...(e.clapiPassword ? { clapiPassword: e.clapiPassword } : {}),
      nsca: { ...c.nsca, ...(e.nscaPassword ? { password: e.nscaPassword } : {}) },
    };
  }

  /** Quels secrets sont fournis par le .env (pour l'UI : « via .env »). */
  envSecretFlags(): { restToken: boolean; nscaPassword: boolean; clapiPassword: boolean } {
    return {
      restToken: this.envSecrets.restToken.length > 0,
      nscaPassword: this.envSecrets.nscaPassword.length > 0,
      clapiPassword: this.envSecrets.clapiPassword.length > 0,
    };
  }

  /**
   * Met à jour la config (les champs omis sont conservés). Le sous-objet `nsca`
   * est partiel : on ne remplace que les champs fournis (pas besoin d'envoyer
   * l'ensemble du bloc NSCA pour en changer un).
   */
  setConfig(patch: Omit<Partial<CentreonConfig>, 'nsca'> & { nsca?: Partial<CentreonConfig['nsca']> }): CentreonConfig {
    const c = this.data.config;
    if (patch.enabled !== undefined) c.enabled = patch.enabled;
    if (patch.transport !== undefined) c.transport = patch.transport;
    if (patch.clapiMode !== undefined) c.clapiMode = patch.clapiMode;
    if (patch.clapiHost !== undefined) c.clapiHost = patch.clapiHost;
    if (patch.clapiUser !== undefined) c.clapiUser = patch.clapiUser;
    if (patch.clapiPassword !== undefined) c.clapiPassword = patch.clapiPassword;
    if (patch.restUrl !== undefined) c.restUrl = patch.restUrl;
    if (patch.restUser !== undefined) c.restUser = patch.restUser;
    if (patch.restToken !== undefined) c.restToken = patch.restToken;
    if (patch.nsca) {
      if (patch.nsca.server !== undefined) c.nsca.server = patch.nsca.server;
      if (patch.nsca.port !== undefined) c.nsca.port = patch.nsca.port;
      if (patch.nsca.encrypt !== undefined) c.nsca.encrypt = patch.nsca.encrypt;
      if (patch.nsca.password !== undefined) c.nsca.password = patch.nsca.password;
    }
    this.persist();
    return c;
  }

  // ---------- Pollers ----------

  listPollers(): CentreonPoller[] {
    return this.data.pollers.map((p) => ({ ...p }));
  }

  pollerById(id: string): CentreonPoller | undefined {
    return this.data.pollers.find((p) => p.id === id);
  }

  /** Remplace la liste des pollers (page de config). Conserve l'IP (destination NSCA). */
  setPollers(pollers: CentreonPoller[]): void {
    const seen = new Set<string>();
    const next: CentreonPoller[] = [];
    for (const p of pollers) {
      const id = (p.id || p.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const ip = p.ip?.trim();
      next.push({ id, name: p.name.trim() || id, ...(ip ? { ip } : {}) });
    }
    this.data.pollers = next;
    this.persist();
  }

  // ---------- Mappings VM → hôte Centreon ----------

  listMappings(): VmMapping[] {
    return this.data.mappings.map((m) => ({ ...m }));
  }

  mappingFor(endpointId: string, vmid: number): VmMapping | undefined {
    return this.data.mappings.find((m) => m.endpointId === endpointId && m.vmid === vmid);
  }

  /** Crée ou met à jour le mapping d'une VM (override manuel du hôte). */
  upsertMapping(mapping: VmMapping): void {
    const existing = this.mappingFor(mapping.endpointId, mapping.vmid);
    if (existing) {
      existing.centreonHost = mapping.centreonHost;
      existing.vmName = mapping.vmName;
    } else {
      this.data.mappings.push({ ...mapping });
    }
    this.persist();
  }

  setMappings(mappings: VmMapping[]): void {
    this.data.mappings = mappings.map((m) => ({ ...m }));
    this.persist();
  }

  // ---------- Règles ----------

  listRules(): AlarmRule[] {
    return this.data.rules.map((r) => ({ ...r }));
  }

  ruleById(id: string): AlarmRule | undefined {
    return this.data.rules.find((r) => r.id === id);
  }

  /** Crée une règle (id généré). Retourne la règle persistée. */
  createRule(rule: Omit<AlarmRule, 'id' | 'createdAt' | 'updatedAt'>): AlarmRule {
    const ts = nowIso();
    const created: AlarmRule = { ...rule, id: newId('rule'), createdAt: ts, updatedAt: ts };
    this.data.rules.push(created);
    this.persist();
    return created;
  }

  /** Met à jour une règle (champs omis conservés). */
  updateRule(id: string, patch: Partial<Omit<AlarmRule, 'id' | 'createdAt'>>): AlarmRule {
    const rule = this.ruleById(id);
    if (!rule) throw new Error('rule-not-found');
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (rule as unknown as Record<string, unknown>)[k] = v;
    }
    rule.updatedAt = nowIso();
    this.persist();
    return rule;
  }

  deleteRule(id: string): void {
    const before = this.data.rules.length;
    this.data.rules = this.data.rules.filter((r) => r.id !== id);
    if (this.data.rules.length === before) throw new Error('rule-not-found');
    this.persist();
  }

  /** Statistiques d'indicateurs (Page 2). */
  stats(): AlarmStats {
    const now = Date.now();
    const dayMs = 86_400_000;
    const s: AlarmStats = {
      activeRules: 0,
      inactiveRules: 0,
      alarms24h: 0,
      provisionOk: 0,
      provisionError: 0,
      provisionPending: 0,
    };
    for (const r of this.data.rules) {
      if (r.active) s.activeRules += 1;
      else s.inactiveRules += 1;
      if (r.lastAlarmAt !== null && now - r.lastAlarmAt <= dayMs) s.alarms24h += 1;
      if (r.provisionStatus === 'ok') s.provisionOk += 1;
      else if (r.provisionStatus === 'error') s.provisionError += 1;
      else s.provisionPending += 1;
    }
    return s;
  }
}
