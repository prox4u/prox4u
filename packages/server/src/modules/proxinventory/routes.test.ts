import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { PveVmResource } from '@prox4u/shared';
import type { DataSource } from '../../core/data-source.js';
import type { AppContext, EndpointRuntime, Poller } from '../../core/poller.js';
import { registerProxInventory } from './routes.js';

/** VM de test minimale (QEMU tournant). */
function vm(vmid: number): PveVmResource {
  return { vmid, name: `vm-${vmid}`, type: 'qemu', status: 'running', node: 'n1', cpu: 0, maxmem: 1024, mem: 512, maxdisk: 4096, disk: 2048, netin: 0, netout: 0, diskread: 0, diskwrite: 0, uptime: 0 };
}

/** Source stub qui compte les appels : getResources (1 par compute) + getAgentBundle (1 par VM). */
function makeSource(vms: PveVmResource[]) {
  let resources = 0;
  let bundles = 0;
  const source = {
    isMock: true,
    getResources: async () => {
      resources += 1;
      return vms;
    },
    getAgentBundle: async () => {
      bundles += 1;
      return { fs: null, osinfo: null, nets: [] };
    },
    cachedFsUsage: () => undefined,
  } as unknown as DataSource;
  return { source, resources: () => resources, bundles: () => bundles };
}

function makeCtx(endpoints: EndpointRuntime[]): AppContext {
  return {
    config: {} as AppContext['config'],
    endpoints,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    influx: {} as AppContext['influx'],
    auth: {} as AppContext['auth'],
    userConfig: {} as AppContext['userConfig'],
    hub: {} as AppContext['hub'],
  };
}

const poller = {} as Poller;
const CACHE_TTL_MS = 5 * 60 * 1000; // même valeur que routes.ts

describe('registerProxInventory', () => {
  it('cold start : calcule, met en cache, puis sert le cache (pas de recompute)', async () => {
    const { source, resources, bundles } = makeSource([vm(100), vm(101)]);
    const ep: EndpointRuntime = { id: 'e1', name: 'E1', url: 'https://x', source, sites: [] };
    const app = Fastify();
    registerProxInventory(app, makeCtx([ep]), poller);

    const r1 = await app.inject('/api/proxmox-inventory');
    expect(r1.statusCode).toBe(200);
    expect(r1.json().endpoints).toHaveLength(1);
    expect(r1.json().endpoints[0].vms).toHaveLength(2);
    expect(resources()).toBe(1); // un compute
    expect(bundles()).toBe(2); // un bundle par VM

    const r2 = await app.inject('/api/proxmox-inventory');
    expect(r2.json().endpoints[0].vms).toHaveLength(2);
    expect(resources()).toBe(1); // cache 5 min → pas de recompute
    expect(bundles()).toBe(2);
    await app.close();
  });

  it('endpoint down au cold start : renvoie vide sans lever', async () => {
    const source = {
      isMock: true,
      getResources: async () => {
        throw new Error('down');
      },
      getAgentBundle: async () => ({ fs: null, osinfo: null, nets: [] }),
      cachedFsUsage: () => undefined,
    } as unknown as DataSource;
    const ep: EndpointRuntime = { id: 'e2', name: 'E2', url: 'https://x', source, sites: [] };
    const app = Fastify();
    registerProxInventory(app, makeCtx([ep]), poller);

    const r1 = await app.inject('/api/proxmox-inventory');
    expect(r1.statusCode).toBe(200);
    expect(r1.json().endpoints).toEqual([]); // indispo → pas d'entrée
    await app.close();
  });

  it('stale-while-revalidate : sert la valeur périmée immédiatement + recompute background single-flight', async () => {
    vi.useFakeTimers();
    try {
      const { source, resources } = makeSource([vm(100), vm(101)]);
      const ep: EndpointRuntime = { id: 'e3', name: 'E3', url: 'https://x', source, sites: [] };
      const app = Fastify();
      registerProxInventory(app, makeCtx([ep]), poller);

      // 1er chargement (cold) : calcule et met en cache.
      const r1 = await app.inject('/api/proxmox-inventory');
      expect(r1.json().endpoints[0].vms).toHaveLength(2);
      expect(resources()).toBe(1);

      // Péremption du cache (5 min + un battement).
      vi.advanceTimersByTime(CACHE_TTL_MS + 10);

      // Requête sur cache périmé : sert IMMÉDIATEMENT l'ancienne valeur (2 VMs) et
      // déclenche un recompute en background (ne bloque pas la réponse).
      const r2 = await app.inject('/api/proxmox-inventory');
      expect(r2.json().endpoints[0].vms).toHaveLength(2); // valeur stale servie
      await vi.advanceTimersByTimeAsync(0); // laisse le recompute background terminer
      expect(resources()).toBe(2); // un seul recompute

      // single-flight : péremme à nouveau puis tire DEUX requêtes concurrentes sur cache
      // périmé → UN seul recompute (le 2e voit le 1e en vol et ne relance pas).
      vi.advanceTimersByTime(CACHE_TTL_MS + 10);
      const before = resources();
      const [ra, rb] = await Promise.all([
        app.inject('/api/proxmox-inventory'),
        app.inject('/api/proxmox-inventory'),
      ]);
      expect(ra.json().endpoints[0].vms).toHaveLength(2);
      expect(rb.json().endpoints[0].vms).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(0); // termine le recompute en vol
      expect(resources() - before).toBe(1); // pas 2 — single-flight

      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
