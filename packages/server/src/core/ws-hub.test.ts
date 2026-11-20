import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { DEFAULT_OVERCOMMIT_CONFIG, type MultiDashboardSnapshot } from '@prox4u/shared';
import { WsHub } from './ws-hub.js';

/** Snapshot minimal pour les tests. */
function snap(generatedAt: number): MultiDashboardSnapshot {
  return {
    generatedAt,
    mock: true,
    defaultEndpointId: 'ep1',
    overcommit: DEFAULT_OVERCOMMIT_CONFIG,
    endpoints: [],
    globalPra: null,
  };
}

/** Résout avec le 1er message du client (ou null après `timeoutMs`). */
function firstMessage(ws: WebSocket, timeoutMs = 1500): Promise<{ type: string; data?: unknown } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    ws.on('message', (data) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()));
      } catch {
        resolve(null);
      }
    });
  });
}

describe('WsHub', () => {
  let server: Server;
  let hub: WsHub;
  let url: string;
  const clients: WebSocket[] = [];

  const connect = (): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      clients.push(ws);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });

  beforeAll(async () => {
    server = createServer();
    hub = new WsHub();
    hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    url = `ws://127.0.0.1:${port}/ws`;
  });

  afterAll(async () => {
    for (const c of clients) c.terminate();
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sans snapshot connu : le connect ne reçoit rien (pas de message fantôme)', async () => {
    // Aucun broadcast avant → lastSnapshot null → pas de snapshot immédiat.
    const ws = await connect();
    const msg = await firstMessage(ws, 300);
    expect(msg).toBeNull();
  });

  it('broadcast → reçu par les clients connectés', async () => {
    const ws = await connect();
    hub.broadcast(snap(111));
    const msg = await firstMessage(ws);
    expect(msg?.type).toBe('snapshot');
  });

  it('nouveau connect → reçoit IMMÉDIATEMENT le dernier snapshot (sans attendre le tick 5 s)', async () => {
    // Le broadcast du test précédent a mémorisé lastSnapshot.
    // L'écouteur `message` est attaché AVANT l'open : le snapshot est envoyé au
    // connect, il ne doit pas être perdu entre l'open et l'attachement.
    const ws = new WebSocket(url);
    clients.push(ws);
    const msgPromise = firstMessage(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    const msg = await msgPromise;
    expect(msg?.type).toBe('snapshot');
    expect((msg!.data as MultiDashboardSnapshot).generatedAt).toBe(111);
  });
});
