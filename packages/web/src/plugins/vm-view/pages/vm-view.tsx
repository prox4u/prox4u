import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { VmSortDir, VmSortKey, VmSummary } from '@prox4u/shared';
import { buildVmTree } from '@prox4u/shared';
import { useMulti } from '../../../core/data/use-endpoint';
import { VmTree } from '../components/vm-tree';
import { VmTable, type VmRow } from '../components/vm-table';
import { VmDetail } from '../components/vm-detail';
import { VersionBadge } from '../../../components/ui/version-badge';

/**
 * Inventaire des VMs — vue type vCenter : arborescence Datacenter → cluster → nœud à gauche,
 * tableau filtrable au centre, panneau détail (onglets) à droite au clic sur une ligne.
 * Les données sont live (snapshot WS 5 s) ; seul le détail d'une VM passe par le REST.
 */
export function VmViewPage() {
  const { t } = useTranslation();
  const multi = useMulti();
  const endpoints = useMemo(() => multi?.endpoints ?? [], [multi]);

  // Sélection tree / recherche / filtres / VM détaillée : synchronisés dans l'URL (deep-link).
  const [searchParams, setSearchParams] = useSearchParams();
  const treeSel = searchParams.get('tree') ?? 'dc';
  const query = searchParams.get('q') ?? '';
  const statusSel = searchParams.get('status') ?? '';
  const typeSel = searchParams.get('type') ?? '';
  const vmSel = searchParams.get('vm');

  const setParam = (key: string, value: string | null) =>
    setSearchParams(
      (p) => {
        if (value == null || value === '' || (key === 'tree' && value === 'dc')) p.delete(key);
        else p.set(key, value);
        return p;
      },
      { replace: true },
    );

  const [sort, setSort] = useState<{ key: VmSortKey; dir: VmSortDir }>({ key: 'name', dir: 'asc' });

  const vmsByEndpoint = useMemo(() => {
    const m: Record<string, VmSummary[]> = {};
    for (const ep of endpoints) m[ep.id] = ep.snapshot?.vms ?? [];
    return m;
  }, [endpoints]);

  const tree = useMemo(
    () => buildVmTree(t('vm.tree.datacenter'), endpoints.map((e) => ({ id: e.id, name: e.name })), vmsByEndpoint),
    [endpoints, vmsByEndpoint, t],
  );

  // Périmètre du tableau selon la sélection dans l'arborescence.
  const scopedRows = useMemo<VmRow[]>(() => {
    const out: VmRow[] = [];
    for (const ep of endpoints) {
      let vms = ep.snapshot?.vms ?? [];
      if (treeSel !== 'dc') {
        if (treeSel.startsWith(`${ep.id}/`)) {
          const node = treeSel.slice(ep.id.length + 1);
          vms = vms.filter((v) => v.node === node);
        } else if (treeSel !== ep.id) {
          continue;
        }
      }
      for (const vm of vms) out.push({ vm, endpointId: ep.id });
    }
    return out;
  }, [endpoints, treeSel]);

  // VM détaillée : recherche globale (indépendante des filtres du tableau).
  const selectedRow = useMemo<VmRow | null>(() => {
    if (!vmSel) return null;
    const vmid = Number(vmSel);
    for (const ep of endpoints) {
      const v = (ep.snapshot?.vms ?? []).find((x) => x.vmid === vmid);
      if (v) return { vm: v, endpointId: ep.id };
    }
    return null;
  }, [endpoints, vmSel]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          {t('vm.title')}
          {/* Badge de version : permet de distinguer les versions en comparaison A/B. */}
          <VersionBadge pluginId="vm-view" />
        </h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t('vm.hint')}</p>
      </div>

      {!multi ? (
        <div className="flex h-[400px] items-center justify-center rounded-xl border text-sm text-muted-foreground">
          {t('vm.loading')}
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <aside className="w-60 shrink-0 rounded-xl border bg-card p-2">
            <VmTree tree={tree} selectedId={treeSel} onSelect={(id) => setParam('tree', id)} />
          </aside>

          <div className="min-w-0 flex-1">
            <VmTable
              rows={scopedRows}
              query={query}
              onQueryChange={(q) => setParam('q', q)}
              statusSel={statusSel}
              onStatusChange={(s) => setParam('status', s)}
              typeSel={typeSel}
              onTypeChange={(ty) => setParam('type', ty)}
              sortKey={sort.key}
              sortDir={sort.dir}
              onSortChange={(key, dir) => setSort({ key, dir })}
              selectedVmid={selectedRow?.vm.vmid ?? null}
              onSelectVm={(row) => setParam('vm', String(row.vm.vmid))}
            />
          </div>

          {selectedRow && (
            <aside className="h-[480px] w-[360px] shrink-0">
              <VmDetail
                endpointId={selectedRow.endpointId}
                vmid={selectedRow.vm.vmid}
                onClose={() => setParam('vm', null)}
              />
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
