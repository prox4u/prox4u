import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  DEFAULT_AUDIT_CONFIG,
  DEFAULT_HEALTH_CONFIG,
  DEFAULT_OVERCOMMIT_CONFIG,
  type AuditConfig,
  type HealthConfig,
  type OvercommitConfig,
} from '@prox4u/shared';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Charge .env depuis la racine du repo (ou cwd) si présent. */
function loadEnvFile(): void {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(here, '../../../../.env'), // racine du repo (src/core ou dist/core)
  ];
  for (const file of candidates) {
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file);
        return;
      } catch {
        // on tente le suivant
      }
    }
  }
}

loadEnvFile();

const envSchema = z.object({
  // Rétro-compat : utilisé uniquement si clusters.json est absent (1 endpoint)
  PVE_URL: z.string().url().default('https://127.0.0.1:8006'),
  PVE_USER: z.string().min(1).default('monitoring@pve'),
  PVE_TOKEN_ID: z.string().min(1).default('token'),
  PVE_TOKEN_VALUE: z.string().min(1).default(''),
  TLS_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).default('false'),
  MOCK: z.enum(['0', '1']).default('0'),
  MOCK_SCENARIO: z.enum(['nominal', 'degraded', 'critical']).default('nominal'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  // TLS application (si les deux sont vides : HTTP clair)
  TLS_KEY: z.string().default(''),
  TLS_CERT: z.string().default(''),
  INFLUX_URL: z.string().url().default('http://localhost:8181'),
  INFLUX_TOKEN: z.string().default(''),
  INFLUX_RAW_DB: z.string().min(1).default('raw'),
  INFLUX_AGG_DB: z.string().min(1).default('consolidated'),
  // Base RRD native Proxmox VE (7 tables : ballooninfo, blockstat, cpustat, memory,
  // nics, proxmox-support, system). Déjà présente chez les clients → on pointe dessus.
  INFLUX_RRD_DB: z.string().min(1).default('proxmox'),
  // Certificat auto-signé InfluxDB à faire confiance (fetch app → InfluxDB)
  INFLUX_CA_CERT: z.string().default(''),
  // --- Limites InfluxDB 3 Core (plan-limites-influxdb3.md) ---
  // File d'écriture bornée (lignes) : doit tenir un pic de tick (500 VMs ≈ 1 450 lignes)
  INFLUX_QUEUE_MAX: z.coerce.number().int().min(100).max(1_000_000).default(20_000),
  // Taille de lot par requête write_lp (lignes) : plus gros = moins de requêtes HTTP
  INFLUX_FLUSH_MAX_LINES: z.coerce.number().int().min(10).max(10_000).default(1_000),
  // Lots consécutifs en échec avant dead-letter (évite la file qui gonfle si InfluxDB est tombé)
  INFLUX_FLUSH_MAX_RETRIES: z.coerce.number().int().min(1).max(50).default(3),
  // Requêtes long terme : taille de tranche (jours) pour querySqlChunked (< file limit)
  INFLUX_QUERY_CHUNK_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  // --query-file-limit du service InfluxDB (défaut 10 000 = docker-compose) — sert l'estimation
  INFLUX_QUERY_FILE_LIMIT: z.coerce.number().int().min(100).max(1_000_000).default(10_000),
  // Archivage consolidated → CSV (P5) : intervalle (h), âge minimal archivé (j), dossier
  INFLUX_ARCHIVE_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(6),
  INFLUX_ARCHIVE_AGE_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  INFLUX_ARCHIVE_DIR: z.string().default('data/influx-archive'),
  // Groupes autorisés à lancer les ACTIONS InfluxDB (POST /api/influxdb/actions/*) :
  // noms de groupes séparés par des virgules. Le rôle admin passe toujours.
  // Vide = seules les actions du rôle admin (aucun groupe).
  INFLUX_ACTION_GROUPS: z.string().default('Administrateurs,Exploitations'),
  // Durée de vie des sessions d'authentification (heures, max 30 jours)
  AUTH_SESSION_TTL_HOURS: z.coerce.number().positive().max(720).default(12),
});

export interface InfluxConfig {
  /** false si INFLUX_TOKEN vide → repli RRD Proxmox */
  enabled: boolean;
  url: string;
  token: string;
  /** base brute (rétention 31 j) */
  rawDb: string;
  /** base consolidée 5 min (rétention infinie) */
  aggDb: string;
  /** base RRD native Proxmox VE (7 tables, déjà présente chez les clients) */
  rrdDb: string;
  /** certificat auto-signé InfluxDB à faire confiance (chemin absolu, '' = absent) */
  caCert: string;
  /** file d'écriture bornée (lignes) — P1 backpressure */
  queueMax: number;
  /** taille de lot par requête write_lp (lignes) — P1 */
  flushMaxLines: number;
  /** lots consécutifs en échec avant dead-letter — P1 */
  flushMaxRetries: number;
  /** taille de tranche (jours) pour les requêtes long terme chunkées — P2 */
  queryChunkDays: number;
  /** --query-file-limit du service (sert l'estimation de headroom) — P4 */
  queryFileLimit: number;
  /** archivage consolidated → CSV : intervalle (ms) — P5 */
  archiveIntervalMs: number;
  /** archivage : âge minimal archivé (ms) — P5 */
  archiveAgeMs: number;
  /** archivage : dossier de sortie (chemin absolu) — P5 */
  archiveDir: string;
}

/** Un endpoint Proxmox surveillé (cluster ou nœud autonome). */
export interface EndpointConfig {
  /** identifiant stable (slug) — utilisé dans les URLs, le tag InfluxDB `cluster` et sites.json */
  id: string;
  /** nom affiché dans l'UI */
  name: string;
  /** URL API PVE (https://host:8006) */
  url: string;
  /** header complet : user@realm!tokenid=value */
  tokenHeader: string;
}

export interface AppConfig {
  endpoints: EndpointConfig[];
  defaultEndpointId: string;
  tlsRejectUnauthorized: boolean;
  mock: boolean;
  mockScenario: 'nominal' | 'degraded' | 'critical';
  port: number;
  /** TLS application (absent si non configuré → HTTP clair) */
  tls?: { key: string; cert: string };
  influx: InfluxConfig;
  /** politique de surallocation (overcommit.json, hot-reload) */
  overcommit: OvercommitConfig;
  /** mtime du dernier overcommit.json appliqué (détection de changement) */
  overcommitMtime: number;
  /** seuils + pénalités Health Score / PRA (health.json, hot-reload) */
  health: HealthConfig;
  /** mtime du dernier health.json appliqué (détection de changement) */
  healthMtime: number;
  /** checks + seuils du score de configuration (audit.json, hot-reload) */
  audit: AuditConfig;
  /** mtime du dernier audit.json appliqué (détection de changement) */
  auditMtime: number;
  /**
   * Taille d'autorité des LUN iSCSI par nom de datastore (storage-volumes.json, optionnel) :
   * `{ "lunSizes": { "baie-iscsi": 644245094400 } }`. Quand la taille d'un LUN est inconnue de
   * PVE (pas d'endpoint iSCSI sur PVE 9), sa capacité est déduite de la somme des tailles des
   * VG qui reposent dessus — une **borne basse**. Cette config donne la vraie taille du LUN
   * (valeur d'autorité, `totalSource='lun'`). Vide = aucune taille connue.
   */
  lunSizes: Record<string, number>;
  /** fichier des données d'authentification (data/auth.json, gitignored, chmod 600) */
  authFile: string;
  /** journal d'audit des actions admin (data/admin-audit.jsonl, append-only, chmod 600) */
  auditFile: string;
  /** durée de vie des sessions (ms) */
  sessionTtlMs: number;
  /**
   * Noms des groupes autorisés à lancer les ACTIONS InfluxDB
   * (POST /api/influxdb/actions/*). Le rôle admin passe toujours.
   * Vide = seules les actions du rôle admin.
   */
  influxActionGroups: string[];
}

/** Chemin relatif au repo (data/tls/…) ou absolu. */
function resolvePath(p: string): string {
  // here = <repo>/packages/server/src/core → 4 niveaux vers la racine
  return path.isAbsolute(p) ? p : path.resolve(here, '../../../..', p);
}

const endpointSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  name: z.string().min(1),
  url: z.string().url(),
  user: z.string().min(1),
  tokenId: z.string().min(1),
  tokenValue: z.string().min(1),
});

const clustersSchema = z.object({
  default: z.string().optional(),
  endpoints: z.array(endpointSchema).min(1),
});

/**
 * Charge la liste des endpoints surveillés.
 * - `clusters.json` (racine du repo) : multi-endpoints, tokens inline (fichier 600, gitignored) ;
 * - sinon repli sur les variables PVE_* (.env) → un seul endpoint `default`.
 */
function loadEndpoints(env: z.infer<typeof envSchema>): { endpoints: EndpointConfig[]; defaultEndpointId: string } {
  const candidates = [path.resolve(process.cwd(), 'clusters.json'), path.resolve(here, '../../../../clusters.json')];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let parsed: z.infer<typeof clustersSchema>;
    try {
      parsed = clustersSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      throw new Error(`clusters.json invalide (${file}) : ${(err as Error).message}`);
    }
    const endpoints: EndpointConfig[] = parsed.endpoints.map((e) => ({
      id: e.id,
      name: e.name,
      url: e.url.replace(/\/$/, ''),
      tokenHeader: `${e.user}!${e.tokenId}=${e.tokenValue}`,
    }));
    const ids = new Set(endpoints.map((e) => e.id));
    if (ids.size !== endpoints.length) throw new Error('clusters.json : identifiants d’endpoints en double');
    const defaultEndpointId = parsed.default && ids.has(parsed.default) ? parsed.default : endpoints[0].id;
    return { endpoints, defaultEndpointId };
  }
  // Repli mono-endpoint depuis .env
  return {
    endpoints: [
      {
        id: 'default',
        name: new URL(env.PVE_URL).host,
        url: env.PVE_URL.replace(/\/$/, ''),
        tokenHeader: `${env.PVE_USER}!${env.PVE_TOKEN_ID}=${env.PVE_TOKEN_VALUE}`,
      },
    ],
    defaultEndpointId: 'default',
  };
}

const overcommitScaleSchema = z
  .object({ okMax: z.number().positive(), warnMax: z.number().positive() })
  .refine((s) => s.warnMax >= s.okMax, { message: 'warnMax doit être ≥ okMax' });

const riskSchema = z
  .object({
    warnPct: z.number().min(0).max(100),
    critPct: z.number().min(0).max(100),
    warnRatio: z.number().positive(),
    critRatio: z.number().positive(),
  })
  .refine((r) => r.critPct >= r.warnPct && r.critRatio >= r.warnRatio, {
    message: 'crit doit être ≥ warn (pct et ratio)',
  });

const overcommitSchema = z.object({
  usage: z
    .object({ warnPct: z.number().min(0).max(100), critPct: z.number().min(0).max(100) })
    .refine((u) => u.critPct >= u.warnPct, { message: 'critPct doit être ≥ warnPct' }),
  hostRamProvisionPct: z.number().min(0).max(100).default(DEFAULT_OVERCOMMIT_CONFIG.hostRamProvisionPct),
  cpu: overcommitScaleSchema.default(DEFAULT_OVERCOMMIT_CONFIG.cpu),
  ram: overcommitScaleSchema.default(DEFAULT_OVERCOMMIT_CONFIG.ram),
  disk: overcommitScaleSchema.default(DEFAULT_OVERCOMMIT_CONFIG.disk),
  risk: riskSchema.default(DEFAULT_OVERCOMMIT_CONFIG.risk),
});

// --- health.json (seuils + pénalités du Health Score / PRA) ---------------------

const healthThresholdsSchema = z
  .object({
    warn: z.number().min(0).max(100),
    crit: z.number().min(0).max(100),
    praWarn: z.number().min(0).max(100),
    praCrit: z.number().min(0).max(100),
    healthNominal: z.number().min(0).max(100),
    healthDegraded: z.number().min(0).max(100),
  })
  .refine(
    (t) => t.crit >= t.warn && t.praCrit >= t.praWarn && t.healthNominal >= t.healthDegraded,
    { message: 'crit ≥ warn, praCrit ≥ praWarn, healthNominal ≥ healthDegraded' },
  );

const healthPenaltiesSchema = z.object({
  nodeDown: z.number().min(0),
  quorumLost: z.number().min(0),
  qdeviceDown: z.number().min(0),
  cpuCrit: z.number().min(0),
  cpuWarn: z.number().min(0),
  ramCrit: z.number().min(0),
  ramWarn: z.number().min(0),
  diskCrit: z.number().min(0),
  diskWarn: z.number().min(0),
  praCrit: z.number().min(0),
  praWarn: z.number().min(0),
});

const healthSchema = z.object({
  thresholds: healthThresholdsSchema.default(DEFAULT_HEALTH_CONFIG.thresholds),
  penalties: healthPenaltiesSchema.default(DEFAULT_HEALTH_CONFIG.penalties),
});

// --- audit.json (checks + seuils + pénalités du score de configuration) ---------

const auditChecksSchema = z.object({
  'guests.qemu_without_agent': z.object({ enabled: z.boolean() }).default(DEFAULT_AUDIT_CONFIG.checks['guests.qemu_without_agent']),
  'guests.privileged_containers': z.object({ enabled: z.boolean() }).default(DEFAULT_AUDIT_CONFIG.checks['guests.privileged_containers']),
  'guests.cpu_host_type': z.object({ enabled: z.boolean() }).default(DEFAULT_AUDIT_CONFIG.checks['guests.cpu_host_type']),
  'network.bridge_without_ports': z.object({ enabled: z.boolean() }).default(DEFAULT_AUDIT_CONFIG.checks['network.bridge_without_ports']),
  'storage.thin_pool_overprovisioning': z.object({ enabled: z.boolean() }).default(DEFAULT_AUDIT_CONFIG.checks['storage.thin_pool_overprovisioning']),
  'system.memory_overcommit': z.object({ enabled: z.boolean() }).default(DEFAULT_AUDIT_CONFIG.checks['system.memory_overcommit']),
  'system.node_version_mismatch': z.object({ enabled: z.boolean() }).default(DEFAULT_AUDIT_CONFIG.checks['system.node_version_mismatch']),
  'guests.autostart': z.object({ enabled: z.boolean() }).default(DEFAULT_AUDIT_CONFIG.checks['guests.autostart']),
  'guests.stuck_snapshots': z
    .object({ enabled: z.boolean(), maxAgeDays: z.number().positive() })
    .default(DEFAULT_AUDIT_CONFIG.checks['guests.stuck_snapshots']),
  'guests.replication_state': z
    .object({ enabled: z.boolean(), maxStalenessHours: z.number().positive() })
    .default(DEFAULT_AUDIT_CONFIG.checks['guests.replication_state']),
  'network.bond_members': z
    .object({ enabled: z.boolean(), minMembers: z.number().int().positive() })
    .default(DEFAULT_AUDIT_CONFIG.checks['network.bond_members']),
  'system.zfs_arc_max': z
    .object({ enabled: z.boolean(), maxPctOfRam: z.number().min(0).max(100) })
    .default(DEFAULT_AUDIT_CONFIG.checks['system.zfs_arc_max']),
  'disks.disk_errors': z.object({ enabled: z.boolean() }).default(DEFAULT_AUDIT_CONFIG.checks['disks.disk_errors']),
  'disks.disk_service_life': z
    .object({ enabled: z.boolean(), warnPct: z.number().min(0).max(100), critPct: z.number().min(0).max(100) })
    .refine((c) => c.critPct >= c.warnPct, { message: 'critPct doit être ≥ warnPct' })
    .default(DEFAULT_AUDIT_CONFIG.checks['disks.disk_service_life']),
  'system.failed_units': z.object({ enabled: z.boolean() }).default(DEFAULT_AUDIT_CONFIG.checks['system.failed_units']),
  'system.pending_reboot': z.object({ enabled: z.boolean() }).default(DEFAULT_AUDIT_CONFIG.checks['system.pending_reboot']),
  'system.security_updates': z
    .object({ enabled: z.boolean(), warnCount: z.number().int().nonnegative() })
    .default(DEFAULT_AUDIT_CONFIG.checks['system.security_updates']),
});

const auditSchema = z.object({
  penalties: z
    .object({ crit: z.number().min(0), warn: z.number().min(0), info: z.number().min(0) })
    .default(DEFAULT_AUDIT_CONFIG.penalties),
  labelNominal: z.number().min(0).max(100).default(DEFAULT_AUDIT_CONFIG.labelNominal),
  labelDegraded: z.number().min(0).max(100).default(DEFAULT_AUDIT_CONFIG.labelDegraded),
  checks: auditChecksSchema.default(DEFAULT_AUDIT_CONFIG.checks),
});

function overcommitCandidates(): string[] {
  return [path.resolve(process.cwd(), 'overcommit.json'), path.resolve(here, '../../../../overcommit.json')];
}

function configCandidates(name: string): string[] {
  return [path.resolve(process.cwd(), name), path.resolve(here, '../../../../', name)];
}

/** Charge overcommit.json (racine du repo) ; absent → defaults intégrés, invalide → fail-fast. */
function loadOvercommitConfig(): { config: OvercommitConfig; mtime: number } {
  for (const file of overcommitCandidates()) {
    if (!existsSync(file)) continue;
    let parsed: OvercommitConfig;
    try {
      parsed = overcommitSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      throw new Error(`overcommit.json invalide (${file}) : ${(err as Error).message}`);
    }
    return { config: parsed, mtime: statSync(file).mtimeMs };
  }
  return { config: DEFAULT_OVERCOMMIT_CONFIG, mtime: 0 };
}

/**
 * Hot-reload d'overcommit.json (appelé à chaque tick du poller) : si le fichier a changé
 * et est valide → appliqué sans restart ; s'il est invalide → configuration précédente
 * conservée (warning, pas de retry tant que le mtime ne change pas).
 */
export function reloadOvercommitConfig(cfg: AppConfig, logger: Pick<Console, 'info' | 'warn'>): void {
  for (const file of overcommitCandidates()) {
    if (!existsSync(file)) continue; // candidat absent → on tente le suivant (racine)
    const mtime = statSync(file).mtimeMs;
    if (mtime === cfg.overcommitMtime) return;
    try {
      cfg.overcommit = overcommitSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      cfg.overcommitMtime = mtime;
      logger.info('overcommit.json modifié : seuils de surallocation rechargés');
    } catch (err) {
      cfg.overcommitMtime = mtime;
      logger.warn(`overcommit.json invalide, configuration précédente conservée : ${(err as Error).message}`);
    }
    return;
  }
}

/** Charge health.json (racine) ; absent → défauts intégrés, invalide → fail-fast. */
function loadHealthConfig(): { config: HealthConfig; mtime: number } {
  for (const file of configCandidates('health.json')) {
    if (!existsSync(file)) continue;
    let parsed: HealthConfig;
    try {
      parsed = healthSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      throw new Error(`health.json invalide (${file}) : ${(err as Error).message}`);
    }
    return { config: parsed, mtime: statSync(file).mtimeMs };
  }
  return { config: DEFAULT_HEALTH_CONFIG, mtime: 0 };
}

/** Charge audit.json (racine) ; absent → défauts intégrés, invalide → fail-fast. */
function loadAuditConfig(): { config: AuditConfig; mtime: number } {
  for (const file of configCandidates('audit.json')) {
    if (!existsSync(file)) continue;
    let parsed: AuditConfig;
    try {
      parsed = auditSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      throw new Error(`audit.json invalide (${file}) : ${(err as Error).message}`);
    }
    return { config: parsed, mtime: statSync(file).mtimeMs };
  }
  return { config: DEFAULT_AUDIT_CONFIG, mtime: 0 };
}

/**
 * Hot-reload de health.json + audit.json (appelé à chaque tick du poller) : même
 * mécanique que overcommit.json — fichier modifié + valide → appliqué sans restart ;
 * invalide → configuration précédente conservée (warning).
 */
export function reloadTunableConfigs(cfg: AppConfig, logger: Pick<Console, 'info' | 'warn'>): void {
  const reload = (
    name: string,
    schema: z.ZodTypeAny,
    getMtime: () => number,
    setMtime: (ms: number) => void,
    apply: (v: unknown) => void,
  ) => {
    for (const file of configCandidates(name)) {
      if (!existsSync(file)) continue; // candidat absent → on tente le suivant (racine)
      const mtime = statSync(file).mtimeMs;
      if (mtime === getMtime()) return;
      try {
        apply(schema.parse(JSON.parse(readFileSync(file, 'utf8'))));
        setMtime(mtime);
        logger.info(`${name} modifié : configuration rechargée`);
      } catch (err) {
        setMtime(mtime);
        logger.warn(`${name} invalide, configuration précédente conservée : ${(err as Error).message}`);
      }
      return;
    }
  };
  reload('health.json', healthSchema, () => cfg.healthMtime, (ms) => (cfg.healthMtime = ms), (v) => (cfg.health = v as HealthConfig));
  reload('audit.json', auditSchema, () => cfg.auditMtime, (ms) => (cfg.auditMtime = ms), (v) => (cfg.audit = v as AuditConfig));
}

const storageVolumesSchema = z.object({
  /** Taille d'autorité d'un LUN iSCSI (octets), par nom de datastore iSCSI. */
  lunSizes: z.record(z.string(), z.number().int().positive()).default({}),
});

/**
 * Charge storage-volumes.json (racine du repo, optionnel) : `{ "lunSizes": { "<iscsi>": octets } }`.
 * Absent → aucun LUN de taille connue (les capacités iSCSI restent des bornes basses Σ VG).
 * Invalide → fail-fast au démarrage (pas de hot-reload : c'est une donnée de parc stable).
 */
function loadStorageVolumesConfig(): Record<string, number> {
  for (const file of [path.resolve(process.cwd(), 'storage-volumes.json'), path.resolve(here, '../../../../storage-volumes.json')]) {
    if (!existsSync(file)) continue;
    try {
      return storageVolumesSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).lunSizes;
    } catch (err) {
      throw new Error(`storage-volumes.json invalide (${file}) : ${(err as Error).message}`);
    }
  }
  return {};
}

export function loadConfig(): AppConfig {
  const env = envSchema.parse(process.env);
  const { endpoints, defaultEndpointId } = loadEndpoints(env);
  const { config: overcommit, mtime: overcommitMtime } = loadOvercommitConfig();
  const { config: health, mtime: healthMtime } = loadHealthConfig();
  const { config: audit, mtime: auditMtime } = loadAuditConfig();
  const lunSizes = loadStorageVolumesConfig();
  const cfg: AppConfig = {
    endpoints,
    defaultEndpointId,
    tlsRejectUnauthorized: env.TLS_REJECT_UNAUTHORIZED === 'true',
    mock: env.MOCK === '1',
    mockScenario: env.MOCK_SCENARIO,
    port: env.PORT,
    overcommit,
    overcommitMtime,
    health,
    healthMtime,
    audit,
    auditMtime,
    lunSizes,
    influx: {
      enabled: env.INFLUX_TOKEN.length > 0,
      url: env.INFLUX_URL.replace(/\/$/, ''),
      token: env.INFLUX_TOKEN,
      rawDb: env.INFLUX_RAW_DB,
      aggDb: env.INFLUX_AGG_DB,
      rrdDb: env.INFLUX_RRD_DB,
      caCert: env.INFLUX_CA_CERT ? resolvePath(env.INFLUX_CA_CERT) : '',
      queueMax: env.INFLUX_QUEUE_MAX,
      flushMaxLines: env.INFLUX_FLUSH_MAX_LINES,
      flushMaxRetries: env.INFLUX_FLUSH_MAX_RETRIES,
      queryChunkDays: env.INFLUX_QUERY_CHUNK_DAYS,
      queryFileLimit: env.INFLUX_QUERY_FILE_LIMIT,
      archiveIntervalMs: env.INFLUX_ARCHIVE_INTERVAL_HOURS * 3_600_000,
      archiveAgeMs: env.INFLUX_ARCHIVE_AGE_DAYS * 86_400_000,
      archiveDir: resolvePath(env.INFLUX_ARCHIVE_DIR),
    },
    authFile: resolvePath('data/auth.json'),
    auditFile: resolvePath('data/admin-audit.jsonl'),
    sessionTtlMs: env.AUTH_SESSION_TTL_HOURS * 3_600_000,
    influxActionGroups: env.INFLUX_ACTION_GROUPS.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
  if (env.TLS_KEY && env.TLS_CERT) {
    cfg.tls = { key: resolvePath(env.TLS_KEY), cert: resolvePath(env.TLS_CERT) };
  }
  return cfg;
}
