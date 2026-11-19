import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { EndpointSnapshot, NodeHealth } from '@prox4u/shared';
import { usageSeverity } from '@prox4u/shared';
import { Badge } from '../../../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '../../../components/ui/table';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';

interface MatrixRow {
  ep: EndpointSnapshot;
  node: NodeHealth;
  vmsRunning: number;
  vmsTotal: number;
  /** true = première ligne du cluster (affiche le nom du cluster, sinon cellule vide). */
  firstOfCluster: boolean;
}

/**
 * Vue d'ensemble — matrice nœuds tous clusters : une ligne par nœud, groupés
 * par cluster, usage courant (CPU / RAM / disque) teinté selon les seuils
 * d'usage d'overcommit.json, VMs en marche/total, clic → page nœud.
 * Source : snapshot WS (NodeHealth + VmSummary) — aucune API supplémentaire.
 * Nœud hors ligne : badge crit + cellules « — » (jamais de valeur inventée).
 */
export function NodeMatrixBody({ eps }: { eps: EndpointSnapshot[] }) {
  const { t } = useTranslation();
  const config = useOvercommitConfig();

  const rows = useMemo<MatrixRow[]>(() => {
    const out: MatrixRow[] = [];
    let lastCluster = '';
    for (const ep of [...eps].sort((a, b) => a.name.localeCompare(b.name))) {
      const snap = ep.snapshot;
      if (!snap) continue;
      for (const node of [...snap.nodes].sort((a, b) => a.node.localeCompare(b.node))) {
        const vms = snap.vms.filter((v) => v.node === node.node);
        out.push({
          ep,
          node,
          vmsRunning: vms.filter((v) => v.status === 'running').length,
          vmsTotal: vms.length,
          firstOfCluster: ep.name !== lastCluster,
        });
        lastCluster = ep.name;
      }
    }
    return out;
  }, [eps]);

  const pctCell = (pct: number | null) => {
    if (pct === null) return <span className="text-muted-foreground">—</span>;
    const tone = usageSeverity(pct, config);
    const color = tone === 'crit' ? 'text-crit' : tone === 'warn' ? 'text-warn' : 'text-ok';
    return <span className={`tabular-nums ${color}`}>{pct.toFixed(0)} %</span>;
  };
  const dash = <span className="text-muted-foreground">—</span>;

  if (rows.length === 0) {
    return <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">{t('overview.nodesMatrix.none')}</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <Table>
        <TableHeader>
          <tr>
            <TableHead>{t('overview.cluster')}</TableHead>
            <TableHead>{t('topbar.nodes')}</TableHead>
            <TableHead>{t('common.state')}</TableHead>
            <TableHead>CPU</TableHead>
            <TableHead>RAM</TableHead>
            <TableHead>{t('metrics.disk')}</TableHead>
            <TableHead>VMs</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {rows.map(({ ep, node, vmsRunning, vmsTotal, firstOfCluster }) => (
            <tr key={`${ep.id}-${node.node}`}>
              <TableCell className="whitespace-nowrap text-muted-foreground">{firstOfCluster ? ep.name : ''}</TableCell>
              <TableCell>
                <Link
                  to={`/e/${encodeURIComponent(ep.id)}/n/${encodeURIComponent(node.node)}`}
                  className="font-medium hover:text-primary hover:underline"
                >
                  {node.node}
                </Link>
              </TableCell>
              <TableCell>
                {node.online ? (
                  <span className="whitespace-nowrap text-ok">
                    ● {t('nodes.online')}
                  </span>
                ) : (
                  <Badge tone="crit">{t('nodes.offline')}</Badge>
                )}
              </TableCell>
              <TableCell>{node.online ? pctCell(node.cpuPct) : dash}</TableCell>
              <TableCell>{node.online ? pctCell(node.ramPct) : dash}</TableCell>
              <TableCell>{node.online ? pctCell(node.diskPct) : dash}</TableCell>
              <TableCell className="tabular-nums">{node.online ? `${vmsRunning}/${vmsTotal}` : dash}</TableCell>
            </tr>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
