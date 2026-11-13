/**
 * Types partagés — module node-sensors (métriques locales Telegraf).
 * Données issues de l'agent Telegraf bare-metal sur chaque nœud Proxmox.
 */

/** État SMART d'un disque (dernier point de la table smart_device). */
export interface SmartDevice {
  node: string;
  device: string;
  model: string | null;
  serialNo: string | null;
  /**
   * Santé SMART — tri-state. `true` = PASSED, `false` = FAILED, `null` = INCONNUE :
   * le disque n'expose pas SMART (disque virtuel QEMU, volume logique RAID, état
   * illisible). NULL n'est PAS un échec — afficher « CRITIQUE » pour une santé
   * inconnue serait un faux positif sur du vrai matériel.
   */
  healthOk: boolean | null;
  tempC: number | null;
  powerOnHours: number | null;
  powerCycleCount: number | null;
  reallocatedSectors: number | null;
  pendingSectors: number | null;
  uncorrectableSectors: number | null;
  udmaCrcErrors: number | null;
  /** NVMe : pourcentage de vie utilisée (0 = neuf, 100 = fin de vie). */
  percentageUsed: number | null;
  /** NVMe : espace de secours restant (%). */
  availableSpare: number | null;
  /** NVMe : avertissement critique (0 = OK). */
  criticalWarning: number | null;
  lastSeen: number; // unix seconds
}

/** Lecture capteur (table sensors) — température / ventilateur / tension. */
export interface SensorReading {
  node: string;
  chip: string;
  feature: string;
  tempInput: number | null;
  tempCrit: number | null;
  fanInput: number | null;
  inInput: number | null;
  lastSeen: number;
}

/** État ZFS (table zfs) — ARC + pools. */
export interface ZfsStatus {
  node: string;
  arcHits: number | null;
  arcMisses: number | null;
  arcSize: number | null;
  arcCacheSize: number | null;
  poolName: string | null;
  poolState: string | null; // ONLINE / DEGRADED / OFFLINE
  poolSize: number | null;
  poolAllocated: number | null;
  poolFree: number | null;
  lastSeen: number;
}

/** Unité systemd en état non-normal (table systemd_units, active != 'active' ou load != 'loaded'). */
export interface FailedUnit {
  node: string;
  name: string;
  active: string; // activating / active / deactivating / inactive / failed
  sub: string; // running / exited / dead / auto-restart
  load: string; // loaded / not-found / error
  lastSeen: number;
}

/** Réponse GET /api/node-sensors?timeframe=1h. */
export interface NodeSensorsResponse {
  timeframe: string;
  nodes: string[];
  smart: SmartDevice[];
  sensors: SensorReading[];
  zfs: ZfsStatus[];
  failedUnits: FailedUnit[];
  /** 'influx' si les données viennent d'InfluxDB, 'empty' si aucun nœud Telegraf. */
  source: 'influx' | 'empty';
  /**
   * Seuils capteurs personnalisés (perso ≤ firmware), clé = `node/chip/feature`.
   * Merge serveur dans la réponse : le tableau « Capteurs » suit le seuil
   * EFFECTIF (perso si défini, sinon firmware `tempCrit`). Vide = firmware partout.
   */
  sensorThresholds: SensorThresholds;
}

/** Seuil personnalisé d'un capteur en °C, clé = `node/chip/feature`. */
export type SensorThresholds = Record<string, number>;

/** Vue d'un capteur pour la page admin (onglet « Seuils capteurs »). */
export interface SensorThresholdEntry {
  node: string;
  chip: string;
  feature: string;
  /** Température courante (lecture seule — contexte, pas un seuil). */
  temp: number | null;
  /** Seuil critique firmware (lecture seule — valeur matériel, jamais dépassée). */
  firmware: number | null;
  /** Seuil personnalisé (perso ≤ firmware). `null` si non défini (fallback firmware). */
  custom: number | null;
}

/** Réponse GET /api/admin/sensor-thresholds. */
export interface SensorThresholdsResponse {
  /** Seuils personnalisés courants (clé = `node/chip/feature`). */
  thresholds: SensorThresholds;
  /** Liste des capteurs connus (avec leur seuil firmware + perso éventuel). */
  sensors: SensorThresholdEntry[];
}

/** Point d'historique d'un capteur — température (°C) à un instant donné. */
export interface SensorHistoryPoint {
  time: number; // unix seconds
  temp: number;
}

/** Réponse GET /api/node-sensors-history — historique des valeurs d'un capteur. */
export interface SensorHistoryResponse {
  node: string;
  chip: string;
  feature: string;
  range: 'month' | 'year';
  /**
   * Série de températures, triée par temps croissant. Les **trous** (pas de point
   * sur une période) sont réels : le nœud était éteint / sans mesure — ils ne
   * sont pas comblés (le front les affiche tels quels, `connectNulls: false`).
   */
  points: SensorHistoryPoint[];
  /** Seuil effectif (perso ≤ firmware) à tracer en ligne de référence — `null` si inconnu. */
  threshold: number | null;
  /** `true` si le seuil effectif est personnalisé (sinon firmware). */
  thresholdCustom: boolean;
  /** Seuil critique firmware (valeur matériel) — pour tracer la 2ᵉ ligne quand un seuil perso existe. */
  thresholdFirmware: number | null;
  source: 'influx' | 'empty';
}

/**
 * Réponse GET /api/smart-device-history — historique de température d'un DISQUE
 * (table `smart_device`, colonne `temp_c`). Pas de seuil firmware : les disques
 * n'exposent pas de `temp_crit` — le front trace la référence fixe 80 °C (convention
 * de la table SMART). Les points à 0 °C (pas de capteur) sont exclus.
 */
export interface SmartHistoryResponse {
  node: string;
  device: string;
  range: 'month' | 'year';
  points: SensorHistoryPoint[];
  source: 'influx' | 'empty';
}

/** Clé d'identification d'un capteur : `node/chip/feature` (aucun `/` à l'intérieur). */
export function sensorKey(r: { node: string; chip: string; feature: string }): string {
  return `${r.node}/${r.chip}/${r.feature}`;
}

/**
 * Seuil effectif d'un capteur : le seuil personnalisé si défini, sinon le seuil
 * firmware (`tempCrit`). `null` si les deux sont absents (le front replie sur
 * la coloration historique 80/60 °C).
 */
export function effectiveSensorThreshold(
  reading: { node: string; chip: string; feature: string; tempCrit: number | null },
  thresholds: SensorThresholds,
): number | null {
  const custom = thresholds[sensorKey(reading)];
  if (custom !== undefined) return custom;
  return reading.tempCrit;
}

/**
 * Ton d'une température selon le seuil effectif.
 * - `crit` : temp ≥ seuil effectif (le capteur a atteint son seuil d'alerte).
 * - `warn` : temp dans la marge de 20 °C sous le seuil effectif.
 * - `ok`   : en dessous.
 * - `na`   : pas de température.
 * Sans seuil effectif (ni perso ni firmware) : repli historique 80 °C / 60 °C.
 */
export function tempTone(tempC: number | null, effective: number | null): 'ok' | 'warn' | 'crit' | 'na' {
  if (tempC === null) return 'na';
  if (effective === null) {
    if (tempC >= 80) return 'crit';
    if (tempC >= 60) return 'warn';
    return 'ok';
  }
  if (tempC >= effective) return 'crit';
  if (tempC >= effective - 20) return 'warn';
  return 'ok';
}

/**
 * Ton de la santé SMART (tri-state).
 * - `ok`      : health_ok = true  (SMART PASSED).
 * - `crit`    : health_ok = false (SMART FAILED — un disque qui échoue vraiment).
 * - `unknown` : health_ok = null  (pas de SMART : disque virtuel, RAID, état
 *               illisible). Distinct de `crit` : une santé inconnue n'est pas une
 *               panne — sinon tout volume logique RAID serait « CRITIQUE ».
 */
export function smartHealthTone(healthOk: boolean | null): 'ok' | 'crit' | 'unknown' {
  if (healthOk === null) return 'unknown';
  return healthOk ? 'ok' : 'crit';
}

/**
 * Température d'un disque SMART à afficher.
 * Telegraf écrit `0` quand le disque n'expose pas de capteur de température
 * (disque virtuel, RAID) — aucun disque réel ne tourne à 0 °C, donc 0 =
 * « pas de lecture ». `na` → le front affiche « — ».
 */
export function smartTempDisplay(tempC: number | null): { value: number | null } {
  if (tempC === null || tempC === 0) return { value: null };
  return { value: tempC };
}
