import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption, LineSeriesOption } from 'echarts';
import { sensorKey, type SensorHistoryResponse, type SensorReading } from '@prox4u/shared';
import { fetchSensorHistory } from '../../../core/api/apiClient';
import { useEChart } from '../../../hooks/use-echart';
import { chartTheme } from '../../../lib/chart-theme';
import { cn } from '../../../lib/utils';
import { useTheme } from '../../../store/theme';
import { Dialog } from '../../../components/ui/dialog';
import { Skeleton } from '../../../components/ui/skeleton';

type Range = 'month' | 'year';

/**
 * Fenêtre « Historique des valeurs » d'un capteur (température) — ouverte depuis
 * l'icône de la table « Capteurs ». Les mesures Telegraf (10 s) sont bucketées
 * côté serveur (raw 10 min / 31 j + consolidated 15 min / 1 an) ; les **trous**
 * de la courbe = nœud sans mesure (éteint) — ils restent visibles, pas comblés.
 */
export function SensorHistoryDialog({ sensor, onClose }: { sensor: SensorReading | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [range, setRange] = useState<Range>('month');
  const [data, setData] = useState<SensorHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sensor) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setData(null);
    fetchSensorHistory(sensor.node, sensor.chip, sensor.feature, range)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((err) => {
        if (alive) setError((err as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [sensor, range]);

  const open = sensor !== null;
  const last = data && data.points.length > 0 ? data.points[data.points.length - 1] : null;

  return (
    <Dialog open={open} onClose={onClose} wide title={sensor ? t('nodeSensors.history.title') : ''}>
      {sensor && (
        <div className="space-y-3">
          {/* En-tête : identité du capteur + dernière valeur + période */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-mono text-xs" title={sensorKey(sensor)}>
                {sensorKey(sensor)}
              </div>
              {last && (
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {t('nodeSensors.history.last', { temp: last.temp })}
                </div>
              )}
            </div>
            <div className="flex rounded-lg border p-0.5" role="group" aria-label={t('nodeSensors.range.label')}>
              {(['month', 'year'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={cn(
                    'rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                    range === r ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(r === 'year' ? 'nodeSensors.range.year' : 'nodeSensors.range.month')}
                </button>
              ))}
            </div>
          </div>

          {/* Graphe / états */}
          {loading ? (
            <Skeleton className="h-72 w-full" />
          ) : error ? (
            <p className="text-xs text-crit">{t('nodeSensors.history.error', { msg: error })}</p>
          ) : data && data.points.length > 0 ? (
            <SensorHistoryChart data={data} />
          ) : (
            <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
              {t('nodeSensors.history.empty')}
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">{t('nodeSensors.history.hint')}</p>
        </div>
      )}
    </Dialog>
  );
}

/** Graphe de température + lignes de référence des seuils (effectif, firmware si perso). */
function SensorHistoryChart({ data }: { data: SensorHistoryResponse }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

  const option = useMemo<EChartsOption>(() => {
    const seriesData = data.points.map((p) => [p.time * 1000, p.temp]);
    const series: LineSeriesOption[] = [
      {
        name: t('nodeSensors.temp'),
        type: 'line',
        smooth: true,
        symbol: 'none',
        data: seriesData,
        // Trous = nœud sans mesure (éteint) : la ligne ne traverse pas le vide.
        connectNulls: false,
        lineStyle: { width: 2, color: ct.temp },
        itemStyle: { color: ct.temp },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: `${ct.temp}44` },
              { offset: 1, color: `${ct.temp}00` },
            ],
          },
        },
        // Lignes de référence : seuil effectif (rouge pointillés) + firmware
        // (gris) quand un seuil perso le remplace.
        markLine:
          data.threshold !== null || (data.thresholdCustom && data.thresholdFirmware !== null)
            ? {
                silent: true,
                symbol: 'none',
                data: [
                  ...(data.threshold !== null
                    ? [
                        {
                          yAxis: data.threshold,
                          lineStyle: { type: 'dashed' as const, color: '#ef4444', width: 1.5 },
                          label: {
                            formatter: `${t('nodeSensors.thresholdEffective')} ${data.threshold} °C`,
                            color: '#ef4444',
                            fontSize: 10,
                            position: 'insideEndTop' as const,
                          },
                        },
                      ]
                    : []),
                  ...(data.thresholdCustom && data.thresholdFirmware !== null
                    ? [
                        {
                          yAxis: data.thresholdFirmware,
                          lineStyle: { type: 'dotted' as const, color: ct.axisLabel, width: 1 },
                          label: {
                            formatter: `${t('nodeSensors.thresholdFirmware')} ${data.thresholdFirmware} °C`,
                            color: ct.axisLabel,
                            fontSize: 10,
                            position: 'insideEndBottom' as const,
                          },
                        },
                      ]
                    : []),
                ],
              }
            : undefined,
      },
    ];
    return {
      animation: false,
      grid: { top: 24, right: 16, bottom: 20, left: 36 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: ct.tooltipBg,
        borderColor: ct.tooltipBorder,
        textStyle: { color: ct.tooltipText, fontSize: 11 },
        axisPointer: { type: 'line', lineStyle: { color: ct.axisLine } },
        valueFormatter: (v) => (typeof v === 'number' ? `${v} °C` : String(v)),
      },
      legend: { top: 0, textStyle: { color: ct.legend, fontSize: 11 } },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: ct.axisLine } },
        axisTick: { show: false },
        axisLabel: { color: ct.axisLabel, fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: '{value}°' },
        splitLine: { lineStyle: { color: ct.splitLine } },
      },
      series,
    };
  }, [data, ct, t]);

  const ref = useEChart(option);
  return <div ref={ref} className="h-72 w-full" />;
}
