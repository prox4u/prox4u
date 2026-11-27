import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { AlarmRule, CentreonPoller, MetricId } from '@prox4u/shared';
import { Card, CardContent } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { alarmsApi, buildNodeTarget, type AlarmTargets, type ProvisionOutcome } from '../lib/nsca-api';
import type { MetricIdList } from '../lib/types';
import { RuleForm, type RuleFormValues } from '../components/rule-form';

/**
 * Page 1 — Créer une surveillance. À la soumission : création de la règle +
 * provisioning du service Centreon (CLAPI ou REST v1) + déploiement de config.
 * Récapitulatif affiché : succès/échec du provisionnement + message. La règle
 * est enregistrée même en échec de provisioning (statut « erreur »).
 */
export function CreateRulePage() {
  const { t } = useTranslation();
  const [targets, setTargets] = useState<AlarmTargets | null>(null);
  const [pollers, setPollers] = useState<CentreonPoller[]>([]);
  const [metrics, setMetrics] = useState<{ vm: MetricIdList; node: MetricIdList; cluster: MetricIdList }>({ vm: [], node: [], cluster: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ rule: AlarmRule; provision: ProvisionOutcome } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, tgt] = await Promise.all([alarmsApi.list(), alarmsApi.targets()]);
      setPollers(list.pollers);
      setMetrics({ vm: list.metrics.vm, node: list.metrics.node, cluster: list.metrics.cluster ?? [] });
      setTargets(tgt);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const mappingHost = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of targets?.mappings ?? []) map.set(m.key, m.host);
    return (endpointId: string, vmid: number) => map.get(`${endpointId}/${vmid}`);
  }, [targets]);

  async function onSubmit(values: RuleFormValues) {
    const threshold = Number(values.threshold);
    const confirmSeconds = Math.round(Number(values.confirmMinutes) * 60);
    const recoveryThreshold = values.recoveryThreshold.trim() === '' ? null : Number(values.recoveryThreshold);
    const suppressSeconds = Math.round(Number(values.suppressMinutes) * 60);
    if (!values.name.trim()) throw new Error('name');
    if (Number.isNaN(threshold)) throw new Error('threshold');
    if (recoveryThreshold !== null && Number.isNaN(recoveryThreshold)) throw new Error('recoveryThreshold');
    if (Number.isNaN(suppressSeconds) || suppressSeconds < 0) throw new Error('suppressSeconds');
    const payload = {
      name: values.name.trim(),
      target: values.kind === 'vm'
        ? { kind: 'vm' as const, endpointId: values.endpointId, vmid: values.vmid ?? undefined, label: targets?.vms.find((v) => v.vmid === values.vmid)?.name ?? '' }
        : values.kind === 'node'
          ? buildNodeTarget(values)
          : { kind: 'cluster' as const, endpointId: values.endpointId, label: targets?.clusters.find((c) => c.endpointId === values.endpointId)?.name ?? values.endpointId },
      metric: values.metric as MetricId,
      operator: values.operator,
      threshold,
      recoveryThreshold,
      confirmSeconds,
      suppressSeconds,
      severity: values.severity,
      pollerId: values.pollerId,
      centreonHost: values.centreonHost.trim(),
      centreonService: values.centreonService.trim(),
      messageTemplate: values.messageTemplate,
      active: values.active,
    };
    const res = await alarmsApi.create(payload);
    setResult(res);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (result) {
    const { rule, provision } = result;
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold tracking-tight">{t('alarm.summary.title')}</h1>
        {provision.ok ? (
          <Card className="border-ok/40">
            <CardContent className="flex items-start gap-3 pt-4">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-ok" />
              <div>
                <div className="text-sm font-medium">{t('alarm.summary.ok', { poller: rule.pollerId })}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {rule.centreonHost} / {rule.centreonService} — {provision.message}
                </div>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-crit/40">
            <CardContent className="flex items-start gap-3 pt-4">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-crit" />
              <div>
                <div className="text-sm font-medium">{t('alarm.summary.error', { msg: provision.message })}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {rule.centreonHost} / {rule.centreonService} — {t('alarm.col.provision')} : {t('alarm.provision.error')}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
        <div className="flex gap-2">
          <Link to="/alarms" className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90">
            {t('alarm.rules')}
          </Link>
          <button type="button" onClick={() => setResult(null)} className="inline-flex h-8 items-center rounded-lg border px-3 text-xs font-medium hover:bg-accent">
            {t('alarm.newRule')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{t('alarm.form.title')}</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t('alarm.hint')}</p>
      </div>
      {error && (
        <div className="rounded-xl border border-crit/40 bg-crit/10 p-3 text-sm text-crit">
          {t('alarm.error', { msg: error })}
        </div>
      )}
      {loading && !targets ? (
        <div className="space-y-2 rounded-xl border p-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : (
        <Card>
          <CardContent className="pt-4">
            <RuleForm
              vms={targets?.vms ?? []}
              nodes={targets?.nodes ?? []}
              clusters={targets?.clusters ?? []}
              pollers={pollers}
              mappingHost={mappingHost}
              metricsVm={metrics.vm}
              metricsNode={metrics.node}
              metricsCluster={metrics.cluster}
              sensorTargets={targets?.sensors ?? null}
              onSubmit={onSubmit}
              submitLabel={t('alarm.form.submit')}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
