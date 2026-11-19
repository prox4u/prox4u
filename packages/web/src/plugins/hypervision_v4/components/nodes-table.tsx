import { useTranslation } from 'react-i18next';
import type { NodeHealth, Site } from '@prox4u/shared';
import { usageSeverity } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Progress } from '../../../components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';
import { formatUptime } from '../../../lib/utils';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';

function MiniBar({ label, pct }: { label: string; pct: number }) {
  const config = useOvercommitConfig();
  const tone = usageSeverity(pct, config);
  return (
    <div className="min-w-[110px]">
      <div className="mb-0.5 flex justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span>{pct.toFixed(0)} %</span>
      </div>
      <Progress value={pct} tone={tone} className="h-1.5" />
    </div>
  );
}

/** CORPS de la table des nœuds (aucun extra). */
export function NodesTableBody({ nodes, sites }: { nodes: NodeHealth[]; sites: Site[] }) {
  const { t } = useTranslation();
  const siteName = (id: string | null) => sites.find((s) => s.id === id)?.name ?? '—';

  return (
    <div className="h-full overflow-y-auto">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('common.node')}</TableHead>
              <TableHead>{t('common.site')}</TableHead>
              <TableHead>{t('common.state')}</TableHead>
              <TableHead>CPU</TableHead>
              <TableHead>RAM</TableHead>
              <TableHead>{t('nodes.disk')}</TableHead>
              <TableHead className="text-right">{t('common.uptime')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.map((n) => (
              <TableRow key={n.node} className={!n.online ? 'opacity-60' : ''}>
                <TableCell className="font-medium">{n.node}</TableCell>
                <TableCell>{siteName(n.siteId)}</TableCell>
                <TableCell>
                  {n.online ? (
                    <Badge tone={n.severity === 'ok' ? 'ok' : n.severity === 'warn' ? 'warn' : 'crit'}>
                      ● {t('nodes.online')}
                    </Badge>
                  ) : (
                    <Badge tone="crit">{t('nodes.offline')}</Badge>
                  )}
                </TableCell>
                <TableCell>{n.online ? <MiniBar label="CPU" pct={n.cpuPct} /> : '—'}</TableCell>
                <TableCell>{n.online ? <MiniBar label="RAM" pct={n.ramPct} /> : '—'}</TableCell>
                <TableCell>{n.online ? <MiniBar label="Disque" pct={n.diskPct} /> : '—'}</TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {n.online ? t('nodes.uptime', { value: formatUptime(n.uptimeSec) }) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function NodesTable({ nodes, sites }: { nodes: NodeHealth[]; sites: Site[] }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader draggable>
        <CardTitle>{t('nodes.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <NodesTableBody nodes={nodes} sites={sites} />
      </CardContent>
    </Card>
  );
}
