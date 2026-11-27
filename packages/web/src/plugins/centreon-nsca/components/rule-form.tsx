import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  defaultServiceName,
  sensorTargetFields,
  suggestCenteronHost,
  type AlarmOperator,
  type AlarmRule,
  type AlarmSeverity,
  type CentreonPoller,
  type MetricId,
} from '@prox4u/shared';
import { Button } from '../../../components/ui/button';
import { Input, Select } from '../../../components/ui/input';
import type { AlarmSensorTargets, TargetCluster, TargetNode, TargetVm } from '../lib/nsca-api';
import type { MetricIdList } from '../lib/types';

export interface RuleFormValues {
  name: string;
  kind: 'vm' | 'node' | 'cluster';
  endpointId: string;
  vmid: number | null;
  node: string;
  metric: MetricId | '';
  /** Disque SMART (métriques smart_temp_c / smart_health). */
  device: string;
  /** Capteur lm-sensors (métrique sensor_temp_c) — chip + feature. */
  chip: string;
  feature: string;
  /** Unité systemd (métrique systemd_unit_failed). */
  unit: string;
  /** Pool ZFS (métrique zfs_pool_state). */
  pool: string;
  operator: AlarmOperator;
  threshold: string;
  /** Seuil de récupération (hystérésis) — '' = même seuil que le déclenchement. */
  recoveryThreshold: string;
  confirmMinutes: string;
  /** Durée minimale d'alarme en minutes (0 = off) — anti-flapping. */
  suppressMinutes: string;
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
  /** Cibles capteurs (GitHub #4) — `null` si InfluxDB indisponible. */
  sensorTargets?: AlarmSensorTargets | null;
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
export function RuleForm({ vms, nodes, clusters, pollers, mappingHost, initial, metricsVm, metricsNode, metricsCluster, sensorTargets, onSubmit, onCancel, submitLabel }: Props) {
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
          device: initial.target.device ?? '',
          chip: initial.target.chip ?? '',
          feature: initial.target.feature ?? '',
          unit: initial.target.unit ?? '',
          pool: initial.target.pool ?? '',
          operator: initial.operator,
          threshold: String(initial.threshold),
          recoveryThreshold: initial.recoveryThreshold != null ? String(initial.recoveryThreshold) : '',
          confirmMinutes: String(Math.round(initial.confirmSeconds / 60)),
          suppressMinutes: String(Math.round((initial.suppressSeconds ?? 0) / 60)),
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
          device: '',
          chip: '',
          feature: '',
          unit: '',
          pool: '',
          operator: '>',
          threshold: '90',
          recoveryThreshold: '',
          confirmMinutes: '5',
          suppressMinutes: '0',
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

  // Métriques capteurs (GitHub #4) : identifiants requis par la métrique courante
  // (device / chip+feature / unit / pool) — vide si métrique non capteur.
  const sensorFields = values.kind === 'node' && values.metric ? sensorTargetFields(values.metric as MetricId) : [];
  // Cibles capteurs filtrées sur le nœud sélectionné.
  const smartForNode = useMemo(() => (sensorTargets?.smart ?? []).filter((s) => s.node === values.node), [sensorTargets, values.node]);
  const sensorsForNode = useMemo(() => (sensorTargets?.sensors ?? []).filter((s) => s.node === values.node), [sensorTargets, values.node]);
  const unitsForNode = useMemo(() => (sensorTargets?.units ?? []).filter((u) => u.node === values.node).map((u) => u.name).sort(), [sensorTargets, values.node]);
  const poolsForNode = useMemo(() => (sensorTargets?.pools ?? []).filter((p) => p.node === values.node && p.poolName), [sensorTargets, values.node]);
  const chipsForNode = useMemo(() => [...new Set(sensorsForNode.map((s) => s.chip))].sort(), [sensorsForNode]);
  const featuresForChip = useMemo(
    () => (values.chip ? [...new Set(sensorsForNode.filter((s) => s.chip === values.chip).map((s) => s.feature))].sort() : []),
    [sensorsForNode, values.chip],
  );

  // Si le type de cible change et que la métrique courante n'est pas applicable
  // à la nouvelle cible, on retombe sur la 1re métrique de la liste.
  useEffect(() => {
    if (values.metric && !metrics.includes(values.metric)) {
      set('metric', metrics[0] ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.kind]);

  // Métrique capteur changée → on ne garde que les identifiants requis par la
  // nouvelle métrique (ex. device → chip/feature).
  const prevMetric = useRef(values.metric);
  useEffect(() => {
    if (prevMetric.current === values.metric) return;
    prevMetric.current = values.metric;
    setValues((v) => {
      const fields = v.kind === 'node' && v.metric ? sensorTargetFields(v.metric as MetricId) : [];
      return {
        ...v,
        device: fields.includes('device') ? v.device : '',
        chip: fields.includes('chip') ? v.chip : '',
        feature: fields.includes('feature') ? v.feature : '',
        unit: fields.includes('unit') ? v.unit : '',
        pool: fields.includes('pool') ? v.pool : '',
      };
    });
  }, [values.metric]);

  // Nœud changé → les identifiants capteurs appartiennent à l'ancien nœud.
  const prevNode = useRef(values.node);
  useEffect(() => {
    if (prevNode.current === values.node) return;
    prevNode.current = values.node;
    setValues((v) => ({ ...v, device: '', chip: '', feature: '', unit: '', pool: '' }));
  }, [values.node]);

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
      // Le serveur renvoie `fields` (champs invalides) sur une 400 — l'afficher
      // pour un diagnostic immédiat au lieu du message générique seul.
      const err = e as Error & { fields?: string[] };
      setError(err.fields?.length ? `${err.message} — champs : ${err.fields.join(', ')}` : err.message);
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
        {/* Sélecteurs du capteur ciblé (GitHub #4) — affichés si la métrique
            courante est une métrique capteur (cible nœud + identifiant). */}
        {sensorFields.length > 0 && (
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
            <p className="mb-2 text-[11px] font-medium text-primary">{t('alarm.form.sensor.hint')}</p>
            {sensorTargets == null && (
              <p className="mb-2 text-[11px] text-muted-foreground">{t('alarm.form.sensorTargets.empty')}</p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {sensorFields.includes('device') && (
                <label className="flex flex-col gap-1 text-xs font-medium">
                  {t('alarm.form.device')}
                  <Select value={values.device} onChange={(e) => set('device', e.target.value)}>
                    <option value="">{sensorTargets == null ? '—' : '…'}</option>
                    {smartForNode.map((d) => (
                      <option key={d.device} value={d.device}>{d.device}{d.model ? ` (${d.model})` : ''}</option>
                    ))}
                  </Select>
                  <span className="font-normal text-muted-foreground">{t('alarm.form.device.hint')}</span>
                </label>
              )}
              {sensorFields.includes('chip') && (
                <label className="flex flex-col gap-1 text-xs font-medium">
                  {t('alarm.form.chip')}
                  <Select value={values.chip} onChange={(e) => { set('chip', e.target.value); set('feature', ''); }}>
                    <option value="">{sensorTargets == null ? '—' : '…'}</option>
                    {chipsForNode.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </Select>
                </label>
              )}
              {sensorFields.includes('feature') && (
                <label className="flex flex-col gap-1 text-xs font-medium">
                  {t('alarm.form.feature')}
                  <Select value={values.feature} onChange={(e) => set('feature', e.target.value)} disabled={!values.chip}>
                    <option value="">{values.chip ? '…' : '—'}</option>
                    {featuresForChip.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </Select>
                  <span className="font-normal text-muted-foreground">{t('alarm.form.sensor.hint')}</span>
                </label>
              )}
              {sensorFields.includes('unit') && (
                <label className="flex flex-col gap-1 text-xs font-medium">
                  {t('alarm.form.unit')}
                  <Input
                    value={values.unit}
                    onChange={(e) => set('unit', e.target.value)}
                    list="alarm-unit-suggestions"
                    placeholder="pve-firewall.service"
                  />
                  <datalist id="alarm-unit-suggestions">
                    {unitsForNode.map((u) => (
                      <option key={u} value={u} />
                    ))}
                  </datalist>
                  <span className="font-normal text-muted-foreground">{t('alarm.form.unit.hint')}</span>
                </label>
              )}
              {sensorFields.includes('pool') && (
                <label className="flex flex-col gap-1 text-xs font-medium">
                  {t('alarm.form.pool')}
                  <Select value={values.pool} onChange={(e) => set('pool', e.target.value)}>
                    <option value="">{sensorTargets == null ? '—' : '…'}</option>
                    {poolsForNode.map((p) => (
                      <option key={p.poolName} value={p.poolName!}>{p.poolName} ({p.poolState ?? '—'})</option>
                    ))}
                  </Select>
                  <span className="font-normal text-muted-foreground">{t('alarm.form.pool.hint')}</span>
                </label>
              )}
            </div>
          </div>
        )}
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
            {values.metric === 'sensor_temp_c' && (
              <span className="font-normal text-muted-foreground">{t('alarm.form.effectiveThreshold.hint')}</span>
            )}
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium">
            {t('alarm.form.recoveryThreshold')}
            <Input type="number" value={values.recoveryThreshold} onChange={(e) => set('recoveryThreshold', e.target.value)} placeholder="—" />
            <span className="font-normal text-muted-foreground">{t('alarm.form.recoveryThreshold.hint')}</span>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            {t('alarm.form.suppress')} ({t('alarm.form.suppress.unit')})
            <Input type="number" min={0} value={values.suppressMinutes} onChange={(e) => set('suppressMinutes', e.target.value)} />
            <span className="font-normal text-muted-foreground">{t('alarm.form.suppress.hint')}</span>
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
            placeholder={values.kind === 'vm' && values.vmid !== null
              ? suggestCenteronHost(vmsForEndpoint.find((v) => v.vmid === values.vmid)?.name ?? '')
              : values.kind === 'node' && values.node
                ? suggestCenteronHost(values.node)
                : ''}
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
