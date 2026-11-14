import { useTranslation } from 'react-i18next';
import type { NodeSystemRow } from '@prox4u/shared';
import { formatBytes, formatUptime } from '../../../lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '../../../components/ui/table';

/**
 * Vue d'ensemble — carte « Système » par nœud : load 1/5/15 (teinté vs nb de
 * cœurs), iowait %, swap, uptime. Source : agent hôte (Telegraf, 10 s) — l'API
 * PVE ne fournit ni load historique ni swap affiché. Trous d'agent = « — »,
 * jamais de valeur inventée.
 */
type Tone = 'ok' | 'warn' | 'crit';
const TONE_CLS: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', crit: 'text-crit' };

/** load1 / cœurs : ≥ 1 = noyau saturé (warn), ≥ 2 = file importante (crit). */
function loadTone(load1: number, nCpus: number): Tone {
  if (nCpus <= 0) return 'ok';
  const r = load1 / nCpus;
  if (r >= 2) return 'crit';
  if (r >= 1) return 'warn';
  return 'ok';
}
function iowaitTone(p: number | null): Tone {
  if (p == null) return 'ok';
  if (p >= 25) return 'crit';
  if (p >= 10) return 'warn';
  return 'ok';
}
function swapTone(p: number | null): Tone {
  if (p == null) return 'ok';
  if (p >= 80) return 'crit';
  if (p >= 50) return 'warn';
  return 'ok';
}

/** Corps de la carte « Système » (tableau seul) — grille personnalisable v2. */
export function SystemNodesBody({ rows, loading }: { rows: NodeSystemRow[]; loading: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="h-full overflow-x-auto">
      {loading && rows.length === 0 ? (
          <Skeleton className="m-2 h-32 w-full" />
        ) : rows.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">{t('overview.system.none')}</div>
        ) : (
          <Table>
            <TableHeader>
              <tr>
                <TableHead>{t('topbar.nodes')}</TableHead>
                <TableHead>{t('overview.system.cores')}</TableHead>
                <TableHead>{t('overview.system.load')}</TableHead>
                <TableHead>{t('overview.system.iowait')}</TableHead>
                <TableHead>{t('overview.system.swap')}</TableHead>
                <TableHead>{t('common.uptime')}</TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <tr key={r.node}>
                  <TableCell className="font-medium">{r.node}</TableCell>
                  <TableCell className="tabular-nums">{r.nCpus > 0 ? r.nCpus : '—'}</TableCell>
                  <TableCell className="tabular-nums">
                    <span className={TONE_CLS[loadTone(r.load1, r.nCpus)]}>{r.load1.toFixed(2)}</span>
                    <span className="text-muted-foreground">
                      {' / '}
                      {r.load5.toFixed(2)} / {r.load15.toFixed(2)}
                    </span>
                  </TableCell>
                  <TableCell className={`tabular-nums ${TONE_CLS[iowaitTone(r.iowaitPct)]}`}>
                    {r.iowaitPct != null ? `${r.iowaitPct.toFixed(1)} %` : '—'}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {r.swapPct != null ? (
                      <span className={TONE_CLS[swapTone(r.swapPct)]}>
                        {r.swapPct.toFixed(r.swapPct < 1 ? 2 : 0)} %
                        <span className="text-muted-foreground">
                          {' '}
                          ({formatBytes(r.swapUsedBytes)} / {formatBytes(r.swapTotalBytes)})
                        </span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums text-xs">{r.uptimeSec > 0 ? formatUptime(r.uptimeSec) : '—'}</TableCell>
                </tr>
              ))}
            </TableBody>
          </Table>
        )}
    </div>
  );
}

export function SystemNodesCard({ rows, loading }: { rows: NodeSystemRow[]; loading: boolean }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader draggable>
        <CardTitle title={t('overview.system.hint')}>{t('overview.system')}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0 pt-1">
        <SystemNodesBody rows={rows} loading={loading} />
      </CardContent>
    </Card>
  );
}
