import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type { HealthScore } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { useEChart } from '../../../hooks/use-echart';

const TONE_COLOR: Record<HealthScore['label'], string> = {
  nominal: '#10b981',
  degraded: '#f59e0b',
  critical: '#ef4444',
};

export function HealthGauge({ health }: { health: HealthScore }) {
  const { t } = useTranslation();
  const color = TONE_COLOR[health.label];

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
          data: [{ value: health.score }],
        },
      ],
    }),
    [health.score, color],
  );

  const ref = useEChart(option);

  return (
    <Card>
      <CardHeader draggable className="flex-row items-center justify-between">
        <CardTitle>{t('health.score')}</CardTitle>
        <Badge tone={health.label === 'nominal' ? 'ok' : health.label === 'degraded' ? 'warn' : 'crit'}>
          {t(`health.${health.label}`)}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col">
        <div ref={ref} className="min-h-[150px] w-full flex-1" />
        <ul className="mt-2 max-h-28 shrink-0 space-y-1 overflow-y-auto">
          {health.penalties.map((p) => (
            <li key={p.reasonKey} className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{t(p.reasonKey, p.params)}</span>
              <span className="shrink-0 font-medium text-crit">−{p.points}</span>
            </li>
          ))}
          {health.penalties.length === 0 && (
            <li className="text-xs text-muted-foreground">{t('dashboard.health.noPenalty')}</li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}
