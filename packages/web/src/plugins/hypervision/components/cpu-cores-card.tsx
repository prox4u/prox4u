import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type { NodeSystemRow } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { useEChart } from '../../../hooks/use-echart';
import { useTheme } from '../../../store/theme';
import { chartTheme } from '../../../lib/chart-theme';

/** Teinte d'une barre d'usage : < 70 ok, < 90 warn, sinon crit (cœur quasi saturé). */
function barColor(pct: number): string {
  if (pct >= 90) return '#ef4444';
  if (pct >= 70) return '#f59e0b';
  return '#10b981';
}

/**
 * Vue d'ensemble — carte « CPU par cœur » : usage courant par cœur (barres
 * horizontales, dernier point de l'agent — 10 s). Sur du vrai matériel, c'est le
 * signal qui révèle un cœur saturé (NUMA, pinning, SMT déséquilibré) invisible
 * dans le % agrégé. Nœud sélectionnable ; les nœuds sans donnée CPU n'apparaissent
 * pas dans la liste.
 */
export function CpuCoresCard({ rows }: { rows: NodeSystemRow[] }) {
  const { t } = useTranslation();
  const theme = useTheme((s) => s.theme);
  const ct = chartTheme(theme);

  const nodes = useMemo(() => rows.filter((r) => r.cores.length > 0).map((r) => r.node), [rows]);
  const [node, setNode] = useState('');
  useEffect(() => {
    if (!node && nodes.length > 0) setNode(nodes[0]);
  }, [nodes, node]);

  const row = rows.find((r) => r.node === node);
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
    <Card>
      <CardHeader draggable>
        <CardTitle title={t('overview.cpubars.hint')}>{t('overview.cpubars')}</CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-2">
        {nodes.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
            {t('overview.cpubars.none')}
          </div>
        ) : (
          <>
            <div className="flex justify-end">
              <select
                value={node}
                onChange={(e) => setNode(e.target.value)}
                className="rounded-md border bg-transparent px-1.5 py-0.5 text-[11px] text-foreground"
              >
                {nodes.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div ref={ref} className="min-h-0 w-full flex-1" />
            {cores.length === 0 && (
              <div className="pb-1 text-center text-[11px] text-muted-foreground">{t('overview.cpubars.none')}</div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
