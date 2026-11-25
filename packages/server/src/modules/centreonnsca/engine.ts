import path from 'node:path';
import {
  buildNscaFrame,
  buildNscaHostFrame,
  evaluateAlarm,
  nscaReturnCode,
  renderOutput,
  type AlarmRule,
  type AlarmTarget,
  type CentreonConfig,
  type MetricSample,
  type MultiDashboardSnapshot,
} from '@prox4u/shared';
import type { Poller } from '../../core/poller.js';
import { clusterMetricValue, nodeMetricValue, vmMetricValue } from './metrics.js';
import { sendNsca, type NscaSendResult } from './nsca.js';
import type { NscaStore } from './store.js';

/**
 * Engine d'alarmes — tick 15 s. Pour chaque règle active (module actif) :
 *  1. échantillonne la métrique depuis le snapshot poller (VmSummary/NodeHealth/
 *     cluster) → ring-buffer en mémoire (pas de dépendance InfluxDB) ;
 *  2. évalue la fenêtre de confirmation (evaluateAlarm) ;
 *  3. machine à états ok ⇄ firing : envoie une trame NSCA À CHAQUE transition
 *     (alarme = code sévérité, récupération = code 0) ;
 *  4. HEARTBEAT OK : règle saine (état ok) → trame OK périodique
 *     (config.okHeartbeatSeconds, 0 = off) — le service Centreon reste OK /
 *     hors `Pending` même sans alerte, et survit aux restarts (services volatiles) ;
 *  5. CHECK HÔTE : pour chaque hôte Centreon provisionné, trame
 *     PROCESS_HOST_CHECK_RESULT périodique (config.hostCheckSeconds, 0 = off),
 *     état dérivé du target Proxmox (VM running → UP / stopped → DOWN, nœud
 *     online → UP / offline → DOWN) — l'hôte Centreon sort de `Pending` sans
 *     commande de check active ;
 *  6. robuste : valeur null (pas de données) → pas de transition ; échec
 *     send_nsca → la règle reste, lastSendState=error + message, aucun crash.
 *
 * Le return code de la trame alarme est celui de la sévérité de la règle
 * (warn=1, crit=2, unknown=3) ; la récupération et le heartbeat sont 0 (OK).
 */

const SAMPLE_HORIZON_MS = 4 * 3_600_000; // garde 4 h d'échantillons max

export class AlarmEngine {
  private buffers = new Map<string, MetricSample[]>();
  /** timestamp (ms) du dernier check hôte envoyé par hôte Centreon (mémoire). */
  private hostLastSend = new Map<string, number>();
  /** dernier code envoyé par hôte (log uniquement au changement d'état). */
  private hostLastCode = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private store: NscaStore,
    private poller: Poller,
    private dataDir: string,
    private logger: Pick<Console, 'info' | 'warn' | 'error'>,
    private intervalMs = 15_000,
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.logger.info(`alarm-engine : démarré (tick ${this.intervalMs / 1000} s, ${this.store.listRules().length} règle(s))`);
    const cfg = this.store.getConfig();
    if (cfg.enabled && !cfg.nsca.encrypt && cfg.nsca.password) {
      this.logger.warn('alarm-engine : NSCA encrypt=0 avec mot de passe configuré — le mot de passe NSCA est envoyé EN CLAIR vers le daemon (encrypt=1 recommandé)');
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const cfg = this.store.getConfig();
      if (!cfg.enabled) return; // module désactivé → aucun envoi
      const multi = this.poller.getMulti();
      if (!multi) return; // pas encore de snapshot
      const now = Date.now();
      for (const rule of this.store.listRules()) {
        if (!rule.active) continue;
        await this.processRule(rule, cfg, multi, now);
      }
      // Check hôte (PROCESS_HOST_CHECK_RESULT) — indépendant des règles.
      await this.sendHostChecks(cfg, multi, now);
    } catch (err) {
      this.logger.error(`alarm-engine : tick en échec : ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Évalue UNE règle et envoie la trame de transition si nécessaire. */
  private async processRule(rule: AlarmRule, cfg: CentreonConfig, multi: MultiDashboardSnapshot, now: number): Promise<void> {
    const ep = multi.endpoints.find((e) => e.id === rule.target.endpointId);
    const snap = ep?.snapshot;
    if (!snap) return; // endpoint indisponible → pas d'échantillon

    let value: number | null = null;
    if (rule.target.kind === 'vm') {
      const vm = snap.vms.find((v) => v.vmid === rule.target.vmid);
      if (vm) value = vmMetricValue(rule.metric, vm);
    } else if (rule.target.kind === 'node') {
      const node = snap.nodes.find((n) => n.node === rule.target.node);
      if (node) value = nodeMetricValue(rule.metric, node);
    } else {
      // cluster (quorum) : échantillon depuis le snapshot cluster de l'endpoint.
      value = clusterMetricValue(rule.metric, snap.cluster);
    }

    const buf = this.buffers.get(rule.id) ?? [];
    if (value !== null) {
      buf.push({ t: now, value });
      const horizon = Math.max(SAMPLE_HORIZON_MS, rule.confirmSeconds * 1000 + 300_000);
      while (buf.length > 0 && buf[0].t < now - horizon) buf.shift();
      this.buffers.set(rule.id, buf);
    }

    const { firing, value: latest } = evaluateAlarm(rule.operator, rule.threshold, rule.confirmSeconds, buf, now);
    if (latest === null) return; // aucune donnée connue → aucune transition

    // Suivi local de l'état : `rule` est une copie (listRules), le store est
    // mis à jour par send* — on suit l'état post-transition pour le heartbeat.
    let state: AlarmRule['currentState'] = rule.currentState;
    let lastOkSendAt = rule.lastOkSendAt ?? 0;

    if (firing && rule.currentState === 'ok') {
      // --- ALARME : ok → firing ---
      const output = renderOutput(rule.messageTemplate, {
        vm: rule.target.label,
        metric: rule.metric,
        value: latest,
        threshold: rule.threshold,
      });
      const frame = buildNscaFrame(rule.centreonHost, rule.centreonService, nscaReturnCode(rule.severity), output);
      const send = await this.sendAndRecord(rule, cfg, frame, output, now);
      state = rule.severity;
      this.logger.info(`alarm : ALARME « ${rule.name} » → ${rule.centreonHost}/${rule.centreonService} (${send.ok ? 'envoyée' : 'ÉCHEC : ' + send.message})`);
    } else if (!firing && rule.currentState !== 'ok') {
      // --- RÉCUPÉRATION : firing → ok (toujours code 0) ---
      const output = `Récupération — ${renderOutput(rule.messageTemplate, {
        vm: rule.target.label,
        metric: rule.metric,
        value: latest,
        threshold: rule.threshold,
      })}`;
      const frame = buildNscaFrame(rule.centreonHost, rule.centreonService, 0, output);
      const send = await this.sendAndRecord(rule, cfg, frame, output, now);
      state = 'ok';
      lastOkSendAt = now; // la trame de récupération EST une trame OK
      this.logger.info(`alarm : RÉCUP « ${rule.name} » → ${rule.centreonHost}/${rule.centreonService} (${send.ok ? 'envoyée' : 'ÉCHEC : ' + send.message})`);
    }

    // --- HEARTBEAT OK : règle saine (état ok) + intervalle écoulé → trame OK
    // périodique. Jamais envoyé si state ≠ 'ok' (ne masque pas une alerte en
    // cours). Sort le service de `Pending` et le garde à jour (services volatiles).
    const hb = cfg.okHeartbeatSeconds;
    if (hb > 0 && state === 'ok' && now - lastOkSendAt >= hb * 1000) {
      const output = `OK — ${rule.name} : ${rule.metric}=${latest} (seuil ${rule.operator}${rule.threshold}) — heartbeat Prox4u`;
      const frame = buildNscaFrame(rule.centreonHost, rule.centreonService, 0, output);
      const send = await this.sendOkHeartbeat(rule, cfg, frame, output, now);
      this.logger.info(`alarm : OK heartbeat « ${rule.name} » → ${rule.centreonHost}/${rule.centreonService} (${send.ok ? 'envoyée' : 'ÉCHEC : ' + send.message})`);
    }
  }

  /**
   * Envoie la trame et met à jour la règle. La transition d'état est consommée
   * même si send_nsca échoue → pas de ré-envoi en boucle ; l'échec est
   * consigné (lastSendState=error + message) sans bloquer l'engine.
   */
  private async sendAndRecord(rule: AlarmRule, cfg: CentreonConfig, frame: string, output: string, now: number): Promise<NscaSendResult> {
    // L'état est basculé AVANT l'envoi : la transition est consommée même si
    // send_nsca échoue (pas de ré-envoi en boucle).
    const nextState: AlarmRule['currentState'] = rule.currentState === 'ok' ? rule.severity : 'ok';
    // Destination NSCA : l'IP du poller cible si renseignée, sinon le serveur
    // NSCA du central (config.nsca.server).
    const poller = this.store.pollerById(rule.pollerId);
    const server = poller?.ip || cfg.nsca.server;
    let send: NscaSendResult;
    try {
      send = await sendNsca({ ...cfg.nsca, server }, frame, path.join(this.dataDir, 'nsca'));
    } catch (err) {
      send = { ok: false, code: null, message: (err as Error).message };
    }
    this.store.updateRule(rule.id, {
      currentState: nextState,
      lastAlarmAt: nextState !== 'ok' ? now : rule.lastAlarmAt,
      // La trame de récupération EST une trame OK → pose le heartbeat.
      lastOkSendAt: nextState === 'ok' ? now : rule.lastOkSendAt,
      lastOutput: output,
      lastSendState: send.ok ? 'ok' : 'error',
      lastSendMessage: send.message,
    });
    return send;
  }

  /**
   * Envoie une trame de HEARTBEAT OK et met à jour la règle SANS changer
   * `currentState` (déjà 'ok'). Pose `lastOkSendAt` + statut d'envoi.
   */
  private async sendOkHeartbeat(rule: AlarmRule, cfg: CentreonConfig, frame: string, output: string, now: number): Promise<NscaSendResult> {
    const poller = this.store.pollerById(rule.pollerId);
    const server = poller?.ip || cfg.nsca.server;
    let send: NscaSendResult;
    try {
      send = await sendNsca({ ...cfg.nsca, server }, frame, path.join(this.dataDir, 'nsca'));
    } catch (err) {
      send = { ok: false, code: null, message: (err as Error).message };
    }
    this.store.updateRule(rule.id, {
      lastOkSendAt: now,
      lastOutput: output,
      lastSendState: send.ok ? 'ok' : 'error',
      lastSendMessage: send.message,
    });
    return send;
  }

  /**
   * CHECK HÔTE : pour chaque hôte Centreon provisionné (règles actives), envoie
   * une trame `PROCESS_HOST_CHECK_RESULT` périodique (config.hostCheckSeconds).
   * L'état est dérivé du target Proxmox (VM running → UP / stopped → DOWN,
   * nœud online → UP / offline → DOWN, quorum ok → UP / perdu → DOWN).
   * Log uniquement au changement d'état ou en échec (pas de spam).
   */
  private async sendHostChecks(cfg: CentreonConfig, multi: MultiDashboardSnapshot, now: number): Promise<void> {
    const interval = cfg.hostCheckSeconds;
    if (interval <= 0) return;
    // Regroupe par hôte Centreon (1ʳᵉ cible + poller — un hôte est provisionné
    // sur un seul poller). Les hôtes sans nom sont ignorés.
    const hosts = new Map<string, { target: AlarmTarget; pollerId: string }>();
    for (const r of this.store.listRules()) {
      if (!r.active || !r.centreonHost) continue;
      if (!hosts.has(r.centreonHost)) hosts.set(r.centreonHost, { target: r.target, pollerId: r.pollerId });
    }
    for (const [host, { target, pollerId }] of hosts) {
      const last = this.hostLastSend.get(host) ?? 0;
      if (now - last < interval * 1000) continue;
      const { code, output } = this.hostCheckState(multi, target);
      if (code === null) continue; // état inconnu → pas de trame (réessai au tick suivant)
      const poller = this.store.pollerById(pollerId);
      const server = poller?.ip || cfg.nsca.server;
      const frame = buildNscaHostFrame(host, code, output);
      let send: NscaSendResult;
      try {
        send = await sendNsca({ ...cfg.nsca, server }, frame, path.join(this.dataDir, 'nsca'));
      } catch (err) {
        send = { ok: false, code: null, message: (err as Error).message };
      }
      if (send.ok) {
        // Réussite : marque l'envoi (l'échec est réessayé au tick suivant).
        this.hostLastSend.set(host, now);
        const prev = this.hostLastCode.get(host);
        if (prev !== code) {
          this.hostLastCode.set(host, code);
          this.logger.info(`alarm : CHECK HÔTE « ${host} » → code ${code} — ${output}`);
        }
      } else {
        this.logger.warn(`alarm : CHECK HÔTE « ${host} » en échec : ${send.message}`);
      }
    }
  }

  /**
   * Dérive l'état hôte du target Proxmox : UP (0) / DOWN (1) / UNKNOWN (3).
   * `code: null` = état inconnu (endpoint indisponible) → pas de trame.
   */
  private hostCheckState(multi: MultiDashboardSnapshot, target: AlarmTarget): { code: number | null; output: string } {
    const ep = multi.endpoints.find((e) => e.id === target.endpointId);
    const snap = ep?.snapshot;
    if (!snap) return { code: null, output: '' };
    if (target.kind === 'vm') {
      const vm = snap.vms.find((v) => v.vmid === target.vmid);
      if (!vm) return { code: 3, output: 'UNKNOWN — VM introuvable dans le snapshot Proxmox' };
      if (vm.status === 'running') return { code: 0, output: 'UP — VM running (Proxmox)' };
      return { code: 1, output: `DOWN — VM ${vm.status} (Proxmox)` };
    }
    if (target.kind === 'node') {
      const node = snap.nodes.find((n) => n.node === target.node);
      if (!node) return { code: 3, output: 'UNKNOWN — nœud introuvable dans le snapshot Proxmox' };
      if (node.online) return { code: 0, output: 'UP — nœud online (Proxmox)' };
      return { code: 1, output: 'DOWN — nœud offline (Proxmox)' };
    }
    // cluster (quorum)
    const quorum = snap.cluster.quorumState;
    if (quorum == null) return { code: 3, output: 'UNKNOWN — quorum inconnu' };
    if (quorum === 'ok') return { code: 0, output: 'UP — quorum ok (Proxmox)' };
    return { code: 1, output: 'DOWN — quorum perdu (Proxmox)' };
  }
}
