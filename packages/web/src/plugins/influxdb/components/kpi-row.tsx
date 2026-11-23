import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '../../../components/ui/card';
import type { InfluxDbResponse } from '../../../core/api/types';

/** Couleur d'un headroom fichiers. */
function headroomClass(h: 'ok' | 'warn' | 'crit'): string {
  if (h === 'crit') return 'text-crit';
  if (h === 'warn') return 'text-warn';
  return 'text-ok';
}

/** Libellé headroom. */
function headroomLabel(h: 'ok' | 'warn' | 'crit', t: (k: string) => string): string {
  if (h === 'crit') return t('influxdb.headroom.crit');
  if (h === 'warn') return t('influxdb.headroom.warn');
  return t('influxdb.headroom.ok');
}

interface Kpi {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}

/** Rangée de KPIs InfluxDB (état, version, file, abandons, latence, headroom). */
export function InfluxKpiRow({ data }: { data: InfluxDbResponse | null }) {
  const { t } = useTranslation();
  if (!data) return null;

  const statusValue = !data.enabled ? t('influxdb.status.disabled') : data.ping ? t('influxdb.status.up') : t('influxdb.status.down');
  const statusClass = !data.enabled ? 'text-muted-foreground' : data.ping ? 'text-ok' : 'text-crit';

  const kpis: Kpi[] = [
    { label: t('influxdb.kpi.status'), value: statusValue, valueClass: statusClass },
    { label: t('influxdb.kpi.version'), value: data.version ?? '—', sub: data.enabled ? undefined : t('influxdb.kpi.version.off') },
    { label: t('influxdb.kpi.queue'), value: String(data.write.queueDepth), sub: t('influxdb.kpi.queue.sub') },
    {
      label: t('influxdb.kpi.dropped'),
      value: String(data.write.dropped),
      sub: `${t('influxdb.kpi.enqueued')} ${data.write.enqueued}`,
      valueClass: data.write.dropped > 0 ? 'text-warn' : undefined,
    },
    {
      label: t('influxdb.kpi.queryMs'),
      value: data.query.lastQueryMs != null ? `${data.query.lastQueryMs} ms` : '—',
      sub: data.query.lastQueryError ?? undefined,
    },
    {
      label: t('influxdb.kpi.headroom'),
      value: headroomLabel(data.fileEstimate.headroom, t),
      sub: `${data.fileEstimate.chunkFiles} / ${data.fileEstimate.fileLimit}`,
      valueClass: headroomClass(data.fileEstimate.headroom),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {kpis.map((k) => (
        <Card key={k.label} className="border">
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">{k.label}</div>
            <div className={`mt-1 truncate text-xl font-semibold tabular-nums ${k.valueClass ?? ''}`} title={k.value}>
              {k.value}
            </div>
            {k.sub && <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={k.sub}>{k.sub}</div>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
