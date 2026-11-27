import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  buildNscaFrame,
  isSensorMetric,
  NSCA_OK,
  sensorTargetFields,
  type AlarmOperator,
  type AlarmRule,
  type AlarmTarget,
  type CentreonConfig,
  type CentreonPoller,
  type FailedUnit,
  type MetricId,
  type SensorAlarmData,
  type SensorReading,
  type SmartDevice,
  type VmMapping,
  type ZfsStatus,
} from '@prox4u/shared';
import type { Poller } from '../../core/poller.js';
import type { AuthContext } from '../auth/runtime.js';
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
 * - POST /api/alarms/rules/:id/ack   → acknowledgment (moteur v2 — marqueur,
 *                                      ne coupe PAS les trames)
 * - POST /api/alarms/rules/:id/unack → retrait de l'ack
 * - GET  /api/alarms/targets         → VMs + nœuds (dropdowns du formulaire)
 * - GET/PUT /api/alarms/config       → config Centreon + pollers + mappings
 */

/**
 * Cohérence hystérésis (moteur v2 — GitHub #5) : le seuil de récupération doit
 * être du côté SÛR du seuil de déclenchement, sinon la zone morte s'inverse et
 * la règle flappe (ex. op « > » : récupération < déclenchement). Retourne un
 * message d'erreur, ou null si cohérent.
 */
function recoveryThresholdError(operator: AlarmOperator, threshold: number, recoveryThreshold: number): string | null {
  if (operator === '>' && recoveryThreshold >= threshold) return 'recoveryThreshold doit être < threshold (opérateur « > »)';
  if (operator === '<' && recoveryThreshold <= threshold) return 'recoveryThreshold doit être > threshold (opérateur « < »)';
  return null;
}

/**
 * Cohérence des règles capteurs (GitHub #4) : une métrique capteur exige
 * kind=node + le(s) champ(s) d'identifiant du capteur (device / chip+feature /
 * unit / pool). Retourne la liste des champs manquants (vide = valide).
 */
function sensorTargetErrors(metric: MetricId, target: AlarmTarget): string[] {
  const missing: string[] = [];
  if (!isSensorMetric(metric)) return missing;
  if (target.kind !== 'node') missing.push('target.kind (doit être « node »)');
  if (!target.node) missing.push('target.node');
  for (const f of sensorTargetFields(metric)) {
    if (!target[f as keyof AlarmTarget]) missing.push(`target.${f}`);
  }
  return missing;
}

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
  auth: AuthContext,
  /** Données capteurs (GitHub #4) — cibles des règles capteurs (sélecteurs du formulaire). Optionnel (mocks). */
  sensorData?: () => Promise<SensorAlarmData | null>,
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

  /**
   * Cibles disponibles : VMs (par endpoint) + nœuds + clusters (quorum)
   * + cibles capteurs (GitHub #4 : disques SMART, capteurs, unités systemd,
   * pools ZFS — source InfluxDB raw, cache 60 s ; `null` si indisponible).
   */
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
    let sensors: { smart: SmartDevice[]; sensors: SensorReading[]; units: FailedUnit[]; pools: ZfsStatus[] } | null = null;
    if (sensorData) {
      try {
        const data = await sensorData();
        if (data) sensors = { smart: data.smart, sensors: data.sensors, units: data.units, pools: data.zfsPools };
      } catch {
        sensors = null; // InfluxDB indisponible → le formulaire l'indique
      }
    }
    return { vms, nodes, clusters, mappings: [...mappings.entries()].map(([k, host]) => ({ key: k, host })), sensors };
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
    // Métriques capteurs (GitHub #4) : kind=node + identifiant du capteur requis.
    if (body.metric && body.target) missing.push(...sensorTargetErrors(body.metric, body.target).filter((f) => !missing.includes(f)));
    if (typeof body.threshold !== 'number') missing.push('threshold');
    if (typeof body.confirmSeconds !== 'number' || body.confirmSeconds < 0) missing.push('confirmSeconds');
    if (!body.pollerId) missing.push('pollerId');
    if (!body.centreonHost?.trim()) missing.push('centreonHost');
    if (!body.centreonService?.trim()) missing.push('centreonService');
    // Moteur v2 (GitHub #5) : hystérésis + durée minimale de firing.
    const op = body.operator ?? '>';
    const recThreshold = body.recoveryThreshold ?? null;
    if (recThreshold !== null && (typeof recThreshold !== 'number' || !Number.isFinite(recThreshold))) missing.push('recoveryThreshold');
    else if (recThreshold !== null && recoveryThresholdError(op, body.threshold ?? 0, recThreshold)) missing.push('recoveryThreshold');
    const suppressSeconds = body.suppressSeconds ?? 0;
    if (typeof suppressSeconds !== 'number' || !Number.isFinite(suppressSeconds) || suppressSeconds < 0) missing.push('suppressSeconds');
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
      recoveryThreshold: recThreshold,
      suppressSeconds,
      acknowledgedAt: null,
      acknowledgedBy: null,
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
    const existing = store.ruleById(id);
    if (!existing) return reply.code(404).send({ error: 'rule-not-found' });
    // Cohérence hystérésis sur les valeurs EFFECTIVES (body > règle existante).
    const op = body.operator ?? existing.operator;
    const threshold = body.threshold ?? existing.threshold;
    const rec = body.recoveryThreshold !== undefined ? body.recoveryThreshold : existing.recoveryThreshold;
    if (rec !== null && rec !== undefined && recoveryThresholdError(op, threshold, rec)) {
      return reply.code(400).send({ error: 'invalid', code: 'bad-recovery-threshold', message: recoveryThresholdError(op, threshold, rec) ?? '' });
    }
    if (body.suppressSeconds !== undefined && (typeof body.suppressSeconds !== 'number' || !Number.isFinite(body.suppressSeconds) || body.suppressSeconds < 0)) {
      return reply.code(400).send({ error: 'invalid', code: 'bad-suppress-seconds' });
    }
    // Métriques capteurs (GitHub #4) : cohérence sur les valeurs EFFECTIVES
    // (body > règle existante) — kind=node + identifiant du capteur requis.
    const sensorErrs = sensorTargetErrors(body.metric ?? existing.metric, body.target ?? existing.target);
    if (sensorErrs.length > 0) {
      return reply.code(400).send({ error: 'invalid', code: 'bad-sensor-target', fields: sensorErrs });
    }
    try {
      const rule = store.updateRule(id, body);
      return { rule };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  /**
   * Acknowledgment (moteur v2 — GitHub #5) : l'opérateur « a vu » l'alarme →
   * marqueur persisté (acknowledgedAt/acknowledgedBy), visible dans l'UI.
   * Ne coupe PAS les trames NSCA (Centreon continue de recevoir l'état réel).
   */
  app.post('/api/alarms/rules/:id/ack', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.ruleById(id)) return reply.code(404).send({ error: 'rule-not-found' });
    const userId = req.authUser?.id ?? '';
    const username = auth.store.userById(userId)?.username ?? (userId || 'inconnu');
    const rule = store.updateRule(id, { acknowledgedAt: Date.now(), acknowledgedBy: username });
    return { rule };
  });

  /** Retrait de l'acknowledgment. */
  app.post('/api/alarms/rules/:id/unack', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.ruleById(id)) return reply.code(404).send({ error: 'rule-not-found' });
    const rule = store.updateRule(id, { acknowledgedAt: null, acknowledgedBy: null });
    return { rule };
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
