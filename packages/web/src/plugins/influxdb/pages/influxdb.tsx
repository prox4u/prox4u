import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Database } from 'lucide-react';
import { fetchInfluxDb } from '../../../core/api/apiClient';
import type { InfluxDbResponse } from '../../../core/api/types';
import { InfluxKpiRow } from '../components/kpi-row';
import { InfluxHistoryCharts } from '../components/history-charts';
import { InfluxDatabasesCard } from '../components/databases-card';
import { InfluxArchiveCard } from '../components/archive-card';
import { InfluxSizingCard } from '../components/sizing-card';
import { InfluxActionsPanel } from '../components/actions-panel';
import { Skeleton } from '../../../components/ui/skeleton';

/**
 * Page « InfluxDB 3 Core » — vision (KPIs, graphiques, bases, archivage) +
 * action (panneau restreint aux groupes INFLUX_ACTION_GROUPS, canAct serveur).
 * Lecture : GET /api/influxdb (refresh 30 s + après action) ; graphiques :
 * GET /api/influxdb/history (cache serveur 5 min).
 */
export function InfluxDbPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<InfluxDbResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    fetchInfluxDb()
      .then(setData)
      .catch((err) => console.warn('chargement /api/influxdb en échec', err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Database className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t('influxdb.title')}</h1>
      </div>

      {loading && !data ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
          <Skeleton className="h-72 w-full" />
        </div>
      ) : data ? (
        <>
          <InfluxKpiRow data={data} />
          <InfluxHistoryCharts />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <InfluxDatabasesCard databases={data.databases} enabled={data.enabled} />
            <InfluxArchiveCard archive={data.archive} />
          </div>
          <InfluxSizingCard />
          <InfluxActionsPanel
            canAct={data.canAct}
            enabled={data.enabled}
            databases={data.databases}
            onAction={load}
          />
        </>
      ) : (
        <div className="text-sm text-muted-foreground">{t('common.error')}</div>
      )}
    </div>
  );
}
