import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootCertificates } from 'node:tls';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { Agent } from 'undici';
import type { Site } from '@prox4u/shared';
import { loadConfig } from './core/config.js';
import { ensureInfluxDatabases, InfluxClient } from './core/influx.js';
import { InfluxConsolidator } from './core/influx-consolidator.js';
import { MockSource, MOCK_SITES } from './core/mock-source.js';
import { Prox4uClient } from './core/prox4u-client.js';
import { Poller, type AppContext, type EndpointRuntime } from './core/poller.js';
import { WsHub } from './core/ws-hub.js';
import { hashPassword } from './modules/auth/password.js';
import { LocalProvider } from './modules/auth/providers.js';
import { parseCookies, SessionStore, SESSION_COOKIE } from './modules/auth/session.js';
import { AuthStore } from './modules/auth/store.js';
import { modules } from './modules/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const config = loadConfig();
const logger: AppContext['logger'] = {
  info: (...a) => console.log('[info]', ...a),
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
};

/** Sites de sites.json applicables à un endpoint (sans `endpoint` = par défaut). */
function loadSites(): Site[] {
  const file = path.join(repoRoot, 'sites.json');
  if (!existsSync(file)) {
    logger.warn('sites.json introuvable : PRA désactivé (aucun site défini)');
    return [];
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { sites?: Site[] };
  const sites = (raw.sites ?? []).filter((s) => s && typeof s.id === 'string' && Array.isArray(s.nodes));
  logger.info(`topologie : ${sites.length} site(s) depuis sites.json`);
  return sites;
}

function sitesForEndpoint(all: Site[], endpointId: string): Site[] {
  return all.filter((s) => !s.endpoint || s.endpoint === endpointId);
}

/** Construit les endpoints surveillés (mock : 2 démos, réel : clusters.json). */
function buildEndpoints(): EndpointRuntime[] {
  if (config.mock) {
    const scenario = config.mockScenario;
    return [
      {
        id: 'demo-a',
        name: 'Démo A — 2 bâtiments',
        url: '', // mock : pas d'UI PVE réelle (liens console désactivés)
        source: new MockSource(scenario, [MOCK_SITES[0], MOCK_SITES[1]]),
        sites: [MOCK_SITES[0], MOCK_SITES[1]],
      },
      {
        id: 'demo-b',
        name: 'Démo B — 1 bâtiment',
        url: '',
        source: new MockSource(scenario, [MOCK_SITES[2]]),
        sites: [MOCK_SITES[2]],
      },
    ];
  }
  const allSites = loadSites();
  return config.endpoints.map((ep) => ({
    id: ep.id,
    name: ep.name,
    url: ep.url,
    source: new Prox4uClient(ep, config.tlsRejectUnauthorized),
    sites: sitesForEndpoint(allSites, ep.id),
  }));
}

/**
 * Agent dédié faisant confiance au certificat auto-signé InfluxDB.
 * Passé à InfluxClient (dispatcher local) : la confiance ne pollue PAS le
 * dispatcher global — les autres fetch (Proxmox, Centreon REST) restent sur
 * la chaîne de confiance système.
 */
function trustInfluxCa(caCert: string): Agent {
  const ca = [...rootCertificates, readFileSync(caCert, 'utf8')];
  return new Agent({ connect: { ca } });
}

async function main(): Promise<void> {
  // CA uniquement si InfluxDB est actif : sans INFLUX_TOKEN, l'app tourne en repli RRD
  // et le fichier de certificat n'est pas requis (serveur frais, data/ absent du tarball).
  // Le CA est porté par un dispatcher DÉDIÉ (InfluxClient) — pas le dispatcher global.
  const influxDispatcher =
    config.influx.enabled && config.influx.caCert ? trustInfluxCa(config.influx.caCert) : undefined;
  const endpoints = buildEndpoints();
  // mode mock : le default de clusters.json peut ne pas exister → 1er endpoint
  if (!endpoints.some((e) => e.id === config.defaultEndpointId)) {
    config.defaultEndpointId = endpoints[0].id;
  }
  const hub = new WsHub();
  const influx = new InfluxClient(config.influx, influxDispatcher);
  // Runtime d'authentification : data/auth.json (seed admin au 1er démarrage),
  // sessions en mémoire, provider local (AD branchable via AuthProvider).
  const authStore = new AuthStore(config.authFile, logger);
  await authStore.init(hashPassword);
  const sessions = new SessionStore(config.sessionTtlMs);
  const ctx: AppContext = {
    config,
    endpoints,
    logger,
    influx,
    auth: { store: authStore, sessions, provider: new LocalProvider(authStore) },
    hub,
  };
  const poller = new Poller(ctx, hub);
  const consolidator = new InfluxConsolidator(ctx);

  // https.Server hérite de http.Server : le cast est structurellement sûr
  const app = (config.tls
    ? Fastify({ logger: false, https: { key: readFileSync(config.tls.key), cert: readFileSync(config.tls.cert) } })
    : Fastify({ logger: false })) as FastifyInstance;

  for (const m of modules) await m.register(app, ctx, poller);

  // WebSocket : session d'authentification requise (cookie httpOnly) —
  // les upgrades non authentifiés sont rejetés avant le handshake.
  hub.attach(app.server, {
    verifyClient: (req) => Boolean(sessions.get(parseCookies(req.headers.cookie)[SESSION_COOKIE])),
  });

  // Échantillon de design (validation du style avant intégration)
  const sampleFile = path.join(repoRoot, 'sample/dashboard-sample.html');
  if (existsSync(sampleFile)) {
    app.get('/sample', async (_req, reply) => reply.type('text/html').send(readFileSync(sampleFile)));
  }

  // En prod : servir le build web (SPA) si présent
  const webDist = path.resolve(repoRoot, 'packages/web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  // Bases InfluxDB (raw 31 j + consolidated ∞) : non bloquant, repli RRD si absent
  if (influx.enabled && !config.mock) void ensureInfluxDatabases(influx, logger);

  poller.start();
  consolidator.start();

  // Avertissements de posture (non bloquants — le défaut TLS_REJECT_UNAUTHORIZED=false
  // est conservé : les déploiements reposent sur les certificats auto-signés Proxmox).
  if (!config.tls) {
    logger.warn('HTTP clair : TLS applicatif non configuré (TLS_KEY/TLS_CERT absents) — mots de passe, cookies de session et tokens transitent sans chiffrement sur 0.0.0.0');
  }
  if (!config.tlsRejectUnauthorized && !config.mock) {
    logger.warn('TLS_REJECT_UNAUTHORIZED=false : les certificats des API Proxmox ne sont pas vérifiés (risque MITM sur les tokens PVEAPIToken)');
  }

  const scheme = config.tls ? 'https' : 'http';
  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info(
    `Prox4u prêt : ${scheme}://localhost:${config.port} ` +
      `(mode ${config.mock ? `mock/${config.mockScenario}` : `réel → ${endpoints.map((e) => e.name).join(', ')}`}` +
      `${influx.enabled && !config.mock ? ', InfluxDB actif' : ''})`,
  );

  const shutdown = async () => {
    logger.info('arrêt en cours…');
    poller.stop();
    consolidator.stop();
    influx.stop();
    await influx.flush().catch(() => undefined);
    hub.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
