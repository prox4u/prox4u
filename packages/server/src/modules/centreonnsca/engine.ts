import path from 'node:path';
import {
  buildNscaFrame,
  buildNscaHostFrame,
  evaluateAlarmHysteresis,
  isSensorMetric,
  nscaReturnCode,
  renderOutput,
  resolveSensorThresholds,
  sensorMetricValue,
  type AlarmRule,
  type AlarmTarget,
  type CentreonConfig,
  type MetricSample,
  type MultiDashboardSnapshot,
  type SensorAlarmData,
  type SensorThresholds,
} from '@prox4u/shared';
import type { Poller } from '../../core/poller.js';
import { clusterMetricValue, nodeMetricValue, vmMetricValue } from './metrics.js';
import { sendNsca, type NscaSendResult } from './nsca.js';
import { deleteCenteronService, type DeleteServiceResult } from './provision.js';
import type { NscaStore } from './store.js';

/**
 * Engine d'alarmes — tick 15 s. Pour chaque règle active (module actif) :
 *  1. échantillonne la métrique depuis le snapshot poller (VmSummary/NodeHealth/
 *     cluster) → ring-buffer en mémoire (pas de dépendance InfluxDB) ;
 *  2. évalue la fenêtre de confirmation AVEC HYSTÉRÉSIS (evaluateAlarmHysteresis,
 *     moteur v2 — GitHub #5) : `trigger` (seuil de déclenchement) et `recover`
 *     (seuil de récupération distinct, plus sûr) → zone morte anti-flapping ;
 *  3. machine à états ok ⇄ firing : envoie une trame NSCA À CHAQUE transition
 *     (alarme = code sévérité, récupération = code 0) ;
 *     - DURÉE MINIMALE DE FIRING (rule.suppressSeconds, 0 = off) : une fois en
 *       alarme, la règle ne peut récupérer qu'après cette durée (anti-boucle
 *       alarme→récup→alarme) ;
 *     - AUTO-RÉSOLUTION : la récupération (firing→ok) réinitialise l'ack
 *       (acknowledgedAt/acknowledgedBy) ;
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
 * MÉTRIQUES CAPTEURS (GitHub #4) : smart_temp_c / smart_health /
 * sensor_temp_c / systemd_unit_failed / zfs_pool_state — source InfluxDB raw
 * (module node-sensors, `sensorData` injecté), PAS le snapshot poller. Une
 * seule lecture par tick (cache 60 s, partagée entre toutes les règles
 * capteurs). Le seuil de `sensor_temp_c` est le seuil EFFECTIF (perso ≤
 * firmware, `sensorThresholds` injecté) — la règle suit l'onglet admin « Seuils
 * capteurs » (repli : seuil de la règle si aucun seuil défini).
 *
 * Les trames coulent TOUJOURS aux transitions réelles + heartbeat : Centreon
 * reflète l'état réel (OK ou critique). L'anti-flapping se fait au niveau de la
 * machine à états (hystérésis + durée minimale), pas en coupant les trames.
 * L'ack (acknowledgedAt/acknowledgedBy) est un MARQUEUR (UI) — il ne coupe pas
 * les trames ; il est posé/retiré par les routes /ack et /unack.
 *
 * Le return code de la trame alarme est celui de la sévérité de la règle
 * (warn=1, crit=2, unknown=3) ; la récupération et le heartbeat sont 0 (OK).
 */

const SAMPLE_HORIZON_MS = 4 * 3_600_000; // garde 4 h d'échantillons max

/**
 * Throttle du réessai des suppressions en attente (GitHub #20) : on ne retente
 * la suppression d'un service Centreon qu'une fois par minute par règle (le
 * tick fait 15 s — sans throttle, un central down serait interrogé 4×/min).
 */
const PENDING_RETRY_MS = 60_000;

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
    /** Données capteurs (GitHub #4) — null si InfluxDB indisponible. Optionnel (mocks). */
    private sensorData?: () => Promise<SensorAlarmData | null>,
    /** Seuils capteurs personnalisés (perso ≤ firmware). Optionnel (mocks). */
    private sensorThresholds?: () => SensorThresholds,
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

  /** Un tick complet (public pour les tests — le timer interne l'appelle aussi). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const cfg = this.store.getConfig();
      // Suppressions en attente (GitHub #20) — réessayées même module
      // désactivé (c'est du nettoyage, pas de l'envoi de trames).
      await this.retryPendingDeletions(cfg);
      if (!cfg.enabled) return; // module désactivé → aucun envoi
      const multi = this.poller.getMulti();
      const now = Date.now();
      const rules = this.store.listRules();
      // Métriques capteurs (GitHub #4) : si au moins une règle capteur active,
      // UNE lecture InfluxDB par tick (cache 60 s, partagée entre toutes les
      // règles capteurs). Indépendante du snapshot poller (endpoint PVE peut
      // être down — l'agent Telegraf continue de reporter).
      let sensorData: SensorAlarmData | null = null;
      if (rules.some((r) => r.active && isSensorMetric(r.metric)) && this.sensorData) {
        try {
          sensorData = await this.sensorData();
        } catch (err) {
          this.logger.warn(`alarm-engine : données capteurs indisponibles (${(err as Error).message})`);
        }
      }
      for (const rule of rules) {
        if (!rule.active) continue;
        await this.processRule(rule, cfg, multi, now, sensorData);
      }
      // Check hôte (PROCESS_HOST_CHECK_RESULT) — indépendant des règles.
      if (multi) await this.sendHostChecks(cfg, multi, now);
    } catch (err) {
      this.logger.error(`alarm-engine : tick en échec : ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * RÉESSAI DES SUPPRESSIONS EN ATTENTE (GitHub #20 — cohérence Prox4u ↔
   * Centreon) : pour chaque règle marquée `pendingDeletion` (suppression du
   * service Centreon échouée, central injoignable), on retente la suppression
   * (throttle 60 s/règle). Succès (`deleted`/`not-found`) → la règle est
   * retirée de Prox4u ; échec → l'erreur + le timestamp sont mis à jour
   * (réessai au tick suivant, après le throttle).
   */
  private async retryPendingDeletions(cfg: CentreonConfig): Promise<void> {
    const pending = this.store.listPendingDeletions();
    if (pending.length === 0) return;
    const now = Date.now();
    for (const rule of pending) {
      if (now - (rule.pendingDeletionAt ?? 0) < PENDING_RETRY_MS) continue; // throttle
      const poller = this.store.pollerById(rule.pollerId);
      if (!poller) continue; // poller supprimé entre-temps → la règle reste (visible en UI)
      let del: DeleteServiceResult;
      try {
        del = await deleteCenteronService(cfg, rule.centreonHost, rule.centreonService, poller);
      } catch (err) {
        del = { status: 'error' as const, message: (err as Error).message };
      }
      if (del.status === 'deleted' || del.status === 'not-found') {
        this.store.deleteRule(rule.id);
        this.logger.info(`alarm : SUPPRESSION FINALISÉE « ${rule.name} » — ${rule.centreonHost}/${rule.centreonService} (${del.status})`);
      } else {
        this.store.updateRule(rule.id, { pendingDeletionError: del.message, pendingDeletionAt: now });
        this.logger.warn(`alarm : suppression en attente « ${rule.name} » — réessai en échec : ${del.message}`);
      }
    }
  }

  /** Évalue UNE règle et envoie la trame de transition si nécessaire. */
  private async processRule(rule: AlarmRule, cfg: CentreonConfig, multi: MultiDashboardSnapshot | null, now: number, sensorData: SensorAlarmData | null): Promise<void> {
    const ep = multi?.endpoints.find((e) => e.id === rule.target.endpointId);
    const snap = ep?.snapshot;

    let value: number | null = null;
    // Seuils EFFECTIFS (GitHub #4) : pour sensor_temp_c, le seuil perso ≤
    // firmware prime sur le seuil de la règle (repli si aucun seuil défini).
    let threshold = rule.threshold;
    let recoveryThreshold = rule.recoveryThreshold ?? null;
    if (isSensorMetric(rule.metric)) {
      // Métrique capteur : source InfluxDB raw (node-sensors), PAS le snapshot
      // poller — la règle fonctionne même si l'endpoint PVE est down.
      if (sensorData) value = sensorMetricValue(rule.metric, rule.target, sensorData);
      const t = resolveSensorThresholds(rule.metric, rule.target, sensorData, this.sensorThresholds?.() ?? {}, rule);
      threshold = t.threshold;
      recoveryThreshold = t.recoveryThreshold;
    } else if (!snap) {
      return; // endpoint indisponible → pas d'échantillon
    } else if (rule.target.kind === 'vm') {
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

    const { trigger, recover, value: latest } = evaluateAlarmHysteresis(
      rule.operator,
      threshold,
      recoveryThreshold,
      rule.confirmSeconds,
      buf,
      now,
    );
    if (latest === null) return; // aucune donnée connue → aucune transition

    // Suivi local de l'état : `rule` est une copie (listRules), le store est
    // mis à jour par send* — on suit l'état post-transition pour le heartbeat.
    let state: AlarmRule['currentState'] = rule.currentState;
    let lastOkSendAt = rule.lastOkSendAt ?? 0;

    if (trigger && rule.currentState === 'ok') {
      // --- ALARME : ok → firing ---
      const output = renderOutput(rule.messageTemplate, {
        vm: rule.target.label,
        metric: rule.metric,
        value: latest,
        threshold,
      });
      const frame = buildNscaFrame(rule.centreonHost, rule.centreonService, nscaReturnCode(rule.severity), output);
      const send = await this.sendAndRecord(rule, cfg, frame, output, now);
      state = rule.severity;
      this.logger.info(`alarm : ALARME « ${rule.name} » → ${rule.centreonHost}/${rule.centreonService} (${send.ok ? 'envoyée' : 'ÉCHEC : ' + send.message})`);
    } else if (recover && rule.currentState !== 'ok' && this.minFiringElapsed(rule, now)) {
      // --- RÉCUPÉRATION : firing → ok (toujours code 0) + AUTO-RÉSOLUTION
      // (l'alarme se ferme → l'ack est réinitialisé). La durée minimale de
      // firing (suppressSeconds) casse la boucle alarme→récup→alarme.
      const output = `Récupération — ${renderOutput(rule.messageTemplate, {
        vm: rule.target.label,
        metric: rule.metric,
        value: latest,
        threshold,
      })}`;
      const frame = buildNscaFrame(rule.centreonHost, rule.centreonService, 0, output);
      const send = await this.sendAndRecord(rule, cfg, frame, output, now, {
        acknowledgedAt: null,
        acknowledgedBy: null,
      });
      state = 'ok';
      lastOkSendAt = now; // la trame de récupération EST une trame OK
      this.logger.info(`alarm : RÉCUP « ${rule.name} » → ${rule.centreonHost}/${rule.centreonService} (${send.ok ? 'envoyée' : 'ÉCHEC : ' + send.message})`);
    }

    // --- HEARTBEAT OK : règle saine (état ok) + intervalle écoulé → trame OK
    // périodique. Jamais envoyé si state ≠ 'ok' (ne masque pas une alerte en
    // cours). Sort le service de `Pending` et le garde à jour (services volatiles).
    const hb = cfg.okHeartbeatSeconds;
    if (hb > 0 && state === 'ok' && now - lastOkSendAt >= hb * 1000) {
      const output = `OK — ${rule.name} : ${rule.metric}=${latest} (seuil ${rule.operator}${threshold}) — heartbeat Prox4u`;
      const frame = buildNscaFrame(rule.centreonHost, rule.centreonService, 0, output);
      const send = await this.sendOkHeartbeat(rule, cfg, frame, output, now);
      this.logger.info(`alarm : OK heartbeat « ${rule.name} » → ${rule.centreonHost}/${rule.centreonService} (${send.ok ? 'envoyée' : 'ÉCHEC : ' + send.message})`);
    }
  }

  /**
   * DURÉE MINIMALE DE FIRING (moteur v2 — GitHub #5) : la règle peut-elle
   * récupérer maintenant ? `suppressSeconds = 0` (défaut) → oui. Sinon, il
   * faut que `now - lastAlarmAt ≥ suppressSeconds` (le timer part de la
   * dernière alarme). `lastAlarmAt` null (défensif) → oui.
   */
  private minFiringElapsed(rule: AlarmRule, now: number): boolean {
    const suppressMs = (rule.suppressSeconds ?? 0) * 1000;
    if (suppressMs <= 0) return true;
    if (rule.lastAlarmAt == null) return true;
    return now - rule.lastAlarmAt >= suppressMs;
  }

  /**
   * Envoie la trame et met à jour la règle. La transition d'état est consommée
   * même si send_nsca échoue → pas de ré-envoi en boucle ; l'échec est
   * consigné (lastSendState=error + message) sans bloquer l'engine.
   * `extra` : patch supplémentaire (ex. auto-résolution : clear de l'ack).
   */
  private async sendAndRecord(rule: AlarmRule, cfg: CentreonConfig, frame: string, output: string, now: number, extra?: Partial<AlarmRule>): Promise<NscaSendResult> {
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
      ...extra,
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
