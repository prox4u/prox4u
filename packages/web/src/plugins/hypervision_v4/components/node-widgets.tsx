import { useTranslation } from 'react-i18next';
import type { VmSummary, WidgetItem } from '@prox4u/shared';
import { usageSeverity } from '@prox4u/shared';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';
import { Badge } from '../../../components/ui/badge';
import { Progress } from '../../../components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';
import { formatBytes } from '../../../lib/utils';
import type { CoreWidgetDef } from '../../../core/widgets/types';

/**
 * Page nœud v4 — CORPS des widgets « KPI instantané » et « table VMs ».
 *
 * La page nœud est une grille unifiée : les 4 KPIs d'état courant + la table VMs
 * + TOUS les graphiques du Monitor nœud (réemployés depuis vm-view_v4) sont
 * déplaçables/retraitables. Les graphiques vivent dans `pages/node.tsx` (catalogue) ;
 * ce fichier porte uniquement les corps des widgets spécifiques à la page nœud
 * (KPIs + table) — les corps de graphiques sont importés depuis vm-view_v4.
 */

/** CORPS d'une carte KPI instantané (valeur + sous-ligne + barre d'usage). */
export function StatBody({ value, sub, pct }: { value: string; sub: string; pct?: number }) {
  const config = useOvercommitConfig();
  return (
    <div className="flex h-full flex-col justify-between gap-1">
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
      <div className="text-[11px] text-muted-foreground">{sub}</div>
      {pct !== undefined && <Progress value={pct} tone={usageSeverity(pct, config)} className="h-1.5" />}
    </div>
  );
}

function VmRow({ vm }: { vm: VmSummary }) {
  const { t } = useTranslation();
  const running = vm.status === 'running';
  return (
    <TableRow className={!running ? 'opacity-60' : ''}>
      <TableCell className="text-muted-foreground">{vm.vmid}</TableCell>
      <TableCell className="font-medium">{vm.name}</TableCell>
      <TableCell>{vm.type === 'lxc' ? 'LXC' : 'KVM'}</TableCell>
      <TableCell>
        <Badge tone={running ? 'ok' : 'default'}>{running ? t('kpi.running') : t('kpi.stopped')}</Badge>
      </TableCell>
      <TableCell className="text-right">{running ? `${vm.cpuPct.toFixed(0)} %` : '—'}</TableCell>
      <TableCell className="text-right">
        {running && vm.maxmemBytes ? `${formatBytes(vm.memBytes)} / ${formatBytes(vm.maxmemBytes)}` : '—'}
      </TableCell>
    </TableRow>
  );
}

/** CORPS de la table VMs du nœud (l'en-tête est porté par la frame du widget). */
export function VmTableBody({ vms }: { vms: VmSummary[] }) {
  const { t } = useTranslation();
  return (
    <div className="h-full overflow-y-auto">
      {vms.length === 0 ? (
        <div className="py-6 text-center text-xs text-muted-foreground">{t('node.vms.none')}</div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>{t('node.vms.col.vm')}</TableHead>
                <TableHead>{t('node.vms.col.type')}</TableHead>
                <TableHead>{t('common.state')}</TableHead>
                <TableHead className="text-right">{t('metrics.cpu')}</TableHead>
                <TableHead className="text-right">{t('metrics.ram')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vms.map((vm) => (
                <VmRow key={vm.vmid} vm={vm} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/**
 * Layout par défaut de la page nœud : rangée de 4 KPIs (w3 h2), table VMs pleine
 * largeur (w12 h4), puis les graphiques empilés pleine largeur (ordre du catalogue).
 * Les widgets dynamiques (netif-*) sont inclus — le layout n'est calculé qu'une fois
 * `ready` (premier chargement node-net terminé).
 */
export function nodeDefaultLayout(catalog: CoreWidgetDef[]): WidgetItem[] {
  const KPI_IDS = new Set(['kpi-cpu', 'kpi-ram', 'kpi-rootfs', 'kpi-load', 'vms']);
  const items: WidgetItem[] = [
    { widgetId: 'kpi-cpu', x: 0, y: 0, w: 3, h: 2 },
    { widgetId: 'kpi-ram', x: 3, y: 0, w: 3, h: 2 },
    { widgetId: 'kpi-rootfs', x: 6, y: 0, w: 3, h: 2 },
    { widgetId: 'kpi-load', x: 9, y: 0, w: 3, h: 2 },
    { widgetId: 'vms', x: 0, y: 2, w: 12, h: 4 },
  ];
  let y = 6;
  for (const def of catalog) {
    if (KPI_IDS.has(def.id)) continue;
    items.push({ widgetId: def.id, x: 0, y, w: 12, h: def.default.h });
    y += def.default.h;
  }
  return items;
}
