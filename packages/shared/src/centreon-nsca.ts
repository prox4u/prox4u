// ---------------------------------------------------------------------------
// Centreon NSCA — module d'alarmes & checks passifs (backend centreon-nsca).
//
// Fonctions pures partagées serveur/client :
// - types (règle d'alarme, config Centreon, mapping VM→hôte, pollers) ;
// - machine à états d'évaluation (seuil + fenêtre de confirmation) ;
// - construction de la trame NSCA (échappement `;` et retours à la ligne) ;
// - rendu du plugin_output (template {{vm}} {{metric}} {{value}} {{threshold}}) ;
// - génération du contenu send_nsca.cfg ;
// - séquence de commandes CLAPI de provisioning (documentée + testée).
//
// Conventions imposées : le mot de passe CLAPI / NSCA n'est JAMAIS loggué ;
// les noms d'hôte/service sont échappés avant insertion dans la trame NSCA.
// ---------------------------------------------------------------------------

/** Sévérités d'une règle — mappées vers le return code NSCA. */
export type AlarmSeverity = 'ok' | 'warn' | 'crit' | 'unknown';

export type AlarmOperator = '>' | '<' | '=' | '!=';

/** Cible de la règle : une VM (vmid), un nœud Proxmox, ou le cluster (quorum). */
export type TargetKind = 'vm' | 'node' | 'cluster';

export interface AlarmTarget {
  kind: TargetKind;
  /** id de l'endpoint Proxmox surveillé (= le cluster si kind=cluster). */
  endpointId: string;
  /** vmid si kind=vm. */
  vmid?: number;
  /** nom du nœud si kind=node. */
  node?: string;
  /** nom lisible (VM, nœud ou cluster) — affichage. */
  label: string;
}

/**
 * Métriques surveillables. Source : snapshot poller (VmSummary / NodeHealth /
 * cluster). Les métriques de statut sont numérisées (1 = bon état, 0 = mauvais) :
 * vm_status (running=1), node_online (online=1), ip_reachable (1 IP atteignable),
 * cluster_quorum (quorum ok=1, perdu=0 — cible « cluster »),
 * cluster_qdevice (Qdevice up/absent=1, down=0, unknown=null — cible « cluster »).
 */
export type MetricId =
  | 'cpu_pct'
  | 'ram_pct'
  | 'disk_pct'
  | 'vm_status'
  | 'ip_reachable'
  | 'uptime_sec'
  | 'net_in_bps'
  | 'net_out_bps'
  | 'node_cpu_pct'
  | 'node_ram_pct'
  | 'node_disk_pct'
  | 'node_online'
  | 'cluster_quorum'
  | 'cluster_qdevice';

export const METRIC_IDS: MetricId[] = [
  'cpu_pct',
  'ram_pct',
  'disk_pct',
  'vm_status',
  'ip_reachable',
  'uptime_sec',
  'net_in_bps',
  'net_out_bps',
  'node_cpu_pct',
  'node_ram_pct',
  'node_disk_pct',
  'node_online',
  'cluster_quorum',
  'cluster_qdevice',
];

/** Poller Centreon cible (liste configurable — page de config du module). */
export interface CentreonPoller {
  /** id stable (slug) — identifié dans Centreon. */
  id: string;
  /** nom affiché (Linux, Windows, Infra…). */
  name: string;
  /**
   * IP du poller (daemon NSCA). Si renseignée, les trames des règles de ce
   * poller sont envoyées directement à cette IP ; sinon repli sur le serveur
   * NSCA du central (config.nsca.server).
   */
  ip?: string;
}

/** Configuration NSCA client (serveur central, port, chiffré, mot de passe). */
export interface NscaConfig {
  server: string;
  port: number;
  encrypt: boolean;
  /** mot de passe NSCA — jamais loggué. */
  password: string;
}

export type ProvisionTransport = 'clapi' | 'rest';
export type ClapiMode = 'ssh' | 'local';

/**
 * Configuration du module (page « Centreon (NSCA) » de l'administration).
 * Prox4u n'est PAS sur le central Centreon : le CLAPI est exécuté par SSH
 * (clapiMode=ssh) ; local est conservé pour les déploiements sur le central.
 */
export interface CentreonConfig {
  /** module fonctionnel actif (l'engine évalue + envoie les trames). */
  enabled: boolean;
  transport: ProvisionTransport;
  // --- CLAPI ---
  clapiMode: ClapiMode;
  clapiHost: string;
  clapiUser: string;
  /** mot de passe CLAPI — jamais loggué. */
  clapiPassword: string;
  // --- REST v1 ---
  restUrl: string;
  restUser: string;
  /** token d'API Centreon (Basic) — jamais loggué. */
  restToken: string;
  nsca: NscaConfig;
  /**
   * Heartbeat OK des services (secondes) : pour chaque règle active dans l'état
   * `ok`, une trame OK (code 0) est envoyée toutes les N secondes — le service
   * Centreon reste à l'état OK (et hors `Pending`) même sans alerte, et survit
   * aux restarts de l'engine (services volatiles). `0` = désactivé.
   */
  okHeartbeatSeconds: number;
  /**
   * Check hôte (secondes) : pour chaque hôte Centreon provisionné, une trame
   * `PROCESS_HOST_CHECK_RESULT` est envoyée toutes les N secondes, l'état étant
   * dérivé du target Proxmox (VM running → UP / stopped → DOWN, nœud online →
   * UP / offline → DOWN). `0` = désactivé.
   */
  hostCheckSeconds: number;
}

/** Mapping VM Proxmox → hôte Centreon (auto-suggestion + override manuel). */
export interface VmMapping {
  endpointId: string;
  vmid: number;
  vmName: string;
  /** nom de l'hôte dans Centreon (override manuel). */
  centreonHost: string;
}

export type ProvisionStatus = 'ok' | 'error' | 'pending';

/** État de transmission de la dernière trame envoyée. */
export type NscaSendState = 'ok' | 'error';

/** Règle de surveillance (alarme → check passif NSCA). */
export interface AlarmRule {
  id: string;
  name: string;
  target: AlarmTarget;
  metric: MetricId;
  operator: AlarmOperator;
  threshold: number;
  /** la condition doit persister ce nombre de secondes avant l'alarme. */
  confirmSeconds: number;
  /** sévérité déclenchée (mappée vers return code NSCA 1/2/3). */
  severity: AlarmSeverity;
  /** id du poller Centreon cible (CentreonPoller.id). */
  pollerId: string;
  /** nom de l'hôte dans Centreon. */
  centreonHost: string;
  /** nom du service passif dans Centreon. */
  centreonService: string;
  /** template du plugin_output : {{vm}} {{metric}} {{value}} {{threshold}}. */
  messageTemplate: string;
  active: boolean;
  // --- Moteur v2 (hystérésis / suppression / ack) ---
  /**
   * Seuil de récupération (hystérésis) — null = même seuil que le déclenchement.
   * La règle ne récupère que si la valeur repasse de l'autre côté de CE seuil
   * (ex. op « > » : déclenche >90, récupère ≤80) → zone morte anti-flapping.
   */
  recoveryThreshold: number | null;
  /**
   * Durée minimale de firing en secondes (0 = off) : une fois en alarme, la règle
   * reste en alarme au moins cette durée avant de pouvoir récupérer (anti-boucle).
   */
  suppressSeconds: number;
  /** timestamp (ms) du dernier acknowledgment (null = non ack). */
  acknowledgedAt: number | null;
  /** user ayant acké l'alarme (null = non ack). */
  acknowledgedBy: string | null;
  // --- Statuts (jamais bloquants — robustesse) ---
  provisionStatus: ProvisionStatus;
  provisionMessage: string;
  /** état de la dernière trame NSCA envoyée. */
  lastSendState: NscaSendState | null;
  lastSendMessage: string;
  /** timestamp (ms) de la dernière alarme (transition vers firing). */
  lastAlarmAt: number | null;
  /** timestamp (ms) du dernier heartbeat OK envoyé (null = jamais). */
  lastOkSendAt: number | null;
  /** plugin_output de la dernière trame. */
  lastOutput: string;
  /** état courant de la machine à états (ok = nomimal). */
  currentState: 'ok' | AlarmSeverity;
  createdAt: string;
  updatedAt: string;
}

/** Fichier data/centreon-nsca.json (gitignoré, chmod 600). */
export interface CentreonNscaFile {
  version: 1;
  config: CentreonConfig;
  pollers: CentreonPoller[];
  mappings: VmMapping[];
  rules: AlarmRule[];
}

export interface AlarmStats {
  activeRules: number;
  inactiveRules: number;
  alarms24h: number;
  provisionOk: number;
  provisionError: number;
  provisionPending: number;
}

// ---------------------------------------------------------------------------
// Return codes NSCA
// ---------------------------------------------------------------------------

export const NSCA_OK = 0;
export const NSCA_WARNING = 1;
export const NSCA_CRITICAL = 2;
export const NSCA_UNKNOWN = 3;

/** Mappage sévérité → return code NSCA. */
export function nscaReturnCode(severity: AlarmSeverity): number {
  switch (severity) {
    case 'ok':
      return NSCA_OK;
    case 'warn':
      return NSCA_WARNING;
    case 'crit':
      return NSCA_CRITICAL;
    case 'unknown':
      return NSCA_UNKNOWN;
  }
}

// ---------------------------------------------------------------------------
// Échappement trame NSCA
// ---------------------------------------------------------------------------

/**
 * Échappe un champ de trame NSCA : les `;` et retours à la ligne cassent la
 * trame (séparateur Centreon / fin de ligne) → ils deviennent `\;` et `\n`
 * (séquence littérale). Tabulations → espace.
 */
export function escapeNscaField(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\t/g, ' ').replace(/;/g, '\\;').replace(/\r?\n/g, '\\n');
}

/**
 * Construit la trame NSCA : `<host>\t<service>\t<code>\t<output>\n`.
 * Le nom d'hôte et le service sont échappés (injection `;` impossible).
 */
export function buildNscaFrame(host: string, service: string, code: number, output: string): string {
  return `${escapeNscaField(host)}\t${escapeNscaField(service)}\t${code}\t${escapeNscaField(output)}\n`;
}

/**
 * Construit la trame NSCA de CHECK HÔTE : `<host>\t<code>\t<output>\n` — 3 champs,
 * SANS le service (format documenté de send_nsca/nsca-ng : « host check results
 * are expected in the same format, just without the service description »). Le
 * daemon en génère un `PROCESS_HOST_CHECK_RESULT`. Le nom d'hôte et l'output
 * sont échappés (injection `;` impossible).
 */
export function buildNscaHostFrame(host: string, code: number, output: string): string {
  return `${escapeNscaField(host)}\t${code}\t${escapeNscaField(output)}\n`;
}

/**
 * Quoting d'un argument shell (guillemets simples) : TOUT est littéral, seul le
 * guillemet simple est échappé (`'` → `'\''`). Utilisé pour passer host/service/
 * poller/utilisateur aux commandes CLAPI exécutées par un shell : aucun
 * métacaractère shell (`"` `` ` `` `$` `|` `&` …) n'est interprété, même si le
 * nom provient d'une règle d'alarme saisie par un utilisateur.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Rendu du plugin_output
// ---------------------------------------------------------------------------

/**
 * Rend le template de message : remplace `{{clé}}` par la valeur.
 * Variables : {{vm}}, {{metric}}, {{value}}, {{threshold}} (+ toute autre
 * clé passée). Les variables absentes restent telles quelles (débogage).
 */
export function renderOutput(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? whole : String(v);
  });
}

// ---------------------------------------------------------------------------
// Nommage par défaut
// ---------------------------------------------------------------------------

/** Raccourci lisible d'une métrique pour le nom de service Centreon. */
const METRIC_SHORT: Record<MetricId, string> = {
  cpu_pct: 'CPU',
  ram_pct: 'RAM',
  disk_pct: 'DISK',
  vm_status: 'VM-STATUS',
  ip_reachable: 'IP-REACHABLE',
  uptime_sec: 'UPTIME',
  net_in_bps: 'NET-IN',
  net_out_bps: 'NET-OUT',
  node_cpu_pct: 'NODE-CPU',
  node_ram_pct: 'NODE-RAM',
  node_disk_pct: 'NODE-DISK',
  node_online: 'NODE-ONLINE',
  cluster_quorum: 'CLUSTER-QUORUM',
  cluster_qdevice: 'CLUSTER-QDEVICE',
};

/**
 * Nom de service Centreon auto-généré : `Prox4u-Alarm-<METRIQUE>`.
 * Ex. `Prox4u-Alarm-CPU`, `Prox4u-Alarm-DISK`. Si un nom de règle est fourni,
 * il est ajouté en suffixe (sanitisé) pour distinguer plusieurs règles sur la
 * même métrique : `Prox4u-Alarm-CPU-CPU_prod`.
 */
export function defaultServiceName(metric: MetricId, ruleName = ''): string {
  const metricPart = METRIC_SHORT[metric] ?? metric.toUpperCase();
  const suffix = ruleName.trim() ? `-${ruleName.replace(/\s+/g, '_').slice(0, 24)}` : '';
  return `Prox4u-Alarm-${metricPart}${suffix}`;
}

/**
 * Auto-suggestion du nom d'hôte Centreon depuis une VM Proxmox :
 * hostname (config) si présent, sinon nom de la VM — minuscules, sans espaces.
 */
export function suggestCenteronHost(vmName: string, hostname?: string | null): string {
  const base = (hostname && hostname.trim()) || vmName.trim() || 'vm';
  return base.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'vm';
}

// ---------------------------------------------------------------------------
// Évaluation (machine à états)
// ---------------------------------------------------------------------------

/** Échantillon de métrique (timestamp ms + valeur numérique). */
export interface MetricSample {
  t: number;
  value: number;
}

/** Le test seuil est-il vérifié pour une valeur donnée ? */
export function conditionMet(operator: AlarmOperator, threshold: number, value: number): boolean {
  switch (operator) {
    case '>':
      return value > threshold;
    case '<':
      return value < threshold;
    case '=':
      return value === threshold;
    case '!=':
      return value !== threshold;
  }
}

export interface AlarmEvalResult {
  /** true si la condition tient sur TOUTE la fenêtre de confirmation. */
  firing: boolean;
  /** valeur la plus récente (affichage), null si aucun échantillon. */
  value: number | null;
}

/**
 * Évaluation d'une règle sur son historique d'échantillons.
 * `firing` = tous les échantillons de la fenêtre [now - confirmSeconds, now]
 * vérifient le test seuil (et au moins un échantillon existe dans la fenêtre).
 * Une fenêtre vide (pas d'échantillons récents) ne déclenche PAS — la règle
 * passe en UNKNOWN (value null) côté moteur.
 */
export function evaluateAlarm(
  operator: AlarmOperator,
  threshold: number,
  confirmSeconds: number,
  samples: MetricSample[],
  now: number,
): AlarmEvalResult {
  if (samples.length === 0) return { firing: false, value: null };
  const windowStart = now - confirmSeconds * 1000;
  const recent = samples.filter((s) => s.t >= windowStart);
  if (recent.length === 0) return { firing: false, value: samples[samples.length - 1].value };
  const firing = recent.every((s) => conditionMet(operator, threshold, s.value));
  return { firing, value: recent[recent.length - 1].value };
}

export interface AlarmHysteresisResult {
  /** true si la condition de DÉCLENCHEMENT tient sur toute la fenêtre (ok → firing). */
  trigger: boolean;
  /** true si la condition de RÉCUPÉRATION tient sur toute la fenêtre (firing → ok). */
  recover: boolean;
  /** valeur la plus récente (affichage), null si aucun échantillon. */
  value: number | null;
}

/**
 * Évaluation avec HYSTÉRÉSIS (moteur v2, GitHub #5) : le seuil de récupération
 * est distinct (et plus sûr) du seuil de déclenchement → zone morte anti-flapping.
 *
 * - `trigger` : tous les échantillons de la fenêtre [now - confirmSeconds, now]
 *   vérifient `conditionMet(operator, threshold, v)` (comme `evaluateAlarm`).
 * - `recover` : tous les échantillons vérifient `!conditionMet(operator,
 *   recoveryThreshold ?? threshold, v)` — la valeur est repassée du côté SÛR du
 *   seuil de récupération. Ex. op « > » seuil 90 / récupération 80 : déclenche
 *   à >90 soutenu, récupère à ≤80 soutenu ; entre 80 et 90 = zone morte (aucun
 *   basculement). `recoveryThreshold = null` → comportement d'origine (récupère
 *   dès que la valeur ne dépasse plus le seuil de déclenchement).
 *
 * Une fenêtre vide (pas d'échantillons récents) ne déclenche NI ne récupère.
 */
export function evaluateAlarmHysteresis(
  operator: AlarmOperator,
  threshold: number,
  recoveryThreshold: number | null,
  confirmSeconds: number,
  samples: MetricSample[],
  now: number,
): AlarmHysteresisResult {
  if (samples.length === 0) return { trigger: false, recover: false, value: null };
  const windowStart = now - confirmSeconds * 1000;
  const recent = samples.filter((s) => s.t >= windowStart);
  const value = recent.length > 0 ? recent[recent.length - 1].value : samples[samples.length - 1].value;
  if (recent.length === 0) return { trigger: false, recover: false, value };
  const recThreshold = recoveryThreshold ?? threshold;
  const trigger = recent.every((s) => conditionMet(operator, threshold, s.value));
  const recover = recent.every((s) => !conditionMet(operator, recThreshold, s.value));
  return { trigger, recover, value };
}

// ---------------------------------------------------------------------------
// Configuration NSCA (fichier send_nsca.cfg généré par l'app)
// ---------------------------------------------------------------------------

export interface NscaCfgOptions {
  /**
   * true si le binaire send_nsca installé supporte la variable `encrypt` dans
   * le cfg. À auto-détecter (certains builds, ex. le fork Debian, ne la
   * connaissent pas et rejettent le fichier). Défaut true.
   */
  encryptSupported?: boolean;
}

/**
 * Génère le contenu du fichier `send_nsca.cfg`. Le format NSCA impose le
 * séparateur ` = ` (pas un espace simple) : `server = hôte`, `port = 5668`…
 * La variable `encrypt` n'est émise que si le build la supporte (sinon le
 * binaire rejette tout le fichier). Le mot de passe y figure — le fichier est
 * chmod 600 et jamais loggué.
 */
export function nscaCfgContent(cfg: NscaConfig, opts: NscaCfgOptions = {}): string {
  const encryptSupported = opts.encryptSupported ?? true;
  const lines = [
    `server = ${cfg.server}`,
    `port = ${cfg.port}`,
    ...(encryptSupported ? [`encrypt = ${cfg.encrypt ? 1 : 0}`] : []),
    `password = ${cfg.password}`,
    'timeout = 15',
    '',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Provisioning CLAPI — séquence de commandes (testée + documentée)
// ---------------------------------------------------------------------------

/**
 * Séquence CLAPI de création d'un service passif + déploiement.
 * Chaque ligne est l'argument `-v` d'un appel `centreon -u <u> -p <p>` :
 *   centreon -o SERVICE -a add -v "<host>;<service>"
 *   centreon -o SERVICE -a setparam -v "<host>;<service>;passive_checks_enabled;1"
 *   …
 *   centreon -o POLLERGENERATE -v "<poller>"
 *   centreon -o CFGMOVE -v "<poller>"
 * Les noms host/service sont échappés (pas de `;` ni retour à la ligne).
 */
export function clapiProvisionCommands(host: string, service: string, poller: string): string[] {
  const h = escapeNscaField(host);
  const s = escapeNscaField(service);
  const target = `${h};${s}`;
  return [
    `SERVICE -a add -v ${shellQuote(target)}`,
    `SERVICE -a setparam -v ${shellQuote(`${target};passive_checks_enabled;1`)}`,
    `SERVICE -a setparam -v ${shellQuote(`${target};active_checks_enabled;0`)}`,
    `SERVICE -a setparam -v ${shellQuote(`${target};is_volatile;1`)}`,
    `SERVICE -a setparam -v ${shellQuote(`${target};max_check_attempts;1`)}`,
    `SERVICE -a setparam -v ${shellQuote(`${target};check_command;check_dummy!0`)}`,
    `POLLERGENERATE -v ${shellQuote(poller)}`,
    `CFGMOVE -v ${shellQuote(poller)}`,
  ];
}

/**
 * Commande CLAPI de SUPPRESSION d'un service (nettoyage), si utilisée.
 */
export function clapiDeleteCommand(host: string, service: string): string {
  return `SERVICE -a del -v ${shellQuote(`${escapeNscaField(host)};${escapeNscaField(service)}`)}`;
}

// ---------------------------------------------------------------------------
// Configuration par défaut (seed du 1er démarrage)
// ---------------------------------------------------------------------------

/** Pollers par défaut (modifiables depuis la page de config). */
export const DEFAULT_POLLERS: CentreonPoller[] = [
  { id: 'linux', name: 'Linux' },
  { id: 'windows', name: 'Windows' },
  { id: 'infra', name: 'Infra' },
];

/** Config initiale : module désactivé, transport CLAPI en SSH. */
export function defaultCenteronConfig(): CentreonConfig {
  return {
    enabled: false,
    transport: 'clapi',
    clapiMode: 'ssh',
    clapiHost: '',
    clapiUser: '',
    clapiPassword: '',
    restUrl: '',
    restUser: '',
    restToken: '',
    nsca: { server: '', port: 5668, encrypt: true, password: '' },
    okHeartbeatSeconds: 300,
    hostCheckSeconds: 60,
  };
}
