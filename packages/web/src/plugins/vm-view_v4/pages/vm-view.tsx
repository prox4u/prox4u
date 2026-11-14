import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { VmSortDir, VmSortKey, VmSummary } from '@prox4u/shared';
import { buildVmTree } from '@prox4u/shared';
import { useMulti } from '../../../core/data/use-endpoint';
import { VmTree } from '../components/vm-tree';
import { VmTable, type VmRow } from '../components/vm-table';
import { VmDetail } from '../components/vm-detail';
import { NodeDetail } from '../components/node-detail';
import { VersionBadge } from '../../../components/ui/version-badge';

/** Id d'une feuille VM dans l'arborescence : `<endpointId>/<node>/<vmid>`. */
const VM_LEAF_RE = /^([^/]+)\/([^/]+)\/(\d+)$/;

/**
 * Inventaire des VMs — approche vCenter (v2) : arborescence Datacenter → cluster → nœud → VM
 * à gauche ; au clic sur un nœud, sa page détail plein écran (onglets Résumé / Monitor / VMs)
 * remplace le tableau ; au clic sur une VM (feuille de l'arbre ou ligne du tableau), la page
 * détail plein écran (onglets Résumé / Configuration / Réseau / Snapshots) prend la place du
 * tableau. Les données sont live (snapshot WS 5 s) ; seul le détail d'une VM passe par le REST.
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
  const nodeSel = searchParams.get('node');

  const setParam = (key: string, value: string | null) =>
    setSearchParams(
      (p) => {
        if (value == null || value === '' || (key === 'tree' && value === 'dc')) p.delete(key);
        else p.set(key, value);
        return p;
      },
      { replace: true },
    );

  // Clic dans l'arborescence : une feuille VM ouvre le détail de la VM (et rescope le
  // tableau sur son nœud) ; un nœud ouvre sa page détail ; un endpoint / datacenter
  // revient au tableau et ferme les détails.
  const handleTreeSelect = (id: string) => {
    const m = id.match(VM_LEAF_RE);
    setSearchParams(
      (p) => {
        if (m) {
          p.set('tree', `${m[1]}/${m[2]}`);
          p.set('vm', m[3]);
          // on garde le détail nœud si la VM vient de ce nœud, sinon on le ferme
          if (p.get('node') !== `${m[1]}/${m[2]}`) p.delete('node');
        } else {
          if (id === 'dc') p.delete('tree');
          else p.set('tree', id);
          p.delete('vm');
          // un nœud (endpoint/nom) ouvre son détail ; un endpoint / DC le ferme
          if (id !== 'dc' && id.split('/').length === 2) p.set('node', id);
          else p.delete('node');
        }
        return p;
      },
      { replace: true },
    );
  };

  const [sort, setSort] = useState<{ key: VmSortKey; dir: VmSortDir }>({ key: 'name', dir: 'asc' });

  const vmsByEndpoint = useMemo(() => {
    const m: Record<string, VmSummary[]> = {};
    for (const ep of endpoints) m[ep.id] = ep.snapshot?.vms ?? [];
    return m;
  }, [endpoints]);

  // v2 : les VMs sont des feuilles cliquables de l'arborescence (approche vCenter).
  const tree = useMemo(
    () =>
      buildVmTree(t('vm.tree.datacenter'), endpoints.map((e) => ({ id: e.id, name: e.name })), vmsByEndpoint, {
        includeVms: true,
      }),
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

  // Infos de l'endpoint de la VM détaillée (URL API PVE pour la console, nom, horodatage live).
  const selectedEndpoint = useMemo(
    () => (selectedRow ? endpoints.find((e) => e.id === selectedRow.endpointId) : undefined),
    [endpoints, selectedRow],
  );

  // Nœud détaillé : recherche dans le snapshot (indépendante des filtres du tableau).
  const selectedNode = useMemo(() => {
    if (!nodeSel) return null;
    const sep = nodeSel.indexOf('/');
    if (sep < 0) return null;
    const epId = nodeSel.slice(0, sep);
    const nodeName = nodeSel.slice(sep + 1);
    const ep = endpoints.find((e) => e.id === epId);
    const node = ep?.snapshot?.nodes.find((n) => n.node === nodeName);
    if (!ep || !node) return null;
    return { ep, node, vms: (ep.snapshot?.vms ?? []).filter((v) => v.node === nodeName) };
  }, [endpoints, nodeSel]);

  // Surlignage de l'arborescence : la feuille VM si une VM est détaillée, sinon le nœud.
  const treeSelectedId = selectedRow
    ? `${selectedRow.endpointId}/${selectedRow.vm.node}/${selectedRow.vm.vmid}`
    : treeSel;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          {t('vm.title')}
          {/* Badge de version : permet de distinguer les versions en comparaison A/B. */}
          <VersionBadge pluginId="vm-view_v4" />
        </h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t('vm.hint')}</p>
      </div>

      {!multi ? (
        <div className="flex h-[400px] items-center justify-center rounded-xl border text-sm text-muted-foreground">
          {t('vm.loading')}
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <aside className="w-64 shrink-0 rounded-xl border bg-card p-2">
            <VmTree tree={tree} selectedId={treeSelectedId} onSelect={handleTreeSelect} />
          </aside>

          {selectedRow ? (
            // Approche vCenter : le détail de la VM remplace le tableau (plein écran).
            <div className="min-w-0 flex-1">
              <VmDetail
                endpointId={selectedRow.endpointId}
                endpointName={selectedEndpoint?.name ?? selectedRow.endpointId}
                vmid={selectedRow.vm.vmid}
                endpointUrl={selectedEndpoint?.url}
                lastUpdated={selectedEndpoint?.snapshot?.generatedAt}
                onClose={() => setParam('vm', null)}
              />
            </div>
          ) : selectedNode ? (
            // Approche vCenter : le détail du nœud remplace le tableau (plein écran).
            <div className="min-w-0 flex-1">
              <NodeDetail
                endpointId={selectedNode.ep.id}
                endpointName={selectedNode.ep.name}
                node={selectedNode.node}
                vms={selectedNode.vms}
                onClose={() => setParam('node', null)}
                onOpenVm={(vmid) =>
                  setSearchParams((p) => {
                    p.set('vm', String(vmid));
                    return p;
                  }, { replace: true })
                }
              />
            </div>
          ) : (
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
                selectedVmid={null}
                onSelectVm={(row) => setParam('vm', String(row.vm.vmid))}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
