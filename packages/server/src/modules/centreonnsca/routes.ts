import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  buildNscaFrame,
  NSCA_OK,
  type AlarmRule,
  type CentreonConfig,
  type CentreonPoller,
  type MetricId,
  type VmMapping,
} from '@prox4u/shared';
import type { Poller } from '../../core/poller.js';
import { CLUSTER_METRICS, NODE_METRICS, VM_METRICS } from './metrics.js';
import { sendNsca } from './nsca.js';
import { provisionService } from './provision.js';
import type { NscaStore } from './store.js';

/**
 * API REST du module Alarmes & Checks NSCA — préfixe /api/alarms/* (générique
 * : un futur backend Zabbix partagera le namespace). L'auth (guard) est
 * appliquée par le module auth ; les actions d'écriture exigent la session.
 *
 * - GET  /api/alarms                 → règles + pollers + stats (+ métriques dispo)
 * - POST /api/alarms/rules           → création + provisioning Centreon
 * - PATCH /api/alarms/rules/:id      → édition (y compris toggle actif)
 * - DELETE /api/alarms/rules/:id     → suppression
 * - POST /api/alarms/rules/:id/test  → trame NSCA de test immédiate
 * - POST /api/alarms/rules/:id/provision → re-provisionnement CLAPI/REST
 * - GET  /api/alarms/targets         → VMs + nœuds (dropdowns du formulaire)
 * - GET/PUT /api/alarms/config       → config Centreon + pollers + mappings
 */

function maskConfig(cfg: CentreonConfig): Record<string, unknown> {
  // Les mots de passe/token ne sont JAMAIS renvoyés en clair par l'API :
  // un booléen « configuré » suffit à l'UI (pré-remplissage non requis).
  return {
    ...cfg,
    clapiPassword: cfg.clapiPassword ? '••••••' : '',
    restToken: cfg.restToken ? '••••••' : '',
    nsca: { ...cfg.nsca, password: cfg.nsca.password ? '••••••' : '' },
  };
}

/**
 * IP de la cible de la règle (VM ou nœud Proxmox) depuis le snapshot du poller —
 * sert au provisioning REST à créer l'hôte Centreon s'il est absent. `undefined`
 * si inconnue (snapshot absent, cible cluster, VM sans IP rapportée).
 */
function hostAddressFor(rule: AlarmRule, poller: Poller): string | undefined {
  const multi = poller.getMulti();
  const snap = multi?.endpoints.find((e) => e.id === rule.target.endpointId)?.snapshot;
  if (!snap) return undefined;
  if (rule.target.kind === 'vm' && rule.target.vmid != null) {
    return snap.vms.find((v) => v.vmid === rule.target.vmid)?.ipAddresses?.[0];
  }
  if (rule.target.kind === 'node' && rule.target.node) {
    return snap.nodes.find((n) => n.node === rule.target.node)?.ip;
  }
  return undefined;
}

export function registerAlarmRoutes(
  app: FastifyInstance,
  store: NscaStore,
  dataDir: string,
  _poller: Poller,
): void {
  app.get('/api/alarms', async () => {
    return {
      rules: store.listRules(),
      pollers: store.listPollers(),
      stats: store.stats(),
      config: maskConfig(store.getConfig()),
      envSecrets: store.envSecretFlags(),
      metrics: { vm: VM_METRICS, node: NODE_METRICS, cluster: CLUSTER_METRICS },
    };
  });

  /** Cibles disponibles : VMs (par endpoint) + nœuds + clusters (quorum). */
  app.get('/api/alarms/targets', async () => {
    const multi = _poller.getMulti();
    const vms: Array<{ endpointId: string; vmid: number; name: string; node: string }> = [];
    const nodes: Array<{ endpointId: string; node: string; online: boolean }> = [];
    const clusters: Array<{ endpointId: string; name: string }> = [];
    const mappings = new Map(store.listMappings().map((m) => [`${m.endpointId}/${m.vmid}`, m.centreonHost]));
    if (multi) {
      for (const ep of multi.endpoints) {
        if (!ep.snapshot) continue;
        clusters.push({ endpointId: ep.id, name: ep.snapshot.cluster.name });
        for (const v of ep.snapshot.vms) {
          vms.push({ endpointId: ep.id, vmid: v.vmid, name: v.name, node: v.node });
        }
        for (const n of ep.snapshot.nodes) {
          nodes.push({ endpointId: ep.id, node: n.node, online: n.online });
        }
      }
    }
    return { vms, nodes, clusters, mappings: [...mappings.entries()].map(([k, host]) => ({ key: k, host })) };
  });

  /**
   * Création d'une règle + provisioning Centreon (CLAPI ou REST) + déploiement.
   * Robustesse : échec de provisioning → règle enregistrée, statut « erreur »
   * + message (aucun crash). Le mapping VM→hôte est upserté (override manuel).
   */
  app.post('/api/alarms/rules', async (req, reply) => {
    const body = req.body as Partial<AlarmRule>;
    const missing: string[] = [];
    if (!body.name?.trim()) missing.push('name');
    if (!body.target?.endpointId || !body.target.label) missing.push('target');
    if (body.target?.kind === 'vm' && body.target.vmid === undefined) missing.push('target.vmid');
    if (body.target?.kind === 'node' && !body.target.node) missing.push('target.node');
    if (
      !body.metric ||
      (!(VM_METRICS as MetricId[]).includes(body.metric) &&
        !(NODE_METRICS as MetricId[]).includes(body.metric) &&
        !(CLUSTER_METRICS as MetricId[]).includes(body.metric))
    ) {
      missing.push('metric');
    }
    if (typeof body.threshold !== 'number') missing.push('threshold');
    if (typeof body.confirmSeconds !== 'number' || body.confirmSeconds < 0) missing.push('confirmSeconds');
    if (!body.pollerId) missing.push('pollerId');
    if (!body.centreonHost?.trim()) missing.push('centreonHost');
    if (!body.centreonService?.trim()) missing.push('centreonService');
    if (missing.length > 0) {
      return reply.code(400).send({ error: 'champs manquants ou invalides', fields: missing });
    }
    // Locaux non-nuls (le narrowing via l'array `missing` est invisible à tsc).
    const name = body.name!.trim();
    const target = body.target!;
    const metric = body.metric!;
    const threshold = body.threshold!;
    const confirmSeconds = body.confirmSeconds!;
    const pollerId = body.pollerId!;
    const centreonHost = body.centreonHost!.trim();
    const centreonService = body.centreonService!.trim();
    if (store.listRules().some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      return reply.code(409).send({ error: 'rule-name-exists', message: `une règle « ${name} » existe déjà` });
    }
    const poller = store.pollerById(pollerId);
    if (!poller) return reply.code(400).send({ error: 'poller-inconnu', message: `poller « ${pollerId} » inconnu` });

    // Mapping VM→hôte : upsert (override manuel du formulaire)
    if (target.kind === 'vm') {
      store.upsertMapping({
        endpointId: target.endpointId,
        vmid: target.vmid!,
        vmName: target.label,
        centreonHost,
      } satisfies VmMapping);
    }

    const rule = store.createRule({
      name,
      target,
      metric,
      operator: body.operator ?? '>',
      threshold,
      confirmSeconds,
      severity: body.severity ?? 'crit',
      pollerId,
      centreonHost,
      centreonService,
      messageTemplate: body.messageTemplate?.trim() || 'Alarme Prox4u — {{vm}} : {{metric}} = {{value}} (seuil {{threshold}})',
      active: body.active ?? true,
      provisionStatus: 'pending',
      provisionMessage: 'provisionnement en cours…',
      lastSendState: null,
      lastSendMessage: '',
      lastAlarmAt: null,
      lastOkSendAt: null,
      lastOutput: '',
      currentState: 'ok',
    });

    // Provisionnement (ne bloque pas la création : échec → statut erreur).
    // hostAddress = IP de la cible (snapshot) → le REST peut créer l'hôte absent.
    const cfg = store.getConfig();
    const prov = await provisionService(cfg, rule.centreonHost, rule.centreonService, poller, hostAddressFor(rule, _poller));
    store.updateRule(rule.id, {
      provisionStatus: prov.ok ? 'ok' : 'error',
      provisionMessage: prov.message,
    });
    return reply.code(201).send({ rule, provision: prov });
  });

  /** Édition d'une règle (y compris le toggle actif/inactif). */
  app.patch('/api/alarms/rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Partial<AlarmRule>;
    try {
      const rule = store.updateRule(id, body);
      return { rule };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/alarms/rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      store.deleteRule(id);
      return { ok: true };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  /** Trame NSCA de test immédiate (return code 0, message « Prox4u test »). */
  app.post('/api/alarms/rules/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rule = store.ruleById(id);
    if (!rule) return reply.code(404).send({ error: 'rule-not-found' });
    const cfg = store.getConfig();
    // Destination NSCA : IP du poller cible si renseignée, sinon le central.
    const poller = store.pollerById(rule.pollerId);
    const output = 'Prox4u — trame de test (check passif NSCA)';
    const frame = buildNscaFrame(rule.centreonHost, rule.centreonService, NSCA_OK, output);
    const send = await sendNsca({ ...cfg.nsca, server: poller?.ip || cfg.nsca.server }, frame, path.join(dataDir, 'nsca'));
    store.updateRule(id, {
      lastSendState: send.ok ? 'ok' : 'error',
      lastSendMessage: send.message,
      lastOutput: output,
    });
    return { ok: send.ok, code: NSCA_OK, message: send.message };
  });

  /** Re-provisionnement (relance la création CLAPI/REST si échec). */
  app.post('/api/alarms/rules/:id/provision', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rule = store.ruleById(id);
    if (!rule) return reply.code(404).send({ error: 'rule-not-found' });
    const poller = store.pollerById(rule.pollerId);
    if (!poller) return reply.code(400).send({ error: 'poller-inconnu' });
    store.updateRule(id, { provisionStatus: 'pending', provisionMessage: 're-provisionnement en cours…' });
    const prov = await provisionService(store.getConfig(), rule.centreonHost, rule.centreonService, poller, hostAddressFor(rule, _poller));
    store.updateRule(id, {
      provisionStatus: prov.ok ? 'ok' : 'error',
      provisionMessage: prov.message,
    });
    return { ok: prov.ok, message: prov.message };
  });

  // ---------- Configuration du module (Page 3 admin) ----------

  app.get('/api/alarms/config', async () => {
    return {
      config: maskConfig(store.getConfig()),
      envSecrets: store.envSecretFlags(),
      pollers: store.listPollers(),
      mappings: store.listMappings(),
    };
  });

  /**
   * Enregistre la config + pollers + mappings. Les champs masqués (••••••)
   * signifient « inchangé » → le mot de passe/token existant est conservé.
   */
  app.put('/api/alarms/config', async (req) => {
    const body = req.body as {
      config?: Omit<Partial<CentreonConfig>, 'nsca'> & { nsca?: Partial<CentreonConfig['nsca']> };
      pollers?: CentreonPoller[];
      mappings?: VmMapping[];
    };
    if (body.pollers) store.setPollers(body.pollers);
    if (body.mappings) store.setMappings(body.mappings);
    if (body.config) {
      const { nsca, ...rest } = body.config;
      const patch: Omit<Partial<CentreonConfig>, 'nsca'> & { nsca?: Partial<CentreonConfig['nsca']> } = { ...rest };
      // champs masqués → non modifiés
      if (patch.clapiPassword === '••••••') delete patch.clapiPassword;
      if (patch.restToken === '••••••') delete patch.restToken;
      if (nsca) {
        if (nsca.password === '••••••') delete nsca.password;
        if (Object.keys(nsca).length > 0) patch.nsca = nsca;
      }
      store.setConfig(patch);
    }
    return { ok: true };
  });
}
