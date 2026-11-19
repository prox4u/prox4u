import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption, LineSeriesOption } from 'echarts';
import {
  addWidget,
  mergePageConfig,
  removeWidget,
  sensorKey,
  type SensorHistoryPoint,
  type SensorHistoryResponse,
  type SensorReading,
  type SmartDevice,
  type WidgetItem,
} from '@prox4u/shared';
import { fetchSensorHistory, fetchSmartHistory } from '../../../core/api/apiClient';
import { useEChart } from '../../../hooks/use-echart';
import { chartTheme } from '../../../lib/chart-theme';
import { cn } from '../../../lib/utils';
import { useTheme } from '../../../store/theme';
import { useUserConfig } from '../../../store/user-config';
import type { CoreWidgetDef } from '../../../core/widgets/types';
import { layoutsEqual } from '../../../core/widgets/types';
import { WidgetGridLayout } from '../../../core/widgets/widget-grid';
import { WidgetLibraryPanel } from '../../../core/widgets/widget-library';
import { WidgetToolbar } from '../../../core/widgets/widget-toolbar';
import { Dialog } from '../../../components/ui/dialog';
import { Skeleton } from '../../../components/ui/skeleton';

type Range = 'month' | 'year';

/**
 * Cible de la fenêtre « Historique des valeurs » : un capteur (table `sensors`,
 * seuils effectif/firmware) ou un disque SMART (table `smart_device`, référence
 * critique fixe 80 °C de la table).
 */
export type HistoryTarget =
  | { kind: 'sensor'; sensor: SensorReading }
  | { kind: 'smart'; device: SmartDevice };

/** Identité stable de la cible — clé de fetch + en-tête de la fenêtre. */
export function historyTargetKey(target: HistoryTarget): string {
  return target.kind === 'sensor'
    ? sensorKey(target.sensor)
    : `${target.device.node}/${target.device.device}`;
}

/** Ligne de référence à tracer sur le graphe (seuil ou seuil firmware). */
interface HistoryMarkLine {
  value: number;
  color: string;
  /** `true` = pointillés rouges (seuil critique), `false` = petits pointillés gris (référence). */
  primary: boolean;
  label: string;
}

/** Réponse normalisée pour le graphe (indifférent capteur / disque). */
interface HistoryData {
  points: SensorHistoryPoint[];
  markLines: HistoryMarkLine[];
}

/**
 * Fenêtre « Historique des valeurs » — ouverte depuis l'icône des tables
 * « Capteurs » et « Santé disques (SMART) ». Les mesures Telegraf (10 s) sont
 * bucketées côté serveur (raw 10 min / 31 j + consolidated 15 min / 1 an) ;
 * les **trous** de la courbe = nœud sans mesure (éteint) — ils restent
 * visibles, pas comblés.
 */
export function HistoryDialog({ target, onClose }: { target: HistoryTarget | null; onClose: () => void }) {
  const { t } = useTranslation();
  // NB : `chartTheme()` renvoie un objet NOUVEAU à chaque appel — on dépend de
  // `theme` (string stable) dans l'effet, jamais de l'objet (boucle de re-fetch).
  const theme = useTheme((s) => s.theme);
  const [range, setRange] = useState<Range>('month');
  const [data, setData] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setData(null);

    const axisLabel = chartTheme(theme).axisLabel;
    const load: Promise<HistoryData> =
      target.kind === 'sensor'
        ? fetchSensorHistory(target.sensor.node, target.sensor.chip, target.sensor.feature, range).then((d) => ({
            points: d.points,
            markLines: sensorMarkLines(d, t, axisLabel),
          }))
        : fetchSmartHistory(target.device.node, target.device.device, range).then((d) => ({
            points: d.points,
            // Pas de temp_crit pour les disques : référence critique fixe de la table.
            markLines: [{ value: 80, color: '#ef4444', primary: true, label: t('nodeSensors.history.smartThreshold') }],
          }));

    load
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
  }, [target, range, t, theme]);

  // Personnalisation du graphe d'historique par utilisateur : le graphe est un
  // WIDGET redimensionnable (framework core/widgets), persisté par compte et par
  // cible (scope = identité stable de la cible — capteur ou disque SMART). Survit
  // à la reconnexion (serveur = source de vérité).
  const scope = target ? historyTargetKey(target) : '';
  const stored = useUserConfig((s) => s.config?.pages.sensorHistory?.[scope] ?? null);
  const updatePage = useUserConfig((s) => s.updatePage);
  const clearPage = useUserConfig((s) => s.clearPage);
  const [libraryOpen, setLibraryOpen] = useState(false);

  // Catalogue : un seul widget — le graphe (gère les états chargement/erreur/vide).
  const catalog = useMemo<CoreWidgetDef[]>(
    () => [
      {
        id: 'sensor-history-chart',
        title: t('nodeSensors.history.title'),
        default: { w: 12, h: 6 },
        minW: 4,
        minH: 4,
        render: () =>
          loading ? (
            <Skeleton className="h-full w-full" />
          ) : error ? (
            <div className="flex h-full items-center justify-center p-3 text-xs text-crit">
              {t('nodeSensors.history.error', { msg: error })}
            </div>
          ) : data && data.points.length > 0 ? (
            <HistoryChart points={data.points} markLines={data.markLines} />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {t('nodeSensors.history.empty')}
            </div>
          ),
      },
    ],
    [t, loading, error, data],
  );

  const catalogKey = useMemo(() => catalog.map((c) => c.id).join(','), [catalog]);
  const defaultLayout = useMemo<WidgetItem[]>(
    () => [{ widgetId: 'sensor-history-chart', x: 0, y: 0, w: 12, h: 6 }],
    [],
  );
  const merged = useMemo(
    () => mergePageConfig(stored, catalog, defaultLayout),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stored, catalogKey, defaultLayout],
  );

  const onLayoutChange = (layout: WidgetItem[]) => {
    if (!scope) return;
    if (layoutsEqual(layout, merged.layout)) return;
    updatePage('sensorHistory', scope, { layout, library: merged.library });
  };
  const onRemove = (widgetId: string) => {
    if (!scope) return;
    updatePage('sensorHistory', scope, removeWidget(merged, widgetId));
  };
  const onAdd = (widgetId: string) => {
    if (!scope) return;
    const def = catalog.find((c) => c.id === widgetId);
    if (def) updatePage('sensorHistory', scope, addWidget(merged, def));
  };
  const onReset = () => {
    if (!scope) return;
    clearPage('sensorHistory', scope);
  };

  const open = target !== null;
  const last = data && data.points.length > 0 ? data.points[data.points.length - 1] : null;

  return (
    <Dialog open={open} onClose={onClose} wide title={target ? t('nodeSensors.history.title') : ''}>
      {target && (
        <div className="space-y-3">
          {/* En-tête : identité de la cible + dernière valeur + période */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-mono text-xs" title={historyTargetKey(target)}>
                {historyTargetKey(target)}
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

          {/* Barre d'outils : bibliothèque + réinitialiser + indicateur de sauvegarde. */}
          <div className="flex items-center justify-end">
            <WidgetToolbar
              libraryOpen={libraryOpen}
              onToggleLibrary={() => setLibraryOpen((o) => !o)}
              onReset={onReset}
              libraryCount={merged.library.length}
            />
          </div>
          {/* Graphe d'historique = widget redimensionnable (taille persistée par cible). */}
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <WidgetGridLayout
                catalog={catalog}
                config={merged}
                ctx={{ endpointId: '' }}
                onLayoutChange={onLayoutChange}
                onRemove={onRemove}
              />
            </div>
            {libraryOpen && (
              <WidgetLibraryPanel
                catalog={catalog}
                config={merged}
                onAdd={onAdd}
                onRemove={onRemove}
                onClose={() => setLibraryOpen(false)}
              />
            )}
          </div>

          <p className="text-[11px] text-muted-foreground">{t('nodeSensors.history.hint')}</p>
        </div>
      )}
    </Dialog>
  );
}

/** Lignes de référence d'un capteur : seuil effectif + firmware (si perso). */
function sensorMarkLines(d: SensorHistoryResponse, t: (key: string) => string, axisLabel: string): HistoryMarkLine[] {
  const lines: HistoryMarkLine[] = [];
  if (d.threshold !== null) {
    lines.push({ value: d.threshold, color: '#ef4444', primary: true, label: `${t('nodeSensors.thresholdEffective')} ${d.threshold} °C` });
  }
  if (d.thresholdCustom && d.thresholdFirmware !== null) {
    lines.push({ value: d.thresholdFirmware, color: axisLabel, primary: false, label: `${t('nodeSensors.thresholdFirmware')} ${d.thresholdFirmware} °C` });
  }
  return lines;
}

/** Graphe de température + lignes de référence (seuils capteur / référence disque). */
function HistoryChart({ points, markLines }: { points: SensorHistoryPoint[]; markLines: HistoryMarkLine[] }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

  const option = useMemo<EChartsOption>(() => {
    const seriesData = points.map((p) => [p.time * 1000, p.temp]);
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
        // Lignes de référence : seuil critique (rouge pointillés) + référence
        // secondaire (gris petits pointillés) — capteurs : effectif + firmware ;
        // disques : seule la référence critique fixe 80 °C.
        markLine:
          markLines.length > 0
            ? {
                silent: true,
                symbol: 'none',
                data: markLines.map((l, i) => ({
                  yAxis: l.value,
                  lineStyle: { type: l.primary ? ('dashed' as const) : ('dotted' as const), color: l.color, width: l.primary ? 1.5 : 1 },
                  label: {
                    formatter: l.label,
                    color: l.color,
                    fontSize: 10,
                    position: i === 0 ? ('insideEndTop' as const) : ('insideEndBottom' as const),
                  },
                })),
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
  }, [points, markLines, ct, t]);

  const ref = useEChart(option);
  // `h-full` : le graphe remplit la carte du widget (redimensionnable) — le
  // ResizeObserver de useEChart gère le resize react-grid-layout.
  return <div ref={ref} className="h-full w-full" />;
}
