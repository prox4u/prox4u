import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { VmSummary, WidgetItem } from '@prox4u/shared';
import { usageSeverity } from '@prox4u/shared';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';
import { Badge } from '../../../components/ui/badge';
import { Progress } from '../../../components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';
import { formatBytes, formatUptime } from '../../../lib/utils';
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
 * CORPS de la carte « Capacité et utilisation » — 3 barres used vs capacité
 * (CPU en cœurs, Mémoire + Stockage rootfs en octets). Référence : la carte
 * vCenter « Capacité et utilisation ». Données 100 % snapshot nœud (PVE) —
 * aucune requête supplémentaire.
 */
function CapacityRow({
  label,
  pct,
  tone,
  right,
  left,
  rightBottom,
}: {
  label: string;
  pct: number;
  tone: 'default' | 'ok' | 'warn' | 'crit';
  right: string;
  left: string;
  rightBottom: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">{right}</span>
      </div>
      <Progress value={pct} tone={tone} className="h-2" />
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{left}</span>
        <span>{rightBottom}</span>
      </div>
    </div>
  );
}

export function CapacityBody({
  cpuPct,
  cpus,
  memUsedBytes,
  memTotalBytes,
  rootfsUsedBytes,
  rootfsTotalBytes,
}: {
  cpuPct: number;
  cpus: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  rootfsUsedBytes: number | null;
  rootfsTotalBytes: number | null;
}) {
  const { t } = useTranslation();
  const config = useOvercommitConfig();

  const usedCores = cpus ? (cpuPct / 100) * cpus : null;
  const freeCores = cpus && usedCores != null ? cpus - usedCores : null;
  const ramPct = memTotalBytes ? ((memUsedBytes ?? 0) / memTotalBytes) * 100 : null;
  const ramFree = memTotalBytes != null && memUsedBytes != null ? memTotalBytes - memUsedBytes : null;
  const diskPct = rootfsTotalBytes ? ((rootfsUsedBytes ?? 0) / rootfsTotalBytes) * 100 : null;
  const diskFree = rootfsTotalBytes != null && rootfsUsedBytes != null ? rootfsTotalBytes - rootfsUsedBytes : null;

  return (
    <div className="flex h-full flex-col justify-center gap-4">
      <CapacityRow
        label={t('node.capacity.cpu')}
        pct={cpuPct}
        tone={usageSeverity(cpuPct, config)}
        right={freeCores != null ? t('node.capacity.coresFree', { n: freeCores.toFixed(1) }) : '—'}
        left={usedCores != null ? t('node.capacity.coresUsed', { n: usedCores.toFixed(1) }) : '—'}
        rightBottom={cpus != null ? t('node.capacity.coresTotal', { n: cpus }) : '—'}
      />
      <CapacityRow
        label={t('node.capacity.ram')}
        pct={ramPct ?? 0}
        tone={ramPct != null ? usageSeverity(ramPct, config) : 'default'}
        right={ramFree != null ? t('node.capacity.free', { size: formatBytes(ramFree) }) : '—'}
        left={memUsedBytes != null ? t('node.capacity.used', { size: formatBytes(memUsedBytes) }) : '—'}
        rightBottom={memTotalBytes != null ? t('node.capacity.capacity', { size: formatBytes(memTotalBytes) }) : '—'}
      />
      <CapacityRow
        label={t('node.capacity.storage')}
        pct={diskPct ?? 0}
        tone={diskPct != null ? usageSeverity(diskPct, config) : 'default'}
        right={diskFree != null ? t('node.capacity.free', { size: formatBytes(diskFree) }) : '—'}
        left={rootfsUsedBytes != null ? t('node.capacity.used', { size: formatBytes(rootfsUsedBytes) }) : '—'}
        rightBottom={rootfsTotalBytes != null ? t('node.capacity.capacity', { size: formatBytes(rootfsTotalBytes) }) : '—'}
      />
    </div>
  );
}

/**
 * Libellé lisible de la version PVE : `pve-manager/9.1.1/42dba46cf33dac83`
 * → « Proxmox VE 9.1.1 » (le champ `version` du snapshot est la valeur brute
 * de `pveversion` — trop longue pour la carte, on n'en garde que le semver).
 */
function pveVersionLabel(version: string | undefined): string {
  if (!version) return '—';
  const m = version.match(/(\d+\.\d+\.\d+)/);
  return m ? `Proxmox VE ${m[1]}` : `Proxmox VE ${version}`;
}

/**
 * CORPS de la carte « Détails hôte » — identification de l'hôte (hyperviseur,
 * IP, état, uptime, cœurs, NIC, VMs) + empreinte matérielle (modèle CPU + DMI,
 * « — » tant que l'agent hw-info n'a pas été (re)déployé). Référence : la carte
 * vCenter « Détails hôte » + « Matériel ».
 */
export function HostDetailsBody({
  version,
  ip,
  online,
  uptimeSec,
  cpus,
  nicCount,
  vmCount,
  cpuModel,
  product,
  vendor,
  board,
}: {
  version: string | undefined;
  ip: string | undefined;
  online: boolean;
  uptimeSec: number | null;
  cpus: number | null;
  nicCount: number;
  vmCount: number;
  cpuModel: string | null;
  product: string | null;
  vendor: string | null;
  board: string | null;
}) {
  const { t } = useTranslation();
  const rows: [string, ReactNode][] = [
    [t('node.hostDetails.hypervisor'), pveVersionLabel(version)],
    [t('node.hostDetails.ip'), ip ?? '—'],
    [t('common.state'), online ? <Badge tone="ok">● {t('nodes.online')}</Badge> : <Badge tone="crit">{t('nodes.offline')}</Badge>],
    [t('common.uptime'), uptimeSec != null ? formatUptime(uptimeSec) : '—'],
    [t('node.hostDetails.cores'), cpus != null ? String(cpus) : '—'],
    [t('node.hostDetails.nic'), String(nicCount)],
    [t('node.hostDetails.vms'), String(vmCount)],
    [t('node.hostDetails.cpuModel'), cpuModel ?? '—'],
    [t('node.hostDetails.model'), product ?? '—'],
    [t('node.hostDetails.vendor'), vendor ?? '—'],
    [t('node.hostDetails.board'), board ?? '—'],
  ];
  return (
    <div className="grid h-full grid-cols-1 content-start gap-x-6 gap-y-1.5 overflow-y-auto sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-3 text-xs">
          <span className="shrink-0 text-muted-foreground">{label}</span>
          <span className="truncate text-right font-medium" title={typeof value === 'string' ? value : undefined}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Layout par défaut de la page nœud : rangée de 4 KPIs (w3 h2), rangée
 * « Détails hôte » + « Capacité et utilisation » (w6 h4 chacun, côte à côte),
 * table VMs pleine largeur (w12 h4), puis les graphiques empilés pleine largeur
 * (ordre du catalogue). Les widgets dynamiques (netif-*) sont inclus — le layout n'est
 * calculé qu'une fois `ready` (premier chargement node-net terminé).
 */
export function nodeDefaultLayout(catalog: CoreWidgetDef[]): WidgetItem[] {
  const TOP_IDS = new Set(['kpi-cpu', 'kpi-ram', 'kpi-rootfs', 'kpi-load', 'host-details', 'capacity', 'vms']);
  const items: WidgetItem[] = [
    { widgetId: 'kpi-cpu', x: 0, y: 0, w: 3, h: 2 },
    { widgetId: 'kpi-ram', x: 3, y: 0, w: 3, h: 2 },
    { widgetId: 'kpi-rootfs', x: 6, y: 0, w: 3, h: 2 },
    { widgetId: 'kpi-load', x: 9, y: 0, w: 3, h: 2 },
    { widgetId: 'host-details', x: 0, y: 2, w: 6, h: 4 },
    { widgetId: 'capacity', x: 6, y: 2, w: 6, h: 4 },
    { widgetId: 'vms', x: 0, y: 6, w: 12, h: 4 },
  ];
  let y = 10;
  for (const def of catalog) {
    if (TOP_IDS.has(def.id)) continue;
    items.push({ widgetId: def.id, x: 0, y, w: 12, h: def.default.h });
    y += def.default.h;
  }
  return items;
}
