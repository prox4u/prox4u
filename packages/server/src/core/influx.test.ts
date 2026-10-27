import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLine, escapeFieldString, escapeTag, influxTsToUnix, InfluxClient, type SqlRow } from './influx.js';
import type { InfluxConfig } from './config.js';

const cfg: InfluxConfig = {
  enabled: true,
  url: 'http://localhost:8181',
  token: 'apiv3_test',
  rawDb: 'raw',
  aggDb: 'consolidated',
  rrdDb: 'proxmox',
  caCert: '',
};

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): MockedFetch {
  const fn = vi.fn(handler);
  vi.stubGlobal('fetch', fn);
  return fn as unknown as MockedFetch;
}

type MockedFetch = ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildLine', () => {
  it('construit une ligne simple sans tags', () => {
    expect(buildLine('node_metrics', {}, { cpu_pct: 12.5 }, 1_700_000_000)).toBe(
      'node_metrics cpu_pct=12.5 1700000000',
    );
  });

  it('construit une ligne avec tags et champs mixtes', () => {
    expect(
      buildLine('vm_metrics', { node: 'pve1', vmid: '101' }, { cpu_pct: 42, mem_bytes: 1073741824 }, 1_700_000_005),
    ).toBe('vm_metrics,node=pve1,vmid=101 cpu_pct=42,mem_bytes=1073741824 1700000005');
  });

  it('échappe les tags (virgule, égal, espace)', () => {
    expect(escapeTag('a,b=c d')).toBe('a\\,b\\=c\\ d');
    expect(buildLine('m', { node: 'a b' }, { f: 1 }, 5)).toBe('m,node=a\\ b f=1 5');
  });

  it('encode les champs string avec guillemets échappés', () => {
    expect(escapeFieldString('say "hi"')).toBe('"say \\"hi\\""');
    expect(buildLine('m', {}, { name: 'a"b' }, 5)).toBe('m name="a\\"b" 5');
  });
});

describe('influxTsToUnix', () => {
  it('force le Z sur un ISO sans fuseau (UTC InfluxDB)', () => {
    expect(influxTsToUnix('2026-10-01T15:54:00')).toBe(Math.floor(Date.parse('2026-10-01T15:54:00Z') / 1000));
  });

  it('ne double pas le Z si déjà présent', () => {
    expect(influxTsToUnix('2026-10-01T15:54:00Z')).toBe(Math.floor(Date.parse('2026-10-01T15:54:00Z') / 1000));
  });

  it('gère un décalage explicite +02:00', () => {
    expect(influxTsToUnix('2026-10-01T17:54:00+02:00')).toBe(Math.floor(Date.parse('2026-10-01T15:54:00Z') / 1000));
  });

  it('accepte un epoch en secondes', () => {
    expect(influxTsToUnix(1_790_870_040)).toBe(1_790_870_040);
  });

  it('convertit un epoch en millisecondes', () => {
    expect(influxTsToUnix(1_790_870_040_000)).toBe(1_790_870_040);
  });

  it('renvoie 0 pour null/undefined', () => {
    expect(influxTsToUnix(null)).toBe(0);
  });
});

describe('InfluxClient.writeLp', () => {
  it('POST /api/v3/write_lp avec Bearer token et précision seconde', async () => {
    const fetchFn = mockFetch((url, init) => {
      expect(String(url)).toBe('http://localhost:8181/api/v3/write_lp?db=raw&precision=s');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer apiv3_test');
      expect(init?.body).toBe('m f=1 5\nm f=2 6');
      return new Response(null, { status: 204 });
    });
    const client = new InfluxClient(cfg);
    await client.writeLp('raw', ['m f=1 5', 'm f=2 6']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('lève une erreur sur HTTP non 2xx', async () => {
    mockFetch(() => new Response('forbidden', { status: 403 }));
    const client = new InfluxClient(cfg);
    await expect(client.writeLp('raw', ['m f=1 5'])).rejects.toThrow(/HTTP 403/);
  });
});

describe('InfluxClient.querySql', () => {
  it('mappe columns/values en objets', async () => {
    mockFetch((url, init) => {
      expect(String(url)).toBe('http://localhost:8181/api/v3/query_sql');
      const body = JSON.parse(String(init?.body)) as { db: string; q: string };
      expect(body.db).toBe('raw');
      expect(body.q).toContain('SELECT');
      return Response.json({
        results: [
          {
            series: [
              {
                columns: ['t', 'node', 'cpu_pct'],
                name: 'node_metrics',
                values: [
                  ['2025-10-01T00:00:00Z', 'pve1', 12.5],
                  ['2025-10-01T00:05:00Z', 'pve1', null],
                ],
              },
            ],
          },
        ],
      });
    });
    const client = new InfluxClient(cfg);
    const rows = await client.querySql<SqlRow>('raw', 'SELECT 1');
    expect(rows).toEqual([
      { t: '2025-10-01T00:00:00Z', node: 'pve1', cpu_pct: 12.5 },
      { t: '2025-10-01T00:05:00Z', node: 'pve1', cpu_pct: null },
    ]);
  });

  it('accepte le format tableau d’objets (défaut InfluxDB 3)', async () => {
    mockFetch(() =>
      Response.json([
        { t: '2026-10-01T15:54:00', node: 'proxmox', cpu_pct: 0.38 },
        { t: '2026-10-01T15:53:00', node: 'proxmox', cpu_pct: null },
      ]),
    );
    const client = new InfluxClient(cfg);
    const rows = await client.querySql<SqlRow>('raw', 'SELECT 1');
    expect(rows).toEqual([
      { t: '2026-10-01T15:54:00', node: 'proxmox', cpu_pct: 0.38 },
      { t: '2026-10-01T15:53:00', node: 'proxmox', cpu_pct: null },
    ]);
  });

  it('renvoie [] quand il n’y a pas de série', async () => {
    mockFetch(() => Response.json({ results: [{ series: [] }] }));
    const client = new InfluxClient(cfg);
    await expect(client.querySql('raw', 'SELECT 1')).resolves.toEqual([]);
  });

  it('lève une erreur sur HTTP non 2xx', async () => {
    mockFetch(() => new Response('bad sql', { status: 400 }));
    const client = new InfluxClient(cfg);
    await expect(client.querySql('raw', 'SELECT oops')).rejects.toThrow(/HTTP 400/);
  });
});

describe('InfluxClient.createDatabase', () => {
  it('POST /api/v3/configure/database avec retention_period', async () => {
    const fetchFn = mockFetch((url, init) => {
      expect(String(url)).toBe('http://localhost:8181/api/v3/configure/database');
      expect(JSON.parse(String(init?.body))).toEqual({ db: 'raw', retention_period: '31d' });
      return new Response(null, { status: 201 });
    });
    const client = new InfluxClient(cfg);
    await client.createDatabase('raw', '31d');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('omet retention_period quand il est absent (rétention infinie)', async () => {
    const fetchFn = mockFetch((_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ db: 'consolidated' });
      return new Response(null, { status: 201 });
    });
    const client = new InfluxClient(cfg);
    await client.createDatabase('consolidated');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('ignore le 409 (base existante)', async () => {
    mockFetch(() => new Response('exists', { status: 409 }));
    const client = new InfluxClient(cfg);
    await expect(client.createDatabase('raw', '31d')).resolves.toBeUndefined();
  });
});

describe('InfluxClient.enqueue/flush', () => {
  // laisse s'achever le flush coalescé (délai 25 ms)
  const settle = () => new Promise((r) => setTimeout(r, 60));

  it('écrit les lignes enfileées par lot', async () => {
    const fetchFn = mockFetch(() => new Response(null, { status: 204 }));
    const client = new InfluxClient(cfg);
    client.enqueue('m f=1 5');
    client.enqueue('m f=2 6');
    await settle();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String((fetchFn.mock.calls[0][1] as RequestInit).body)).toBe('m f=1 5\nm f=2 6');
    expect(client.pending).toBe(0);
  });

  it('ré-enfile le lot en cas d’échec (reprise au prochain flush)', async () => {
    const fetchFn = mockFetch(() => new Response('down', { status: 503 }));
    const client = new InfluxClient(cfg);
    client.enqueue('m f=1 5');
    await settle();
    expect(client.pending).toBe(1);

    fetchFn.mockImplementation(() => new Response(null, { status: 204 }));
    await client.flush();
    expect(client.pending).toBe(0);
  });

  it('ne fait rien si InfluxDB est désactivé', async () => {
    const fetchFn = mockFetch(() => new Response(null, { status: 204 }));
    const client = new InfluxClient({ ...cfg, enabled: false });
    client.enqueue('m f=1 5');
    await settle();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(client.pending).toBe(0);
  });
});

describe('InfluxClient.ping', () => {
  it('renvoie true sur 2xx', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(new InfluxClient(cfg).ping()).resolves.toBe(true);
  });

  it('renvoie false en cas d’erreur réseau', async () => {
    mockFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(new InfluxClient(cfg).ping()).resolves.toBe(false);
  });
});
