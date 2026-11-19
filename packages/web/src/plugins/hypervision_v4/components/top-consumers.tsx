import { useTranslation } from 'react-i18next';
import { BarChart } from '@tremor/react';
import type { PoolAggregate, TopConsumer } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';
import { formatBytes, formatPct } from '../../../lib/utils';

/** CORPS du panneau top consommateurs — table VMs + graphe pools (aucun extra). */
export function TopConsumersBody({ topVms, topPools }: { topVms: TopConsumer[]; topPools: PoolAggregate[] }) {
  const { t } = useTranslation();

  return (
    <div className="h-full space-y-4 overflow-y-auto">
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('top.byVm')}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>VM</TableHead>
              <TableHead>{t('common.node')}</TableHead>
              <TableHead>Pool</TableHead>
              <TableHead className="text-right">{t('top.cpu')}</TableHead>
              <TableHead className="text-right">{t('top.ram')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {topVms.map((v) => (
              <TableRow key={v.vmid}>
                <TableCell className="font-medium">
                  {v.name} <span className="text-xs text-muted-foreground">#{v.vmid}</span>
                </TableCell>
                <TableCell>{v.node}</TableCell>
                <TableCell>{v.pool ?? t('top.noPool')}</TableCell>
                <TableCell className="text-right font-semibold">{formatPct(v.cpuPct)}</TableCell>
                <TableCell className="text-right">
                  {formatBytes(v.memBytes)}{' '}
                  <span className="text-xs text-muted-foreground">({formatPct(v.memPct, 0)})</span>
                </TableCell>
              </TableRow>
            ))}
            {topVms.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  —
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('top.byPool')}
        </div>
        <BarChart
          className="h-40"
          data={topPools.map((p) => ({ pool: p.pool, [t('top.cpu')]: p.cpuPct }))}
          index="pool"
          categories={[t('top.cpu')]}
          colors={['blue', 'violet', 'cyan', 'emerald', 'amber']}
          layout="horizontal"
          valueFormatter={(v) => `${v.toFixed(0)} %`}
        />
      </div>
    </div>
  );
}

export function TopConsumers({ topVms, topPools }: { topVms: TopConsumer[]; topPools: PoolAggregate[] }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader draggable>
        <CardTitle>{t('top.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <TopConsumersBody topVms={topVms} topPools={topPools} />
      </CardContent>
    </Card>
  );
}
