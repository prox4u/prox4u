import type { EChartsOption } from 'echarts';
import type { MetricsTimeframe } from '@prox4u/shared';
import type { ChartTheme } from './chart-theme';
import { formatBps } from './utils';

/**
 * Briques communes des onglets Monitor (VM et nœud, inventaire v2) :
 * libellés d'axe, constructeurs d'options ECharts (%, débits) et export CSV.
 */

/** Une série de graphe de monitor (nom, valeurs par point, couleur). */
export interface MonitorSeries {
  name: string;
  data: (number | null)[];
  color: string;
  /** Alpha hexadécimal du dégradé de remplissage — défaut '44'. */
  areaAlpha?: string;
}

/** Bandes de seuils d'usage (overcommit.json) pour les graphes en %. */
export interface PctBands {
  warnPct: number;
  critPct: number;
}

/** Libellé d'axe X selon le timeframe (heure:minute en 1 h / 24 h, jour/mois sinon). */
export function timeLabel(t: number, tf: MetricsTimeframe): string {
  const d = new Date(t * 1000);
  if (tf === 'hour' || tf === 'day') {
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

/**
 * Graphe en % (axe Y borné 0–100) — CPU / RAM / disque.
 * `bands` ajoute les bandes de seuils d'usage sur la première série (fond très discret).
 */
export function pctOption(
  ct: ChartTheme,
  tf: MetricsTimeframe,
  times: number[],
  series: MonitorSeries[],
  bands?: PctBands,
): EChartsOption {
  return {
    animation: false,
    grid: { top: series.length > 1 ? 32 : 24, right: 16, bottom: 20, left: 36 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: ct.tooltipBg,
      borderColor: ct.tooltipBorder,
      textStyle: { color: ct.tooltipText, fontSize: 11 },
      axisPointer: { type: 'line', lineStyle: { color: ct.axisLine } },
      valueFormatter: (v) => (typeof v === 'number' ? `${v.toFixed(1)} %` : String(v)),
    },
    legend:
      series.length > 1
        ? {
            top: 0,
            right: 0,
            itemWidth: 12,
            itemHeight: 3,
            textStyle: { color: ct.legend, fontSize: 11 },
            data: series.map((s) => s.name),
          }
        : undefined,
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: times,
      axisLine: { lineStyle: { color: ct.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: (v: string) => timeLabel(Number(v), tf) },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: '{value} %' },
      splitLine: { lineStyle: { color: ct.splitLine } },
    },
    series: series.map((s, i) => ({
      name: s.name,
      type: 'line',
      smooth: true,
      symbol: 'none',
      data: s.data,
      lineStyle: { width: 2, color: s.color },
      itemStyle: { color: s.color },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: `${s.color}${s.areaAlpha ?? '44'}` },
            { offset: 1, color: `${s.color}00` },
          ],
        },
      },
      // bandes de seuils d'usage (overcommit.json) — fond très discret
      ...(i === 0 && bands
        ? {
            markArea: {
              silent: true,
              data: [
                [{ yAxis: 0, itemStyle: { color: '#10b981', opacity: 0.05 } }, { yAxis: bands.warnPct }],
                [{ yAxis: bands.warnPct, itemStyle: { color: '#f59e0b', opacity: 0.07 } }, { yAxis: bands.critPct }],
                [{ yAxis: bands.critPct, itemStyle: { color: '#ef4444', opacity: 0.08 } }, { yAxis: 100 }],
              ],
            },
          }
        : {}),
    })),
  };
}

/** Options communes aux graphes de débit (disque, réseau) : axe Y en o/s ou bits/s + légende. */
export function rateOption(
  ct: ChartTheme,
  tf: MetricsTimeframe,
  times: number[],
  series: MonitorSeries[],
): EChartsOption {
  return {
    animation: false,
    grid: { top: 32, right: 16, bottom: 20, left: 56 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: ct.tooltipBg,
      borderColor: ct.tooltipBorder,
      textStyle: { color: ct.tooltipText, fontSize: 11 },
      axisPointer: { type: 'line', lineStyle: { color: ct.axisLine } },
      valueFormatter: (v) => (typeof v === 'number' ? formatBps(v) : String(v)),
    },
    legend: {
      top: 0,
      right: 0,
      itemWidth: 12,
      itemHeight: 3,
      textStyle: { color: ct.legend, fontSize: 11 },
      data: series.map((s) => s.name),
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: times,
      axisLine: { lineStyle: { color: ct.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: (v: string) => timeLabel(Number(v), tf) },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: ct.axisLabel, fontSize: 10, formatter: (v: number) => formatBps(v) },
      splitLine: { lineStyle: { color: ct.splitLine } },
    },
    series: series.map((s) => ({
      name: s.name,
      type: 'line',
      smooth: true,
      symbol: 'none',
      data: s.data,
      lineStyle: { width: 2, color: s.color },
      itemStyle: { color: s.color },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: `${s.color}${s.areaAlpha ?? '44'}` },
            { offset: 1, color: `${s.color}00` },
          ],
        },
      },
    })),
  };
}

/** Téléchargement CSV — BOM UTF-8 + échappement des séparateurs (« " ; nouvelle ligne). */
export function downloadCsvFile(filename: string, header: string[], rows: string[][]): void {
  const esc = (s: string) => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const csv = [header, ...rows].map((l) => l.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
