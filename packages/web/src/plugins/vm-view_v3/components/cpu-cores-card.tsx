import { useMemo } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type { NodeSystemRow } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { useEChart } from '../../../hooks/use-echart';
import { useTheme } from '../../../store/theme';
import { chartTheme } from '../../../lib/chart-theme';
import { downloadCsvFile } from '../../../lib/monitor-charts';

/** Teinte d'une barre d'usage : < 70 ok, < 90 warn, sinon crit (cœur quasi saturé). */
function barColor(pct: number): string {
  if (pct >= 90) return '#ef4444';
  if (pct >= 70) return '#f59e0b';
  return '#10b981';
}

/**
 * Monitor nœud (Vue VM v3) — corps « CPU par cœur » : usage courant par cœur (barres
 * horizontales, dernier point de l'agent — 10 s, auto-refresh 60 s côté parent). Sur du
 * vrai matériel, c'est le signal qui révèle un cœur saturé (NUMA, pinning, SMT
 * déséquilibré) invisible dans le % agrégé.
 *
 * Grille v3 (personnalisable) : la frame fournit l'en-tête/drag ; le graphe REMPLIT la
 * cellule (min 240 px — agrandir la carte si le nœud a beaucoup de cœurs). L'export CSV
 * est porté par le slot « extra » de la frame (helper `exportCpuCoresCsv` de node-monitor).
 */
export function CpuCoresBody({ row, loading }: { row: NodeSystemRow | undefined; loading: boolean }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

  const cores = row?.cores ?? [];

  const option = useMemo<EChartsOption | null>(() => {
    if (cores.length === 0) return null;
    const byCore = new Map(cores.map((c) => [c.core, c]));
    // cpu0 en haut (les catégories ECharts sont affichées de bas en haut)
    const reversed = [...cores].reverse();
    return {
      animation: false,
      grid: { top: 6, right: 34, bottom: 18, left: 44 },
      tooltip: {
        trigger: 'item',
        backgroundColor: ct.tooltipBg,
        borderColor: ct.tooltipBorder,
        textStyle: { color: ct.tooltipText, fontSize: 11 },
        formatter: (params: unknown) => {
          const p = params as { name: string; value: number };
          const c = byCore.get(p.name);
          if (!c) return '';
          return [
            `<b>${p.name}</b>`,
            `${t('overview.cpubars.usage')} : ${c.usagePct.toFixed(1)} %`,
            `${t('overview.system.iowait')} : ${c.iowaitPct.toFixed(1)} %`,
            `user : ${c.userPct.toFixed(1)} % · system : ${c.systemPct.toFixed(1)} %`,
          ].join('<br/>');
        },
      },
      xAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { color: ct.axisLabel, fontSize: 9, formatter: '{value} %' },
        splitLine: { lineStyle: { color: ct.splitLine } },
      },
      yAxis: {
        type: 'category',
        data: reversed.map((c) => c.core),
        axisLine: { lineStyle: { color: ct.axisLine } },
        axisTick: { show: false },
        axisLabel: { color: ct.axisLabel, fontSize: 9 },
      },
      series: [
        {
          type: 'bar',
          barWidth: '62%',
          data: reversed.map((c) => ({ value: c.usagePct, itemStyle: { color: barColor(c.usagePct) } })),
        },
      ],
    };
  }, [cores, ct, t]);

  const ref = useEChart(option);

  return (
    <div className="flex h-full flex-col gap-2">
      {loading && cores.length === 0 ? (
        <Skeleton className="min-h-[240px] w-full flex-1" />
      ) : (
        <div className="relative min-h-[240px] w-full flex-1">
          <div ref={ref} className="h-full w-full" />
          {cores.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-xs text-muted-foreground">
              {t('overview.cpubars.none')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Carte complète (en-tête + export CSV + corps) — conservée pour la v2 / référence ;
 * la grille v3 (node-monitor) consomme `CpuCoresBody` directement.
 */
export function CpuCoresCard({ row, loading }: { row: NodeSystemRow | undefined; loading: boolean }) {
  const { t } = useTranslation();
  const cores = row?.cores ?? [];

  /** Export CSV — une ligne par cœur. */
  const exportCsv = () => {
    if (!row || cores.length === 0) return;
    const header = ['core', 'usage_pct', 'user_pct', 'system_pct', 'iowait_pct'];
    const rows = cores.map((c) => [
      c.core,
      c.usagePct.toFixed(1),
      c.userPct.toFixed(1),
      c.systemPct.toFixed(1),
      c.iowaitPct.toFixed(1),
    ]);
    downloadCsvFile(`node-cpu-cores-${row.node}-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle title={t('overview.cpubars.hint')}>{t('overview.cpubars')}</CardTitle>
        <button
          onClick={exportCsv}
          disabled={cores.length === 0}
          title={t('vm.mon.export')}
          className="rounded-md border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <CpuCoresBody row={row} loading={loading} />
      </CardContent>
    </Card>
  );
}
