import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Boxes, ChevronDown, ChevronRight, HardDrive, Layers } from 'lucide-react';
import {
  usageSeverity,
  type MultiDashboardSnapshot,
  type Severity,
  type SeverityOrNa,
  type StorageInventoryEndpoint,
  type StorageVolume,
} from '@prox4u/shared';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';
import { Badge } from '../../../components/ui/badge';
import { cn, formatBytes } from '../../../lib/utils';

/**
 * Panneau « Volumes physiques » — la cartographie du stockage, en **arbre iSCSI → LVM**.
 *
 * Lit les volumes directement du snapshot WS (`storageVolumes`, calculés par le poller avec la
 * config de taille LUN) — source unique, zéro recalcul client. Un LUN iSCSI est le parent ; ses
 * VG LVM enfants sont listés indentés (un LUN peut porter plusieurs VG — vrai matériel). La
 * capacité d'un LUN sans taille connue est une **borne basse** (Σ VG) — le panneau le signale
 * (« le LUN peut être plus grand »). La comptée VM par volume est enrichie depuis l'inventaire.
 */

interface Props {
  /** inventaire (pour compter les VMs par volume). */
  endpoints: StorageInventoryEndpoint[];
  /** snapshot multi-endpoints WS (porte `storageVolumes` par endpoint). */
  multi: MultiDashboardSnapshot | null;
  /** vue courante : 'all' (agrégée) ou un id d'endpoint. */
  view: string;
  endpointNames: Record<string, string>;
}

const toneBadge: Record<SeverityOrNa, 'default' | 'ok' | 'warn' | 'crit'> = { ok: 'ok', warn: 'warn', crit: 'crit', na: 'default' };
const barColor: Record<Severity, string> = { ok: 'bg-ok', warn: 'bg-warn', crit: 'bg-crit' };

interface VolumeWithMeta extends StorageVolume {
  endpointId: string;
  endpointName: string;
  /** VMs distinctes hébergées sur le volume (LUN : union de tous ses VG enfants). */
  vmCount: number;
  children: VolumeWithMeta[];
}

export function StorageVolumes({ endpoints, multi, view, endpointNames }: Props) {
  const { t } = useTranslation();
  const isAll = view === 'all';
  // Repli des LUN parents (clé = endpointId/storage) — déplié par défaut, repliable à la main.
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());
  const toggleCollapse = (key: string) =>
    setCollapsedKeys((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const volumes = useMemo<VolumeWithMeta[]>(() => {
    const eps = multi?.endpoints ?? [];
    const scoped = isAll ? eps : eps.filter((e) => e.id === view);
    const out: VolumeWithMeta[] = [];
    for (const ep of scoped) {
      const name = endpointNames[ep.id] ?? ep.id;
      const inv = endpoints.find((x) => x.endpointId === ep.id);
      const vmidsOn = (storage: string) => new Set((inv?.vms ?? []).filter((vm) => vm.storage === storage).map((vm) => vm.vmid));
      const toMeta = (v: StorageVolume): VolumeWithMeta => {
        // LUN parent : les disques sont sur ses VG enfants → union de leurs VMs.
        const vmids =
          v.children.length > 0
            ? new Set<number>(v.children.flatMap((c) => [...vmidsOn(c.storage)]))
            : vmidsOn(v.storage);
        return { ...v, endpointId: ep.id, endpointName: name, vmCount: vmids.size, children: v.children.map(toMeta) };
      };
      for (const v of ep.snapshot?.storageVolumes ?? []) out.push(toMeta(v));
    }
    // Les plus alloués d'abord (cohérent avec buildStorageVolumes), départage endpoint/nom.
    return out.sort(
      (a, b) => b.allocatedBytes - a.allocatedBytes || a.endpointName.localeCompare(b.endpointName) || a.storage.localeCompare(b.storage),
    );
  }, [endpoints, multi, view, endpointNames, isAll]);

  if (volumes.length === 0) return null;

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b p-3">
        <Boxes className="h-4 w-4 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-semibold leading-tight">{t('storage.volumes.title')}</h2>
          <p className="text-[11px] leading-snug text-muted-foreground">{t('storage.volumes.hint')}</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
        {volumes.map((v) => (
          <VolumeTree
            key={`${v.endpointId}/${v.storage}`}
            v={v}
            showEndpoint={isAll}
            collapsed={collapsedKeys.has(`${v.endpointId}/${v.storage}`)}
            onToggle={() => toggleCollapse(`${v.endpointId}/${v.storage}`)}
          />
        ))}
      </div>
    </div>
  );
}

/** Un volume et ses VG enfants (arbre) : carte parent repliable + enfants indentés (connecteur └). */
function VolumeTree({ v, showEndpoint, collapsed, onToggle }: { v: VolumeWithMeta; showEndpoint: boolean; collapsed: boolean; onToggle: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <VolumeCard v={v} showEndpoint={showEndpoint} collapsed={collapsed} onToggle={onToggle} />
      {v.children.length > 0 && !collapsed && (
        <div className="ml-[15px] flex flex-col gap-2 border-l border-dashed pl-3">
          {v.children.map((c) => (
            <VolumeCard key={c.storage} v={c} showEndpoint={false} child parent={v.storage} />
          ))}
        </div>
      )}
    </div>
  );
}

function VolumeCard({
  v,
  showEndpoint,
  child,
  parent,
  collapsed,
  onToggle,
}: {
  v: VolumeWithMeta;
  showEndpoint: boolean;
  /** true = VG enfant du LUN. */
  child?: boolean;
  /** nom du LUN parent (pour le VG enfant : « · sous {parent} »). */
  parent?: string;
  /** LUN parent : replié ? */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const { t } = useTranslation();
  const config = useOvercommitConfig();
  const total = v.totalBytes ?? 0;
  const used = v.usedBytes ?? 0;
  const usedPct = total > 0 ? (used / total) * 100 : 0;
  const barSev: Severity = total > 0 ? usageSeverity(usedPct, config) : 'ok';
  const isLunLowerBound = v.totalSource === 'vg-sum';
  const isParent = v.children.length > 0;

  return (
    <div className={cn('flex flex-col gap-2.5 rounded-lg border bg-background/40 p-3', child && 'bg-muted/20')}>
      {/* En-tête : volume + nature + endpoint (+ chevron de repli sur le LUN parent) */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {isParent ? (
            <button
              type="button"
              onClick={onToggle}
              aria-label={collapsed ? t('storage.volumes.expand') : t('storage.volumes.collapse')}
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          ) : child ? (
            <HardDrive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          {child && <span aria-hidden className="text-xs text-muted-foreground">└</span>}
          <span className="truncate text-sm font-semibold" title={v.storage}>{v.storage}</span>
          {child && parent && <span className="shrink-0 text-[10px] text-muted-foreground">· {t('storage.childOf', { parent })}</span>}
          <Badge tone={v.thinCapable ? 'primary' : 'default'}>{v.thinCapable ? t('storage.volumes.thin') : t('storage.volumes.thick')}</Badge>
        </div>
        {showEndpoint && <span className="shrink-0 text-[11px] text-muted-foreground">{v.endpointName}</span>}
      </div>

      {/* Capacité : utilisé / total. LUN sans taille connue → borne basse, à signaler. */}
      <div>
        <div className="mb-1 flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">
            {child ? t('storage.volumes.vgCapacity') : isLunLowerBound ? t('storage.volumes.capacityLower') : t('storage.volumes.capacity')}
          </span>
          <span className="tabular-nums">
            {total > 0 ? (
              <>
                <span className="font-medium">{formatBytes(used)}</span>
                <span className="text-muted-foreground"> / {formatBytes(total)}</span>
              </>
            ) : (
              <span className="text-muted-foreground">{t('storage.na')}</span>
            )}
          </span>
        </div>
        {total > 0 && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
            <div className={cn('h-full rounded-full transition-all', barColor[barSev])} style={{ width: `${Math.min(100, usedPct)}%` }} />
          </div>
        )}
        {/* LUN dont la taille est inconnue : la capacité affichée est une borne basse. */}
        {isLunLowerBound && (
          <p className="mt-1 text-[10px] leading-snug text-muted-foreground" title={t('storage.volumes.lunNoteHelp')}>
            {t('storage.volumes.lunNote')}
          </p>
        )}
      </div>

      {/* Disques VM alloués + ratio (sur-allocation thin / usage thick / engagé LUN) */}
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">
          {child ? t('storage.volumes.allocated') : v.hasDisks ? t('storage.volumes.allocated') : t('storage.volumes.committed')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="tabular-nums font-medium">{formatBytes(child ? v.allocatedBytes : used)}</span>
          {v.kind === 'na' ? (
            <Badge tone="default">{t('storage.volumes.na')}</Badge>
          ) : v.kind === 'overcommit' ? (
            <Badge tone={toneBadge[v.tone]}>
              {t('storage.volumes.overcommit')} ×{(v.ratio ?? 0).toFixed(2)}
            </Badge>
          ) : (
            <Badge tone={toneBadge[v.tone]}>
              {t('storage.volumes.usage')} {Math.round((v.ratio ?? 0) * 100)} %
            </Badge>
          )}
        </span>
      </div>

      {/* Pied : VMs (LUN : union de ses VG). */}
      <div className="flex items-center justify-between border-t pt-2 text-[11px] text-muted-foreground">
        <span className="tabular-nums">{t('storage.volumes.vms', { count: v.vmCount })}</span>
        {v.children.length > 0 && (
          <span title={t('storage.volumes.vgChildrenHelp')}>
            {t('storage.volumes.vgChildren', { count: v.children.length, names: v.children.map((c) => c.storage).join(', ') })}
          </span>
        )}
      </div>
    </div>
  );
}
