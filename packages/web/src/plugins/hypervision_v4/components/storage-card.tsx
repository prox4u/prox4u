import { useTranslation } from 'react-i18next';
import type { StorageInfo } from '@prox4u/shared';
import { usageSeverity } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Progress } from '../../../components/ui/progress';
import { formatBytes } from '../../../lib/utils';
import { useOvercommitConfig } from '../../../core/data/use-endpoint';

/** CORPS de la carte stockage — liste des datastores (le compteur est porté par le
 *  slot `extra` du widget dans la grille v4). */
export function StorageCardBody({ storages }: { storages: StorageInfo[] }) {
  const config = useOvercommitConfig();
  const sorted = [...storages].sort((a, b) => b.pct - a.pct);

  return (
    <div className="h-full space-y-3 overflow-y-auto">
      {sorted.map((s) => (
        <div key={s.storage}>
          <div className="mb-1 flex items-center justify-between gap-2 text-xs">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-medium">{s.storage}</span>
              <span className="shrink-0 rounded bg-secondary px-1 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
                {s.type}
              </span>
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatBytes(s.usedBytes)} / {formatBytes(s.totalBytes)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Progress value={s.pct} tone={usageSeverity(s.pct, config)} className="flex-1" />
            <span className="w-12 shrink-0 whitespace-nowrap text-right text-xs font-semibold tabular-nums">{s.pct.toFixed(1)} %</span>
          </div>
        </div>
      ))}
      {sorted.length === 0 && <p className="text-xs text-muted-foreground">—</p>}
    </div>
  );
}

export function StorageCard({ storages }: { storages: StorageInfo[] }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader draggable className="flex-row items-center justify-between">
        <CardTitle>{t('storageCard.title')}</CardTitle>
        <span className="text-xs text-muted-foreground">{storages.length}</span>
      </CardHeader>
      <CardContent>
        <StorageCardBody storages={storages} />
      </CardContent>
    </Card>
  );
}
