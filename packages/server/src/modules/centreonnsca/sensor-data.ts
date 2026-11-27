import type { SensorAlarmData } from '@prox4u/shared';

/**
 * Cache des données capteurs pour le moteur d'alarmes (GitHub #4) — TTL 60 s :
 * l'engine tick tous les 15 s et les données Telegraf arrivent toutes les 10 s ;
 * UNE requête InfluxDB par minute est partagée entre TOUTES les règles
 * capteurs (pas de query par règle). Résultat `null` (source en échec) :
 * pas d'échantillon, pas de transition (robustesse, aucun crash) — le null est
 * aussi mis en cache (pas de re-query en boucle si InfluxDB est down).
 */
export class SensorDataCache {
  private at = 0;
  private value: SensorAlarmData | null = null;
  private hasCache = false;
  private pending: Promise<SensorAlarmData | null> | null = null;

  constructor(
    private fetch: () => Promise<SensorAlarmData | null>,
    private ttlMs = 60_000,
  ) {}

  async get(): Promise<SensorAlarmData | null> {
    if (this.hasCache && Date.now() - this.at < this.ttlMs) return this.value;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const v = await this.fetch();
        this.value = v;
        this.at = Date.now();
        this.hasCache = true;
        return v;
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }
}
