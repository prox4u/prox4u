import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultCenteronConfig, type CentreonConfig, type CentreonPoller } from '@prox4u/shared';
import { provisionService } from './provision.js';

/**
 * Tests du provisioning REST — nouvelle API `/api/latest/` + X-AUTH-TOKEN.
 * `fetch` est stubbé par un mini-« monde » Centreon (hôtes/commandes/services/
 * monitoring-servers) qui répond selon la méthode + le chemin appelé.
 */

const POLLER: CentreonPoller = { id: 'central', name: 'Central', ip: '192.168.1.130' };

function restCfg(over: Partial<CentreonConfig> = {}): CentreonConfig {
  return {
    ...defaultCenteronConfig(),
    transport: 'rest',
    restUrl: 'http://central/centreon',
    restUser: 'prox4u',
    restToken: 'tok-123',
    ...over,
  };
}

interface World {
  servers: Array<{ id: number; name: string; address: string }>;
  hosts: Array<{ id: number; name: string; address: string }>;
  commands: Array<{ id: number; name: string }>;
  services: Array<{ id: number; name: string; host_id: number }>;
  nextId: number;
}

function makeWorld(over: Partial<World> = {}): World {
  return {
    servers: [{ id: 1, name: 'Central', address: '192.168.1.130' }],
    hosts: [],
    commands: [{ id: 91, name: 'check_dummy' }],
    services: [],
    nextId: 100,
    ...over,
  };
}

/** Installe un fetch stubbé qui simule l'API /api/latest/ sur `world`. */
function installFetch(world: World) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const u = new URL(String(input));
    const path = u.pathname.replace(/^.*\/api\/latest/, '');
    const q = new URLSearchParams(u.search);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });

    const json = (data: unknown, status = 200) =>
      // un 204 n'a pas de body (null obligatoire, pas '')
      new Response(status === 204 ? null : data === null || data === undefined ? '' : JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const notFound = (p: string) => json({ code: 0, message: `No route found for ${p}` }, 404);

    // --- monitoring-servers (pollers) ---
    if (path === '/configuration/monitoring-servers' && method === 'GET') {
      return json({ result: world.servers });
    }
    let m = path.match(/^\/configuration\/monitoring-servers\/(\d+)\/(generate|reload)$/);
    if (m && method === 'GET') return json(null, 204);

    // --- hosts ---
    if (path === '/configuration/hosts' && method === 'GET') {
      const name = q.get('name');
      const result = world.hosts.filter((h) => !name || h.name === name);
      return json({ result });
    }
    if (path === '/configuration/hosts' && method === 'POST') {
      const id = world.nextId++;
      world.hosts.push({ id, name: body!.name, address: body!.address });
      return json({ id }, 201);
    }

    // --- commands (tableau brut avec Accept: application/json — format réel) ---
    if (path === '/configuration/commands' && method === 'GET') {
      return json(world.commands);
    }
    if (path === '/configuration/commands' && method === 'POST') {
      const id = world.nextId++;
      world.commands.push({ id, name: body!.name });
      return json({ id }, 201);
    }

    // --- services ---
    if (path === '/configuration/services' && method === 'GET') {
      const hostId = q.get('host_id');
      const name = q.get('name');
      const result = world.services.filter(
        (s) => (!hostId || String(s.host_id) === hostId) && (!name || s.name === name),
      );
      return json({ result });
    }
    if (path === '/configuration/services' && method === 'POST') {
      const id = world.nextId++;
      world.services.push({ id, name: body!.name, host_id: body!.host_id });
      return json({ id }, 201);
    }
    m = path.match(/^\/configuration\/services\/(\d+)$/);
    if (m && method === 'PATCH') return json(null, 204);

    return notFound(`${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provisionService — REST /api/latest/', () => {
  it('hôte absent + IP fournie → auto-création hôte + service + generate/reload', async () => {
    const world = makeWorld();
    const { calls } = installFetch(world);
    const r = await provisionService(restCfg(), 'vm-100', 'Prox4u-Alarm-CPU', POLLER, '10.0.0.5');
    expect(r.ok).toBe(true);
    expect(world.hosts).toHaveLength(1);
    expect(world.hosts[0]).toMatchObject({ name: 'vm-100', address: '10.0.0.5' });
    expect(world.services).toHaveLength(1);
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain('POST /configuration/hosts');
    expect(paths).toContain('POST /configuration/services');
    expect(paths).toContain('GET /configuration/monitoring-servers/1/generate');
    expect(paths).toContain('GET /configuration/monitoring-servers/1/reload');
    // check_dummy déjà présente → pas de création
    expect(paths).not.toContain('POST /configuration/commands');
  });

  it('hôte présent + service présent → idempotent (aucun POST)', async () => {
    const world = makeWorld({
      hosts: [{ id: 1, name: 'vm-100', address: '10.0.0.5' }],
      services: [{ id: 5, name: 'Prox4u-Alarm-CPU', host_id: 1 }],
    });
    const { calls } = installFetch(world);
    const r = await provisionService(restCfg(), 'vm-100', 'Prox4u-Alarm-CPU', POLLER, '10.0.0.5');
    expect(r.ok).toBe(true);
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).not.toContain('POST /configuration/hosts');
    expect(paths).not.toContain('POST /configuration/services');
    expect(paths).toContain('PATCH /configuration/services/5');
  });

  it('check_dummy absente → auto-création (type Check, is_shell_enabled false)', async () => {
    const world = makeWorld({ commands: [] });
    const { calls } = installFetch(world);
    const r = await provisionService(restCfg(), 'vm-100', 'Prox4u-Alarm-CPU', POLLER, '10.0.0.5');
    expect(r.ok).toBe(true);
    const postCmd = calls.find((c) => c.method === 'POST' && c.path === '/configuration/commands');
    expect(postCmd).toBeDefined();
    expect(postCmd!.body).toMatchObject({ name: 'check_dummy', type: 'Check', is_shell_enabled: false });
  });

  it('commands au format Hydra {member} (sans Accept) → toujours trouvé', async () => {
    const world = makeWorld();
    const { calls } = installFetch(world);
    // surcharge : GET commands renvoie le format Hydra {member} au lieu du tableau brut
    const origFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const res = await (origFetch as (i: string, o?: RequestInit) => Promise<Response>)(input, init);
      if (String(input).includes('/configuration/commands') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ member: world.commands }), { status: 200 });
      }
      return res;
    });
    const r = await provisionService(restCfg(), 'vm-100', 'Prox4u-Alarm-CPU', POLLER, '10.0.0.5');
    expect(r.ok).toBe(true);
    // check_dummy trouvée au format member → pas de POST commands
    expect(calls.some((c) => c.method === 'POST' && c.path === '/configuration/commands')).toBe(false);
  });

  it('hôte absent + PAS d\'IP → auto-création avec adresse = nom (check passif)', async () => {
    const world = makeWorld();
    const { calls } = installFetch(world);
    const r = await provisionService(restCfg(), 'vm-100', 'Prox4u-Alarm-CPU', POLLER);
    expect(r.ok).toBe(true);
    expect(world.hosts).toHaveLength(1);
    expect(world.hosts[0]).toMatchObject({ name: 'vm-100', address: 'vm-100' });
    expect(world.services).toHaveLength(1);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/configuration/services')).toBe(true);
  });

  it('token manquant → échec avant tout appel HTTP', async () => {
    const { fetchMock } = installFetch(makeWorld());
    const r = await provisionService(restCfg({ restToken: '' }), 'vm-100', 'Prox4u-Alarm-CPU', POLLER, '10.0.0.5');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('URL manquante → échec avant tout appel HTTP', async () => {
    const { fetchMock } = installFetch(makeWorld());
    const r = await provisionService(restCfg({ restUrl: '' }), 'vm-100', 'Prox4u-Alarm-CPU', POLLER, '10.0.0.5');
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('poller matching : par IP (address) quand le nom ne correspond pas', async () => {
    const world = makeWorld({ servers: [{ id: 3, name: 'Central', address: '192.168.1.130' }] });
    const { calls } = installFetch(world);
    const r = await provisionService(
      restCfg(), 'vm-100', 'Prox4u-Alarm-CPU',
      { id: 'poller', name: 'poller', ip: '192.168.1.130' }, '10.0.0.5',
    );
    expect(r.ok).toBe(true);
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain('GET /configuration/monitoring-servers/3/generate');
    expect(paths).toContain('GET /configuration/monitoring-servers/3/reload');
  });

  it('erreur HTTP (404) → ok:false + message, jamais d\'exception', async () => {
    // monitoring-servers inconnu → le fetch renvoie 404 sur le 1er appel
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, message: 'No route found' }), { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await provisionService(restCfg(), 'vm-100', 'Prox4u-Alarm-CPU', POLLER, '10.0.0.5');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('404');
  });

  it('auth par header X-AUTH-TOKEN (pas de Basic)', async () => {
    const { fetchMock } = installFetch(makeWorld());
    await provisionService(restCfg(), 'vm-100', 'Prox4u-Alarm-CPU', POLLER, '10.0.0.5');
    expect(fetchMock).toHaveBeenCalled();
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['X-AUTH-TOKEN']).toBe('tok-123');
    expect(headers['Authorization']).toBeUndefined();
  });
});
