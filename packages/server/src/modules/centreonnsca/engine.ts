import path from 'node:path';
import {
  buildNscaFrame,
  evaluateAlarm,
  nscaReturnCode,
  renderOutput,
  type AlarmRule,
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
 *  4. robuste : valeur null (pas de données) → pas de transition ; échec
 *     send_nsca → la règle reste, lastSendState=error + message, aucun crash.
 *
 * Le return code de la trame alarme est celui de la sévérité de la règle
 * (warn=1, crit=2, unknown=3) ; la récupération est toujours 0 (OK).
 */

const SAMPLE_HORIZON_MS = 4 * 3_600_000; // garde 4 h d'échantillons max

export class AlarmEngine {
  private buffers = new Map<string, MetricSample[]>();
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
      this.logger.info(`alarm : RÉCUP « ${rule.name} » → ${rule.centreonHost}/${rule.centreonService} (${send.ok ? 'envoyée' : 'ÉCHEC : ' + send.message})`);
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
      lastOutput: output,
      lastSendState: send.ok ? 'ok' : 'error',
      lastSendMessage: send.message,
    });
    return send;
  }
}
