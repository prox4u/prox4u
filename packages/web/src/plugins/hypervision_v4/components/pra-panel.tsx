import { useTranslation } from 'react-i18next';
import type { PraReport } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Progress } from '../../../components/ui/progress';
import { formatBytes } from '../../../lib/utils';

const SEV_TONE = { ok: 'ok', warn: 'warn', crit: 'crit', na: 'default' } as const;

/**
 * CORPS du panneau PRA — liste des sites (mapping nœud→bâtiment visible) +
 * VMs affectées + avertissement nœuds orphelins. Le badge de sévérité globale
 * est porté par le slot `extra` du widget dans la grille v4.
 *
 * Sert au PRA par endpoint (siteId non préfixé) ET au PRA global cross-endpoints
 * (siteId préfixé `endpoint/siteId` → l'origine endpoint est affichée).
 */
export function PraPanelBody({ pra }: { pra: PraReport }) {
  const { t } = useTranslation();
  const singleSite = pra.globalSeverity === 'na';
  const unmapped = pra.unmappedNodes ?? [];

  return (
    <div className="h-full overflow-y-auto">
      {singleSite ? (
          <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">{t('pra.na')}</p>
        ) : (
          <div className="space-y-4">
            {pra.sites.map((s) => {
              // PRA global : siteId préfixé `endpoint/siteId` → origine endpoint.
              const endpoint = s.siteId.includes('/') ? s.siteId.split('/')[0] : null;
              return (
                <div key={s.siteId} className="rounded-lg border p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-sm font-semibold">
                      {s.siteName}
                      {endpoint && (
                        <span className="rounded bg-secondary px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {endpoint}
                        </span>
                      )}
                    </span>
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
                  {/* Mapping nœud→bâtiment (sites.json) — visible. */}
                  {s.nodes.length > 0 && (
                    <div className="mb-2 text-[11px] text-muted-foreground">
                      {t('pra.nodes')} : {s.nodes.join(', ')}
                    </div>
                  )}
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
              );
            })}
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
            {unmapped.length > 0 && (
              <div className="rounded-lg border border-warn/30 bg-warn/10 p-2.5 text-xs text-warn">
                {t('pra.unmapped', { nodes: unmapped.join(', ') })}
              </div>
            )}
          </div>
      )}
    </div>
  );
}

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
        <PraPanelBody pra={pra} />
      </CardContent>
    </Card>
  );
}
