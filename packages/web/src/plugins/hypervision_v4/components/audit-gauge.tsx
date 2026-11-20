import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type { AuditScore } from '@prox4u/shared';
import { useEChart } from '../../../hooks/use-echart';

/** Couleur de la jauge selon le score : ≥80 ok · 50–79 warn · <50 crit. */
function scoreColor(score: number): string {
  if (score >= 80) return '#10b981';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
}

/** Couleur texte d'un constat selon sa sévérité. */
const SEV_TEXT: Record<AuditScore['findings'][number]['severity'], string> = {
  crit: 'text-crit',
  warn: 'text-warn',
  info: 'text-muted-foreground',
};

/**
 * CORPS du score de configuration (audit, P3) — jauge + liste des constats
 * (le badge d'état est porté par le slot `extra` du widget dans la grille v4).
 * Miroir de HealthGaugeBody : même jauge ECharts, liste des constats à la place
 * des pénalités.
 */
export function AuditGaugeBody({ audit }: { audit: AuditScore }) {
  const { t } = useTranslation();
  const color = scoreColor(audit.score);

  const option = useMemo<EChartsOption>(
    () => ({
      series: [
        {
          type: 'gauge',
          min: 0,
          max: 100,
          radius: '95%',
          center: ['50%', '58%'],
          startAngle: 210,
          endAngle: -30,
          progress: { show: true, width: 14, itemStyle: { color } },
          axisLine: { lineStyle: { width: 14, color: [[1, 'rgba(148,163,184,0.2)']] } },
          axisTick: { show: false },
          splitLine: { length: 8, lineStyle: { width: 1, color: 'rgba(148,163,184,0.4)' } },
          axisLabel: { distance: 18, fontSize: 10, color: '#94a3b8' },
          pointer: { show: false },
          anchor: { show: false },
          title: { show: false },
          detail: {
            valueAnimation: true,
            offsetCenter: [0, 0],
            fontSize: 34,
            fontWeight: 700,
            color,
            formatter: (v: number) => `${Math.round(v)}`,
          },
          data: [{ value: audit.score }],
        },
      ],
    }),
    [audit.score, color],
  );

  const ref = useEChart(option);

  return (
    <div className="flex h-full flex-col">
      <div ref={ref} className="min-h-[150px] w-full flex-1" />
      <ul className="mt-2 max-h-28 shrink-0 space-y-1 overflow-y-auto">
        {audit.findings.map((f, i) => (
          <li key={`${f.check}-${i}`} className="flex items-center justify-between gap-2 text-xs">
            <span className={`truncate ${SEV_TEXT[f.severity]}`} title={t(f.messageKey, f.params ?? {})}>
              {t(f.messageKey, f.params ?? {})}
            </span>
            <span className={`shrink-0 font-medium ${SEV_TEXT[f.severity]}`}>
              {t(`audit.severity.${f.severity}`)}
            </span>
          </li>
        ))}
        {audit.findings.length === 0 && (
          <li className="text-xs text-muted-foreground">{t('audit.empty')}</li>
        )}
      </ul>
    </div>
  );
}
