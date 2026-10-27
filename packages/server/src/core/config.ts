import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DEFAULT_OVERCOMMIT_CONFIG, type OvercommitConfig } from '@prox4u/shared';

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
  /** fichier des données d'authentification (data/auth.json, gitignored, chmod 600) */
  authFile: string;
  /** durée de vie des sessions (ms) */
  sessionTtlMs: number;
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

function overcommitCandidates(): string[] {
  return [path.resolve(process.cwd(), 'overcommit.json'), path.resolve(here, '../../../../overcommit.json')];
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
    if (!existsSync(file)) return;
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

export function loadConfig(): AppConfig {
  const env = envSchema.parse(process.env);
  const { endpoints, defaultEndpointId } = loadEndpoints(env);
  const { config: overcommit, mtime: overcommitMtime } = loadOvercommitConfig();
  const cfg: AppConfig = {
    endpoints,
    defaultEndpointId,
    tlsRejectUnauthorized: env.TLS_REJECT_UNAUTHORIZED === 'true',
    mock: env.MOCK === '1',
    mockScenario: env.MOCK_SCENARIO,
    port: env.PORT,
    overcommit,
    overcommitMtime,
    influx: {
      enabled: env.INFLUX_TOKEN.length > 0,
      url: env.INFLUX_URL.replace(/\/$/, ''),
      token: env.INFLUX_TOKEN,
      rawDb: env.INFLUX_RAW_DB,
      aggDb: env.INFLUX_AGG_DB,
      rrdDb: env.INFLUX_RRD_DB,
      caCert: env.INFLUX_CA_CERT ? resolvePath(env.INFLUX_CA_CERT) : '',
    },
    authFile: resolvePath('data/auth.json'),
    sessionTtlMs: env.AUTH_SESSION_TTL_HOURS * 3_600_000,
  };
  if (env.TLS_KEY && env.TLS_CERT) {
    cfg.tls = { key: resolvePath(env.TLS_KEY), cert: resolvePath(env.TLS_CERT) };
  }
  return cfg;
}
