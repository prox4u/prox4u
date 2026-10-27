import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { fetchStorageInventory } from '../../../core/api/apiClient';
import type { StorageInventoryResponse } from '../../../core/api/types';
import { StorageInventory } from '../components/storage-inventory';
import { useMulti } from '../../../core/data/use-endpoint';
import { cn } from '../../../lib/utils';

export function StoragePage() {
  const { t } = useTranslation();
  const multi = useMulti();
  const [data, setData] = useState<StorageInventoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Vue + recherche + type : synchronisées dans l'URL (deep-link partageable).
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view') ?? 'all';
  const query = searchParams.get('q') ?? '';
  const typeSel = searchParams.get('type') ?? '';
  const setView = (v: string) => {
    setSearchParams((p) => {
      if (v === 'all') p.delete('view');
      else p.set('view', v);
      p.delete('type'); // la sélection de type est propre à la vue
      return p;
    }, { replace: true });
  };
  const setQuery = (q: string) =>
    setSearchParams((p) => {
      if (q) p.set('q', q);
      else p.delete('q');
      return p;
    }, { replace: true });
  const setType = (ty: string) =>
    setSearchParams((p) => {
      if (ty) p.set('type', ty);
      else p.delete('type');
      return p;
    }, { replace: true });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchStorageInventory());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const endpoints = data?.endpoints ?? [];
  const endpointNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of multi?.endpoints ?? []) m[e.id] = e.name;
    return m;
  }, [multi]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{t('storage.title')}</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t('storage.hint')}</p>
      </div>

      {loading && !data ? (
        <div className="flex h-[400px] items-center justify-center rounded-xl border text-sm text-muted-foreground">
          {t('storage.loading')}
        </div>
      ) : error && !data ? (
        <div className="flex h-[400px] items-center justify-center rounded-xl border border-crit/40 bg-crit/10 px-4 text-sm text-crit">
          {t('storage.error', { error })}
        </div>
      ) : (
        <div className="flex items-stretch gap-2">
          <div className="min-w-0 flex-1">
            <StorageInventory
              endpoints={endpoints}
              endpointNames={endpointNames}
              view={view}
              onViewChange={setView}
              query={query}
              onQueryChange={setQuery}
              typeSel={typeSel}
              onTypeChange={setType}
            />
          </div>
          <button
            onClick={() => void load()}
            className="flex shrink-0 items-center gap-1.5 self-start rounded-md border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
            {t('storage.refresh')}
          </button>
        </div>
      )}
    </div>
  );
}
