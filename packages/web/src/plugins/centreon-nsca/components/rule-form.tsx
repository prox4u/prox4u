import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  defaultServiceName,
  suggestCenteronHost,
  type AlarmOperator,
  type AlarmRule,
  type AlarmSeverity,
  type CentreonPoller,
  type MetricId,
} from '@prox4u/shared';
import { Button } from '../../../components/ui/button';
import { Input, Select } from '../../../components/ui/input';
import type { TargetCluster, TargetNode, TargetVm } from '../lib/nsca-api';
import type { MetricIdList } from '../lib/types';

export interface RuleFormValues {
  name: string;
  kind: 'vm' | 'node' | 'cluster';
  endpointId: string;
  vmid: number | null;
  node: string;
  metric: MetricId | '';
  operator: AlarmOperator;
  threshold: string;
  confirmMinutes: string;
  severity: AlarmSeverity;
  pollerId: string;
  centreonHost: string;
  centreonService: string;
  messageTemplate: string;
  active: boolean;
}

interface Props {
  vms: TargetVm[];
  nodes: TargetNode[];
  clusters: TargetCluster[];
  pollers: CentreonPoller[];
  /** host Centreon déjà mappé pour une VM (override prioritaire). */
  mappingHost?: (endpointId: string, vmid: number) => string | undefined;
  initial?: AlarmRule;
  metricsVm: MetricIdList;
  metricsNode: MetricIdList;
  metricsCluster: MetricIdList;
  onSubmit: (values: RuleFormValues) => Promise<void>;
  onCancel?: () => void;
  submitLabel: string;
}

const OPERATORS: AlarmOperator[] = ['>', '<', '=', '!='];
const SEVERITIES: AlarmSeverity[] = ['warn', 'crit', 'unknown'];

/**
 * Formulaire de création/édition d'une règle. Auto-suggestions :
 * - hôte Centreon : mapping existant → sinon suggestCenteronHost(nom VM) ;
 * - service Centreon : defaultServiceName(métrique, nom de règle) — recalculé
 *   à chaque changement de métrique/nom, mais reste édit manuellement.
 */
export function RuleForm({ vms, nodes, clusters, pollers, mappingHost, initial, metricsVm, metricsNode, metricsCluster, onSubmit, onCancel, submitLabel }: Props) {
  const { t } = useTranslation();
  const [values, setValues] = useState<RuleFormValues>(() =>
    initial
      ? {
          name: initial.name,
          kind: initial.target.kind,
          endpointId: initial.target.endpointId,
          vmid: initial.target.vmid ?? null,
          node: initial.target.node ?? '',
          metric: initial.metric,
          operator: initial.operator,
          threshold: String(initial.threshold),
          confirmMinutes: String(Math.round(initial.confirmSeconds / 60)),
          severity: initial.severity === 'ok' ? 'crit' : initial.severity,
          pollerId: initial.pollerId,
          centreonHost: initial.centreonHost,
          centreonService: initial.centreonService,
          messageTemplate: initial.messageTemplate,
          active: initial.active,
        }
      : {
          name: '',
          kind: 'vm',
          endpointId: vms[0]?.endpointId ?? nodes[0]?.endpointId ?? clusters[0]?.endpointId ?? '',
          vmid: vms[0]?.vmid ?? null,
          node: nodes[0]?.node ?? '',
          metric: 'cpu_pct',
          operator: '>',
          threshold: '90',
          confirmMinutes: '5',
          severity: 'crit',
          pollerId: pollers[0]?.id ?? '',
          centreonHost: '',
          centreonService: '',
          messageTemplate: 'Alarme Prox4u — {{vm}} : {{metric}} = {{value}} (seuil {{threshold}})',
          active: true,
        },
  );
  const [hostTouched, setHostTouched] = useState(Boolean(initial));
  const [serviceTouched, setServiceTouched] = useState(Boolean(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endpointIds = useMemo(
    () => [...new Set([...vms.map((v) => v.endpointId), ...nodes.map((n) => n.endpointId), ...clusters.map((c) => c.endpointId)])],
    [vms, nodes, clusters],
  );
  const vmsForEndpoint = vms.filter((v) => v.endpointId === values.endpointId);
  const nodesForEndpoint = nodes.filter((n) => n.endpointId === values.endpointId);
  const metrics = values.kind === 'vm' ? metricsVm : values.kind === 'node' ? metricsNode : metricsCluster;

  // Si le type de cible change et que la métrique courante n'est pas applicable
  // à la nouvelle cible, on retombe sur la 1re métrique de la liste.
  useEffect(() => {
    if (values.metric && !metrics.includes(values.metric)) {
      set('metric', metrics[0] ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.kind]);

  // Auto-suggestion hôte Centreon (mapping → nom VM) tant que non touché.
  useEffect(() => {
    if (hostTouched || values.kind !== 'vm' || values.vmid === null) return;
    const mapped = mappingHost?.(values.endpointId, values.vmid);
    if (mapped) setValues((v) => ({ ...v, centreonHost: mapped }));
  }, [values.kind, values.vmid, values.endpointId, hostTouched, mappingHost]);

  // Auto-génération du nom de service (métrique + nom de règle) tant que non touché.
  useEffect(() => {
    if (serviceTouched) return;
    setValues((v) => ({ ...v, centreonService: defaultServiceName((v.metric || 'cpu_pct') as MetricId, v.name) }));
  }, [values.metric, values.name, serviceTouched]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const set = <K extends keyof RuleFormValues>(key: K, val: RuleFormValues[K]) => setValues((v) => ({ ...v, [key]: val }));

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="rounded-lg border border-crit/30 bg-crit/10 px-3 py-2 text-xs text-crit">
          {t('alarm.error', { msg: error })}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t('alarm.form.name')}
          <Input value={values.name} onChange={(e) => set('name', e.target.value)} placeholder="CPU prod" />
          <span className="font-normal text-muted-foreground">{t('alarm.form.name.hint')}</span>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t('alarm.form.targetKind')}
          <Select value={values.kind} onChange={(e) => set('kind', e.target.value as 'vm' | 'node' | 'cluster')}>
            <option value="vm">{t('alarm.form.targetKind.vm')}</option>
            <option value="node">{t('alarm.form.targetKind.node')}</option>
            <option value="cluster">{t('alarm.form.targetKind.cluster')}</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t('alarm.form.endpoint')}
          <Select value={values.endpointId} onChange={(e) => set('endpointId', e.target.value)}>
            {endpointIds.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </Select>
        </label>
        {values.kind === 'vm' ? (
          <label className="flex flex-col gap-1 text-xs font-medium">
            {t('alarm.form.vm')}
            <Select value={values.vmid ?? ''} onChange={(e) => set('vmid', e.target.value === '' ? null : Number(e.target.value))}>
              {vmsForEndpoint.map((v) => (
                <option key={v.vmid} value={v.vmid}>{v.name} (#{v.vmid} — {v.node})</option>
              ))}
            </Select>
          </label>
        ) : values.kind === 'node' ? (
          <label className="flex flex-col gap-1 text-xs font-medium">
            {t('alarm.form.node')}
            <Select value={values.node} onChange={(e) => set('node', e.target.value)}>
              {nodesForEndpoint.map((n) => (
                <option key={n.node} value={n.node}>{n.node} {n.online ? '' : '(hors ligne)'}</option>
              ))}
            </Select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t('alarm.form.metric')}
          <Select value={values.metric} onChange={(e) => set('metric', e.target.value as MetricId)}>
            {metrics.map((m) => (
              <option key={m} value={m}>{t(`alarm.metric.${m}`)}</option>
            ))}
          </Select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium">
            {t('alarm.form.operator')}
            <Select value={values.operator} onChange={(e) => set('operator', e.target.value as AlarmOperator)}>
              {OPERATORS.map((op) => (
                <option key={op} value={op}>{op}</option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            {t('alarm.form.threshold')}
            <Input type="number" value={values.threshold} onChange={(e) => set('threshold', e.target.value)} />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t('alarm.form.confirm')} ({t('alarm.form.confirm.unit')})
          <Input type="number" min={0} value={values.confirmMinutes} onChange={(e) => set('confirmMinutes', e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t('alarm.form.severity')}
          <Select value={values.severity} onChange={(e) => set('severity', e.target.value as AlarmSeverity)}>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>{t(`alarm.sev.${s}`)}</option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t('alarm.form.poller')}
          <Select value={values.pollerId} onChange={(e) => set('pollerId', e.target.value)}>
            {pollers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t('alarm.form.host')}
          <Input
            value={values.centreonHost}
            onChange={(e) => { setHostTouched(true); set('centreonHost', e.target.value); }}
            placeholder={values.kind === 'vm' && values.vmid !== null ? suggestCenteronHost(vmsForEndpoint.find((v) => v.vmid === values.vmid)?.name ?? '') : ''}
          />
          <span className="font-normal text-muted-foreground">{t('alarm.form.host.hint')}</span>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t('alarm.form.service')}
          <Input
            value={values.centreonService}
            onChange={(e) => { setServiceTouched(true); set('centreonService', e.target.value); }}
            placeholder="Prox4u-Alarm-…"
          />
          <span className="font-normal text-muted-foreground">{t('alarm.form.service.hint')}</span>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium sm:col-span-2">
          {t('alarm.form.message')}
          <textarea
            value={values.messageTemplate}
            onChange={(e) => set('messageTemplate', e.target.value)}
            rows={2}
            className="w-full rounded-lg border bg-background p-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <span className="font-normal text-muted-foreground">{t('alarm.form.message.hint')}</span>
        </label>
      </div>
      <label className="flex items-center gap-2 text-xs font-medium">
        <input type="checkbox" checked={values.active} onChange={(e) => set('active', e.target.checked)} className="h-4 w-4 rounded border" />
        {t('alarm.form.active')}
        <span className="font-normal text-muted-foreground">— {t('alarm.form.active.hint')}</span>
      </label>
      <div className="flex items-center gap-2">
        <Button variant="default" onClick={() => void submit()} disabled={busy}>
          {busy ? '…' : submitLabel}
        </Button>
        {onCancel && (
          <Button variant="outline" onClick={onCancel}>
            {t('alarm.form.cancel')}
          </Button>
        )}
      </div>
    </div>
  );
}
