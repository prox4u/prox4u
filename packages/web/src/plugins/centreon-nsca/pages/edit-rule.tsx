import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import type { AlarmRule, CentreonPoller, MetricId } from '@prox4u/shared';
import { Card, CardContent } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { alarmsApi, type AlarmTargets } from '../lib/nsca-api';
import type { MetricIdList } from '../lib/types';
import { RuleForm, type RuleFormValues } from '../components/rule-form';

/**
 * Édition d'une règle existante (même formulaire que la création). La
 * modification ne re-provisionne pas Centreon : le bouton « Reprovisionner »
 * du tableau (Page 2) relance la création CLAPI/REST si besoin.
 */
export function EditRulePage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [rule, setRule] = useState<AlarmRule | null>(null);
  const [targets, setTargets] = useState<AlarmTargets | null>(null);
  const [pollers, setPollers] = useState<CentreonPoller[]>([]);
  const [metrics, setMetrics] = useState<{ vm: MetricIdList; node: MetricIdList }>({ vm: [], node: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, tgt] = await Promise.all([alarmsApi.list(), alarmsApi.targets()]);
      setPollers(list.pollers);
      setMetrics({ vm: list.metrics.vm, node: list.metrics.node });
      setTargets(tgt);
      setRule(list.rules.find((r) => r.id === id) ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const mappingHost = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of targets?.mappings ?? []) map.set(m.key, m.host);
    return (endpointId: string, vmid: number) => map.get(`${endpointId}/${vmid}`);
  }, [targets]);

  async function onSubmit(values: RuleFormValues) {
    await alarmsApi.update(id!, {
      name: values.name.trim(),
      target: values.kind === 'vm'
        ? { kind: 'vm', endpointId: values.endpointId, vmid: values.vmid ?? undefined, label: targets?.vms.find((v) => v.vmid === values.vmid)?.name ?? '' }
        : { kind: 'node', endpointId: values.endpointId, node: values.node, label: values.node },
      metric: values.metric as MetricId,
      operator: values.operator,
      threshold: Number(values.threshold),
      confirmSeconds: Math.round(Number(values.confirmMinutes) * 60),
      severity: values.severity,
      pollerId: values.pollerId,
      centreonHost: values.centreonHost.trim(),
      centreonService: values.centreonService.trim(),
      messageTemplate: values.messageTemplate,
      active: values.active,
    });
    window.location.assign('/alarms');
  }

  if (error) {
    return <div className="rounded-xl border border-crit/40 bg-crit/10 p-3 text-sm text-crit">{t('alarm.error', { msg: error })}</div>;
  }
  if (loading) {
    return (
      <div className="space-y-2 rounded-xl border p-4">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  if (!rule) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('alarm.error', { msg: 'inconnue' })}</p>
        <Link to="/alarms" className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground">{t('alarm.rules')}</Link>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">{t('alarm.form.editTitle')} — {rule.name}</h1>
      <Card>
        <CardContent className="pt-4">
          <RuleForm
            vms={targets?.vms ?? []}
            nodes={targets?.nodes ?? []}
            pollers={pollers}
            mappingHost={mappingHost}
            initial={rule}
            metricsVm={metrics.vm}
            metricsNode={metrics.node}
            onSubmit={onSubmit}
            onCancel={() => window.location.assign('/alarms')}
            submitLabel={t('alarm.form.update')}
          />
        </CardContent>
      </Card>
    </div>
  );
}
