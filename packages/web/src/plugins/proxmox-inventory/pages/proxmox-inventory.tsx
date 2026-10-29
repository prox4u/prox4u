import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { InvFilter, InvSortDir, InvSortKey, InvVm, ProxmoxInventoryResponse } from '@prox4u/shared';
import { DEFAULT_INV_FILTER, filterInvRows, invSummary, invToFormat, sortInvRows } from '@prox4u/shared';
import { fetchProxmoxInventory } from '../../../core/api/apiClient';
import { Button } from '../../../components/ui/button';
import { Card, CardContent } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Skeleton } from '../../../components/ui/skeleton';
import { VersionBadge } from '../../../components/ui/version-badge';
import { Download, RefreshCw, Search } from 'lucide-react';
import { ProxmoxInventoryTable } from '../components/proxmox-inventory-table';

type ExportFmt = 'txt' | 'csv' | 'json';

/** Déclenche le téléchargement d'une chaîne au format donné. */
function download(content: string, fmt: ExportFmt) {
  const mime = fmt === 'json' ? 'application/json' : fmt === 'csv' ? 'text/csv' : 'text/plain';
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `proxmox-inventory.${fmt}`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Inventaire Proxmox consolidé — une machine par ligne (QEMU + LXC), multi-endpoints.
 * Données servies par GET /api/proxmox-inventory (cache serveur 5 min). Recherche
 * globale + filtres par colonne + tri ; export TXT/CSV/JSON de la VUE FILTRÉE.
 */
export function ProxmoxInventoryPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<ProxmoxInventoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<InvFilter>(DEFAULT_INV_FILTER);
  const [sort, setSort] = useState<{ key: InvSortKey; dir: InvSortDir }>({ key: 'vmid', dir: 'asc' });
  const [fmt, setFmt] = useState<ExportFmt>('csv');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchProxmoxInventory());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Toutes les VMs, tous endpoints confondus (une ligne par machine).
  const allVms = useMemo<InvVm[]>(
    () => (data?.endpoints ?? []).flatMap((ep) => ep.vms),
    [data],
  );

  // Vue filtrée + triée (fonctions pures shared — exportées telles quelles).
  const filterWithSearch = useMemo<InvFilter>(
    () => ({ ...filter, search }),
    [filter, search],
  );
  const rows = useMemo<InvVm[]>(
    () => sortInvRows(filterInvRows(allVms, filterWithSearch), sort.key, sort.dir),
    [allVms, filterWithSearch, sort],
  );

  const summary = useMemo(() => invSummary(allVms), [allVms]);
  const shown = rows.length;

  const cards: Array<[string, string]> = [
    [t('pxinv.summary.total'), String(summary.total)],
    [t('pxinv.summary.shown'), String(shown)],
    [t('pxinv.summary.running'), String(summary.running)],
    [t('pxinv.summary.stopped'), String(summary.stopped)],
    [t('pxinv.summary.ramAlloc'), (summary.ramAllocMb / 1024).toFixed(1)],
    [t('pxinv.summary.ramUsed'), (summary.ramUsedMb / 1024).toFixed(1)],
    [t('pxinv.summary.cores'), String(Math.round(summary.cpuCores))],
    [t('pxinv.summary.cpuAvg'), summary.cpuPctAvg.toFixed(1)],
    [t('pxinv.summary.agentOk'), `${summary.agentOk}/${summary.total}`],
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            {t('pxinv.title')}
            <VersionBadge pluginId="proxmox-inventory" />
          </h1>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t('pxinv.hint')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="md" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {t('pxinv.refresh')}
          </Button>
          <select
            value={fmt}
            onChange={(e) => setFmt(e.target.value as ExportFmt)}
            className="h-8 rounded-lg border bg-background px-2 text-xs"
            aria-label={t('pxinv.export')}
          >
            <option value="csv">{t('pxinv.export.csv')}</option>
            <option value="txt">{t('pxinv.export.txt')}</option>
            <option value="json">{t('pxinv.export.json')}</option>
          </select>
          <Button
            variant="default"
            size="md"
            onClick={() => download(invToFormat(fmt, rows), fmt)}
            disabled={rows.length === 0}
          >
            <Download className="h-3.5 w-3.5" />
            {t('pxinv.export')}
          </Button>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('pxinv.search')}
          className="pl-9"
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
        {cards.map(([label, value]) => (
          <Card key={label}>
            <CardContent className="pt-4">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {error && (
        <div className="rounded-xl border border-crit/40 bg-crit/10 p-3 text-sm text-crit">
          {t('pxinv.error', { msg: error })}
        </div>
      )}

      {loading && !data ? (
        <div className="space-y-2 rounded-xl border p-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <div className="pt-2 text-xs text-muted-foreground">{t('pxinv.loading')}</div>
        </div>
      ) : (
        <div className="rounded-xl border bg-card">
          <ProxmoxInventoryTable
            vms={rows}
            filter={filter}
            onFilterChange={setFilter}
            sortKey={sort.key}
            sortDir={sort.dir}
            onSortChange={(key, dir) => setSort({ key, dir })}
          />
        </div>
      )}

      {data && (
        <p className="text-xs text-muted-foreground">
          {t('pxinv.generated', { at: new Date(data.generatedAt).toLocaleString() })}
          {' · '}
          {t('pxinv.shown', { shown, total: allVms.length })}
        </p>
      )}
    </div>
  );
}
