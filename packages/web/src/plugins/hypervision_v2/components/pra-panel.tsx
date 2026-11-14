import { useTranslation } from 'react-i18next';
import type { PraReport } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Progress } from '../../../components/ui/progress';
import { formatBytes } from '../../../lib/utils';

const SEV_TONE = { ok: 'ok', warn: 'warn', crit: 'crit', na: 'default' } as const;

export function PraPanel({ pra }: { pra: PraReport }) {
  const { t } = useTranslation();
  const singleSite = pra.globalSeverity === 'na';

  return (
    <Card>
      <CardHeader draggable className="flex-row items-center justify-between">
        <CardTitle>{t('pra.title')}</CardTitle>
        {!singleSite && (
          <Badge tone={SEV_TONE[pra.globalSeverity]}>
            {pra.globalSeverity === 'ok' ? t('pra.ok') : t('pra.alert')}
          </Badge>
        )}
      </CardHeader>
      <CardContent>
        {singleSite ? (
          <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">{t('pra.na')}</p>
        ) : (
          <div className="space-y-4">
            {pra.sites.map((s) => (
              <div key={s.siteId} className="rounded-lg border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{s.siteName}</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground">{t('pra.pctLabel')}</span>
                    <Badge tone={SEV_TONE[s.severity]}>
                      {s.absorptionPct === null
                        ? '—'
                        : s.absorptionPct >= 999
                          ? t('pra.impossible')
                          : `${Math.round(s.absorptionPct)} %`}
                    </Badge>
                  </div>
                </div>
                <Progress
                  value={s.absorptionPct ?? 0}
                  tone={s.severity === 'ok' ? 'ok' : s.severity === 'warn' ? 'warn' : 'crit'}
                  className="mb-2"
                />
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <span>
                    {t('pra.demand')} : {t('pra.cores', { n: s.demandCpu })} ·{' '}
                    {formatBytes(s.demandRamBytes)}
                  </span>
                  <span className="text-right">
                    {t('pra.capacity')} : {t('pra.cores', { n: s.capacityElsewhereCpu })} ·{' '}
                    {formatBytes(s.capacityElsewhereRamBytes)}
                  </span>
                </div>
              </div>
            ))}
            {pra.affectedVms.length > 0 && (
              <div className="text-xs">
                <div className="mb-1 font-medium text-muted-foreground">{t('pra.affectedVms')}</div>
                <ul className="space-y-0.5">
                  {pra.affectedVms.slice(0, 5).map((v) => (
                    <li key={v.vmid} className="flex justify-between">
                      <span>{v.name}</span>
                      <span className="text-muted-foreground">
                        {v.node} · {v.cpu} cœurs · {formatBytes(v.memBytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
