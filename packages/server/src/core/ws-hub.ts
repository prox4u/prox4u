import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { MultiDashboardSnapshot } from '@prox4u/shared';

/**
 * Hub WebSocket : pousse le snapshot multi-endpoints au rythme du poller (5 s).
 * Au connect, envoie immédiatement le dernier snapshot connu.
 */
export class WsHub {
  private wss: WebSocketServer | null = null;
  /** Dernier snapshot connu — renvoyé IMMÉDIATEMENT à un client qui se connecte
   *  (sans attendre le tick poller suivant, 5 s) : reconnexion/rechargement rapide. */
  private lastSnapshot: MultiDashboardSnapshot | null = null;

  /**
   * `verifyClient` rejette les upgrades non autorisés AVANT le handshake
   * (authentification : cookie de session httpOnly).
   */
  attach(server: Server, opts?: { verifyClient?: (req: IncomingMessage) => boolean }): void {
    const verify = opts?.verifyClient;
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      // ws passe { origin, secure, req } — on extrait la requête brute pour le callback.
      verifyClient: verify
        ? (info: { origin: string; secure: boolean; req: IncomingMessage }) => verify(info.req)
        : undefined,
    });
    this.wss.on('connection', (ws) => {
      ws.on('error', () => ws.close());
      // Snapshot immédiat au connect (le commentaire de classe le promettait déjà —
      // avant, le client attendait le tick 5 s suivant → reconnexion perçue lente).
      if (this.lastSnapshot) {
        ws.send(JSON.stringify({ type: 'snapshot', data: this.lastSnapshot }));
      }
    });
  }

  broadcast(snapshot: MultiDashboardSnapshot): void {
    this.lastSnapshot = snapshot;
    if (!this.wss) return;
    const payload = JSON.stringify({ type: 'snapshot', data: snapshot });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  /** Message ponctuel à tous les clients (ex. 'modules-changed' → reboot SPA). */
  push(type: string, data?: unknown): void {
    if (!this.wss) return;
    const payload = JSON.stringify(data === undefined ? { type } : { type, data });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  get clientCount(): number {
    return this.wss?.clients.size ?? 0;
  }

  close(): void {
    for (const client of this.wss?.clients ?? []) client.close();
    this.wss?.close();
    this.wss = null;
  }
}
