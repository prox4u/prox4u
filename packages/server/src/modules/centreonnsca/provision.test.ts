import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { defaultCenteronConfig, type CentreonConfig, type CentreonPoller } from '@prox4u/shared';
import { countHostServices, deleteCenteronHost, deleteCenteronService, provisionService } from './provision.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

/**
 * Mocke `spawn` pour la séquence CLAPI : chaque ligne exécutée renvoie le
 * résultat du `results` (dans l'ordre). `code 0` = ok, sinon échec avec `err`.
 */
function mockClapiSequence(results: Array<{ code: number; out?: string; err?: string }>) {
  const spawnMock = vi.mocked(spawn);
  let i = 0;
  spawnMock.mockImplementation(() => {
    const r = results[Math.min(i, results.length - 1)];
    i += 1;
    const child = {
      stdout: { on: (ev: string, cb: (d: string) => void) => { if (ev === 'data' && r.out) cb(r.out); } },
      stderr: { on: (ev: string, cb: (d: string) => void) => { if (ev === 'data' && r.err) cb(r.err); } },
      on: (ev: string, cb: (code: number) => void) => { if (ev === 'close') cb(r.code); },
      kill: () => undefined,
      stdin: { write: () => undefined, end: () => undefined },
    };
    return child as unknown as ReturnType<typeof spawn>;
  });
  return spawnMock;
}

function clapiCfg(over: Partial<CentreonConfig> = {}): CentreonConfig {
  return {
    ...defaultCenteronConfig(),
    transport: 'clapi',
    clapiMode: 'local',
    clapiHost: '192.168.1.130',
    clapiUser: 'clapi',
    clapiPassword: 'pw',
    ...over,
  };
}

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
  // FIDÈLE à l'API réelle : un service référence son hôte via un tableau
  // `hosts` (pas `host_id`, qui est null dans la réponse).
  services: Array<{ id: number; name: string; hosts: Array<{ id: number; name: string }> }>;
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
  const calls: Array<{ method: string; path: string; query: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const u = new URL(String(input));
    const path = u.pathname.replace(/^.*\/api\/latest/, '');
    const q = new URLSearchParams(u.search);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, query: u.search, body });

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
    // FIDÈLE à l'API réelle : seul `filter[name]` (match exact) filtre
    // (`?name=` est ignoré).
    if (path === '/configuration/hosts' && method === 'GET') {
      const name = q.get('filter[name]');
      const result = world.hosts.filter((h) => !name || h.name === name);
      return json({ result });
    }
    if (path === '/configuration/hosts' && method === 'POST') {
      const id = world.nextId++;
      world.hosts.push({ id, name: body!.name, address: body!.address });
      return json({ id }, 201);
    }
    m = path.match(/^\/configuration\/hosts\/(\d+)$/);
    if (m && method === 'DELETE') {
      const idx = world.hosts.findIndex((h) => h.id === Number(m![1]));
      if (idx === -1) return notFound(`DELETE ${path}`);
      world.hosts.splice(idx, 1);
      return json(null, 204);
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
    // FIDÈLE à l'API réelle : `name`/`host_id` sont IGNORÉS, seul `filter[name]`
    // (match exact) filtre côté serveur. (Sans ce filtre, la liste est renvoyée
    // entière — d'où l'importance du .find() côté client dans le code.)
    // Pagination : limite 10/page imposée (page_size ignoré) + meta.total.
    if (path === '/configuration/services' && method === 'GET') {
      const name = q.get('filter[name]');
      const all = world.services.filter((s) => !name || s.name === name);
      const page = Number(q.get('page') ?? 1);
      const LIMIT = 10;
      const start = (page - 1) * LIMIT;
      const result = all.slice(start, start + LIMIT);
      return json({ result, meta: { page, limit: LIMIT, total: all.length } });
    }
    if (path === '/configuration/services' && method === 'POST') {
      const id = world.nextId++;
      const host = world.hosts.find((h) => h.id === (body!.host_id as number));
      world.services.push({
        id,
        name: body!.name as string,
        hosts: host ? [{ id: host.id, name: host.name }] : [],
      });
      return json({ id }, 201);
    }
    m = path.match(/^\/configuration\/services\/(\d+)$/);
    if (m && method === 'PATCH') return json(null, 204);
    if (m && method === 'DELETE') {
      const idx = world.services.findIndex((s) => s.id === Number(m![1]));
      if (idx === -1) return notFound(`DELETE ${path}`);
      world.services.splice(idx, 1);
      return json(null, 204);
    }

    return notFound(`${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
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
      services: [{ id: 5, name: 'Prox4u-Alarm-CPU', hosts: [{ id: 1, name: 'vm-100' }] }],
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

describe('deleteCenteronService — REST /api/latest/ (GitHub #20)', () => {
  it('service présent → DELETE + generate/reload du poller (status deleted)', async () => {
    const world = makeWorld({
      hosts: [{ id: 1, name: 'vm-100', address: '10.0.0.5' }],
      services: [{ id: 5, name: 'Prox4u-Alarm-CPU', hosts: [{ id: 1, name: 'vm-100' }] }],
    });
    const { calls } = installFetch(world);
    const r = await deleteCenteronService(restCfg(), 'vm-100', 'Prox4u-Alarm-CPU', POLLER);
    expect(r.status).toBe('deleted');
    expect(world.services).toHaveLength(0);
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain('GET /configuration/services');
    expect(paths).toContain('DELETE /configuration/services/5');
    expect(paths).toContain('GET /configuration/monitoring-servers/1/generate');
    expect(paths).toContain('GET /configuration/monitoring-servers/1/reload');
  });

  it('service absent → not-found (idempotent, PAS de generate/reload)', async () => {
    const world = makeWorld();
    const { calls } = installFetch(world);
    const r = await deleteCenteronService(restCfg(), 'vm-100', 'Prox4u-Alarm-CPU', POLLER);
    expect(r.status).toBe('not-found');
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain('GET /configuration/services');
    expect(paths).not.toContain('DELETE /configuration/services/5');
    expect(paths).not.toContain('GET /configuration/monitoring-servers/1/generate');
  });

  it('plusieurs services → supprime le BON (filter[name] exact, pas le 1er de la liste)', async () => {
    // Régression E2E : l'API ignore `name` → sans `filter[name]`, on supprimait
    // le 1er service de la liste (ici id 3) au lieu de la cible (id 17).
    const world = makeWorld({
      services: [
        { id: 3, name: 'Prox4u-Alarm-CPU-CPU_ia-u24', hosts: [{ id: 2, name: 'ia-u24-01' }] },
        { id: 17, name: 'Prox4u-Alarm-E2E20b', hosts: [{ id: 1, name: 'proxmox' }] },
      ],
    });
    const { calls } = installFetch(world);
    const r = await deleteCenteronService(restCfg(), 'proxmox', 'Prox4u-Alarm-E2E20b', POLLER);
    expect(r.status).toBe('deleted');
    // seul E2E20b (id 17) est supprimé, le service réel (id 3) reste
    expect(world.services).toHaveLength(1);
    expect(world.services[0].name).toBe('Prox4u-Alarm-CPU-CPU_ia-u24');
    // la requête utilise bien le SEUL filtre fonctionnel de l'API : filter[name]
    // (et PAS `name=` qui est ignoré par Centreon)
    const getCall = calls.find((c) => c.method === 'GET' && c.path === '/configuration/services');
    expect(getCall).toBeDefined();
    expect(getCall!.query).toBe('?filter[name]=Prox4u-Alarm-E2E20b');
  });

  it('erreur réseau (fetch throw) → error, jamais d\'exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed: ECONNREFUSED'); }));
    const r = await deleteCenteronService(restCfg(), 'vm-100', 'Prox4u-Alarm-CPU', POLLER);
    expect(r.status).toBe('error');
    expect(r.message).toContain('ECONNREFUSED');
  });

  it('token manquant → error avant tout appel HTTP', async () => {
    const { fetchMock } = installFetch(makeWorld());
    const r = await deleteCenteronService(restCfg({ restToken: '' }), 'vm-100', 'Prox4u-Alarm-CPU', POLLER);
    expect(r.status).toBe('error');
    expect(r.message).toContain('token');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('deleteCenteronService — CLAPI (GitHub #20)', () => {
  it('séquence complète (del + POLLERGENERATE + CFGMOVE) → deleted', async () => {
    const spawnMock = mockClapiSequence([
      { code: 0, out: 'ok' },
      { code: 0, out: 'ok' },
      { code: 0, out: 'ok' },
    ]);
    const r = await deleteCenteronService(clapiCfg(), 'vm-100', 'Prox4u-Alarm-CPU', POLLER);
    expect(r.status).toBe('deleted');
    expect(spawnMock).toHaveBeenCalledTimes(3);
    // 1ʳᵉ ligne = SERVICE -a del (clapiDeleteCommand)
    const firstLine = String(spawnMock.mock.calls[0][1]?.[3] ?? spawnMock.mock.calls[0][1]?.[1]);
    expect(firstLine).toContain('SERVICE -a del');
  });

  it('SERVICE -a del « not found » → not-found (idempotent, pas de generate/move)', async () => {
    const spawnMock = mockClapiSequence([
      { code: 1, err: 'ERROR: service not found' },
    ]);
    const r = await deleteCenteronService(clapiCfg(), 'vm-100', 'Prox4u-Alarm-CPU', POLLER);
    expect(r.status).toBe('not-found');
    expect(spawnMock).toHaveBeenCalledTimes(1); // s'arrête après le del
  });

  it('SERVICE -a del échec non « not found » → error', async () => {
    mockClapiSequence([{ code: 1, err: 'connection refused' }]);
    const r = await deleteCenteronService(clapiCfg(), 'vm-100', 'Prox4u-Alarm-CPU', POLLER);
    expect(r.status).toBe('error');
    expect(r.message).toContain('connection refused');
  });

  it('hôte CLAPI non configuré → error avant tout spawn', async () => {
    const spawnMock = mockClapiSequence([{ code: 0, out: 'ok' }]);
    const r = await deleteCenteronService(clapiCfg({ clapiHost: '' }), 'vm-100', 'Prox4u-Alarm-CPU', POLLER);
    expect(r.status).toBe('error');
    expect(r.message).toContain('non configurés');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('provisionService — hostCreated (GitHub #21)', () => {
  it('hôte absent → auto-créé → hostCreated true', async () => {
    installFetch(makeWorld());
    const r = await provisionService(restCfg(), 'vm-100', 'Prox4u-Alarm-CPU', POLLER, '10.0.0.5');
    expect(r.ok).toBe(true);
    expect(r.hostCreated).toBe(true);
  });

  it('hôte présent (préexistant) → hostCreated false', async () => {
    installFetch(makeWorld({
      hosts: [{ id: 1, name: 'vm-100', address: '10.0.0.5' }],
      services: [{ id: 5, name: 'Prox4u-Alarm-CPU', hosts: [{ id: 1, name: 'vm-100' }] }],
    }));
    const r = await provisionService(restCfg(), 'vm-100', 'Prox4u-Alarm-CPU', POLLER, '10.0.0.5');
    expect(r.ok).toBe(true);
    expect(r.hostCreated).toBe(false);
  });

  it('CLAPI → hostCreated false (présume l\'hôte existant)', async () => {
    mockClapiSequence([{ code: 0, out: 'ok' }, { code: 0, out: 'ok' }, { code: 0, out: 'ok' }, { code: 0, out: 'ok' }, { code: 0, out: 'ok' }, { code: 0, out: 'ok' }, { code: 0, out: 'ok' }, { code: 0, out: 'ok' }]);
    const r = await provisionService(clapiCfg(), 'vm-100', 'Prox4u-Alarm-CPU', POLLER, '10.0.0.5');
    expect(r.ok).toBe(true);
    expect(r.hostCreated).toBe(false);
  });
});

describe('deleteCenteronHost — REST /api/latest/ (GitHub #21)', () => {
  it('hôte présent → DELETE + generate/reload du poller (status deleted)', async () => {
    const world = makeWorld({
      hosts: [{ id: 1, name: 'vm-100', address: '10.0.0.5' }],
    });
    const { calls } = installFetch(world);
    const r = await deleteCenteronHost(restCfg(), 'vm-100', POLLER);
    expect(r.status).toBe('deleted');
    expect(world.hosts).toHaveLength(0);
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain('GET /configuration/hosts');
    expect(paths).toContain('DELETE /configuration/hosts/1');
    expect(paths).toContain('GET /configuration/monitoring-servers/1/generate');
    expect(paths).toContain('GET /configuration/monitoring-servers/1/reload');
  });

  it('hôte absent → not-found (idempotent, PAS de generate/reload)', async () => {
    const world = makeWorld();
    const { calls } = installFetch(world);
    const r = await deleteCenteronHost(restCfg(), 'vm-100', POLLER);
    expect(r.status).toBe('not-found');
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain('GET /configuration/hosts');
    expect(paths).not.toContain('DELETE /configuration/hosts/1');
    expect(paths).not.toContain('GET /configuration/monitoring-servers/1/generate');
  });

  it('plusieurs hôtes → supprime le BON (filter[name] exact)', async () => {
    const world = makeWorld({
      hosts: [
        { id: 2, name: 'ia-u24-01', address: '10.0.0.1' },
        { id: 3, name: 'proxmox', address: '192.168.1.80' },
      ],
    });
    installFetch(world);
    const r = await deleteCenteronHost(restCfg(), 'proxmox', POLLER);
    expect(r.status).toBe('deleted');
    // seul « proxmox » (id 3) est supprimé, ia-u24-01 (id 2) reste
    expect(world.hosts).toHaveLength(1);
    expect(world.hosts[0].name).toBe('ia-u24-01');
  });

  it('erreur réseau (fetch throw) → error, jamais d\'exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed: ECONNREFUSED'); }));
    const r = await deleteCenteronHost(restCfg(), 'vm-100', POLLER);
    expect(r.status).toBe('error');
    expect(r.message).toContain('ECONNREFUSED');
  });

  it('token manquant → error avant tout appel HTTP', async () => {
    const { fetchMock } = installFetch(makeWorld());
    const r = await deleteCenteronHost(restCfg({ restToken: '' }), 'vm-100', POLLER);
    expect(r.status).toBe('error');
    expect(r.message).toContain('token');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('deleteCenteronHost — CLAPI (GitHub #21)', () => {
  it('séquence complète (HOST del + POLLERGENERATE + CFGMOVE) → deleted', async () => {
    const spawnMock = mockClapiSequence([
      { code: 0, out: 'ok' },
      { code: 0, out: 'ok' },
      { code: 0, out: 'ok' },
    ]);
    const r = await deleteCenteronHost(clapiCfg(), 'vm-100', POLLER);
    expect(r.status).toBe('deleted');
    expect(spawnMock).toHaveBeenCalledTimes(3);
    const firstLine = String(spawnMock.mock.calls[0][1]?.[3] ?? spawnMock.mock.calls[0][1]?.[1]);
    expect(firstLine).toContain('HOST -a del');
  });

  it('HOST -a del « not found » → not-found (idempotent, pas de generate/move)', async () => {
    const spawnMock = mockClapiSequence([
      { code: 1, err: 'ERROR: host not found' },
    ]);
    const r = await deleteCenteronHost(clapiCfg(), 'vm-100', POLLER);
    expect(r.status).toBe('not-found');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('HOST -a del échec non « not found » → error', async () => {
    mockClapiSequence([{ code: 1, err: 'connection refused' }]);
    const r = await deleteCenteronHost(clapiCfg(), 'vm-100', POLLER);
    expect(r.status).toBe('error');
    expect(r.message).toContain('connection refused');
  });
});

describe('countHostServices (GitHub #21)', () => {
  it('REST : hôte avec 2 services → 2', async () => {
    installFetch(makeWorld({
      hosts: [{ id: 1, name: 'vm-100', address: '10.0.0.5' }],
      services: [
        { id: 5, name: 'Prox4u-Alarm-CPU', hosts: [{ id: 1, name: 'vm-100' }] },
        { id: 6, name: 'Prox4u-Alarm-RAM', hosts: [{ id: 1, name: 'vm-100' }] },
      ],
    }));
    expect(await countHostServices(restCfg(), 'vm-100')).toBe(2);
  });

  it('REST : hôte sans service (services sur autre hôte) → 0', async () => {
    installFetch(makeWorld({
      hosts: [
        { id: 1, name: 'vm-100', address: '10.0.0.5' },
        { id: 2, name: 'vm-200', address: '10.0.0.6' },
      ],
      services: [
        { id: 5, name: 'Prox4u-Alarm-CPU', hosts: [{ id: 2, name: 'vm-200' }] },
      ],
    }));
    expect(await countHostServices(restCfg(), 'vm-100')).toBe(0);
  });

  it('REST : hôte absent → 0', async () => {
    installFetch(makeWorld());
    expect(await countHostServices(restCfg(), 'vm-100')).toBe(0);
  });

  it('REST : central down (fetch throw) → null (inconnu, conservatif)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed: ECONNREFUSED'); }));
    expect(await countHostServices(restCfg(), 'vm-100')).toBeNull();
  });

  it('CLAPI → null (inconnu, conservatif)', async () => {
    expect(await countHostServices(clapiCfg(), 'vm-100')).toBeNull();
  });
});
