import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Check, Pencil, Plus, RefreshCw, RotateCw, Search, Send, Trash2, Undo2 } from 'lucide-react';
import type { AlarmRule, AlarmStats, CentreonPoller } from '@prox4u/shared';
import { Card, CardContent } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Input, Select } from '../../../components/ui/input';
import { Skeleton } from '../../../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';
import { alarmsApi, type ProvisionOutcome } from '../lib/nsca-api';

type SortKey = 'name' | 'target' | 'metric' | 'threshold' | 'poller' | 'host' | 'service' | 'alarm' | 'state' | 'provision' | 'lastAlarm';

function targetLabel(r: AlarmRule): string {
  return r.target.kind === 'vm' ? `${r.target.label} (#${r.target.vmid})` : r.target.label;
}

function provisionTone(r: AlarmRule): string {
  if (r.provisionStatus === 'ok') return 'bg-ok/15 text-ok';
  if (r.provisionStatus === 'error') return 'bg-crit/15 text-crit';
  return 'bg-warn/15 text-warn';
}

/** Teinte de l'état d'alarme (machine à états du moteur — v2). */
function alarmTone(state: AlarmRule['currentState']): string {
  if (state === 'ok') return 'bg-ok/15 text-ok';
  if (state === 'warn') return 'bg-warn/15 text-warn';
  if (state === 'crit') return 'bg-crit/15 text-crit';
  return 'bg-muted-foreground/15 text-muted-foreground';
}

/**
 * Page 2 — Règles de surveillance actives. Tableau avec filtres par colonne
 * (texte, liste poller/état), recherche globale, tri, indicateurs, et actions :
 * activer/désactiver (1 clic), modifier, supprimer, Tester (trame NSCA),
 * Reprovisionner (relance CLAPI/REST).
 */
export function RulesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [rules, setRules] = useState<AlarmRule[]>([]);
  const [stats, setStats] = useState<AlarmStats | null>(null);
  const [pollers, setPollers] = useState<CentreonPoller[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [pollerFilter, setPollerFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [provFilter, setProvFilter] = useState('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await alarmsApi.list();
      setRules(data.rules);
      setStats(data.stats);
      setPollers(data.pollers);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 5000);
    return () => clearTimeout(id);
  }, [flash]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = rules.filter((r) => {
      if (q && !`${r.name} ${targetLabel(r)} ${r.centreonHost} ${r.centreonService}`.toLowerCase().includes(q)) return false;
      if (pollerFilter !== 'all' && r.pollerId !== pollerFilter) return false;
      if (stateFilter === 'active' && !r.active) return false;
      if (stateFilter === 'inactive' && r.active) return false;
      if (provFilter !== 'all' && r.provisionStatus !== provFilter) return false;
      return true;
    });
    const dir = sort.dir === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const get = (r: AlarmRule): string | number => {
        switch (sort.key) {
          case 'name': return r.name;
          case 'target': return targetLabel(r);
          case 'metric': return r.metric;
          case 'threshold': return r.threshold;
          case 'poller': return r.pollerId;
          case 'host': return r.centreonHost;
          case 'service': return r.centreonService;
          case 'alarm': return { ok: 0, warn: 1, crit: 2, unknown: 3 }[r.currentState];
          case 'state': return r.active ? 1 : 0;
          case 'provision': return r.provisionStatus;
          case 'lastAlarm': return r.lastAlarmAt ?? 0;
        }
      };
      const av = get(a); const bv = get(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return rows;
  }, [rules, search, pollerFilter, stateFilter, provFilter, sort]);

  async function toggleActive(r: AlarmRule) {
    await alarmsApi.update(r.id, { active: !r.active });
    void load();
  }
  async function doTest(r: AlarmRule) {
    const res = await alarmsApi.test(r.id);
    setFlash(res.ok ? t('alarm.summary.testOk', { code: res.code }) : t('alarm.summary.testErr', { msg: res.message }));
    void load();
  }
  async function doReprovision(r: AlarmRule) {
    const res: ProvisionOutcome = await alarmsApi.provision(r.id);
    setFlash(res.ok ? t('alarm.summary.reprovOk') : t('alarm.summary.reprovErr', { msg: res.message }));
    void load();
  }
  async function doDelete(r: AlarmRule) {
    if (!confirm(t('alarm.confirm.delete', { name: r.name }))) return;
    const res = await alarmsApi.remove(r.id);
    // Cohérence Prox4u ↔ Centreon (GitHub #20/#21) : feedback selon le résultat.
    if (res.pending) setFlash(t('alarm.delete.pending', { msg: res.message ?? '—' }));
    else if (res.hostDeleted) setFlash(t('alarm.delete.okHost'));
    else if (res.centreon === 'not-found') setFlash(t('alarm.delete.notFound'));
    else setFlash(t('alarm.delete.ok'));
    void load();
  }
  function doEdit(r: AlarmRule) { navigate(`/alarms/edit/${r.id}`); }
  async function doAck(r: AlarmRule) {
    if (r.acknowledgedAt) await alarmsApi.unack(r.id);
    else await alarmsApi.ack(r.id);
    void load();
  }

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }
  const Th = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <TableHead className="cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort(k)}>
      {children} {sort.key === k ? (sort.dir === 'asc' ? '↑' : '↓') : ''}
    </TableHead>
  );

  const kpis: Array<[string, string, string]> = [
    [t('alarm.kpi.active'), String(stats?.activeRules ?? 0), 'text-ok'],
    [t('alarm.kpi.inactive'), String(stats?.inactiveRules ?? 0), 'text-muted-foreground'],
    [t('alarm.kpi.alarms24h'), String(stats?.alarms24h ?? 0), 'text-warn'],
    [t('alarm.kpi.provOk'), String(stats?.provisionOk ?? 0), 'text-ok'],
    [t('alarm.kpi.provErr'), String(stats?.provisionError ?? 0), 'text-crit'],
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{t('alarm.rules')}</h1>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t('alarm.hint')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="md" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {t('topo.refresh')}
          </Button>
          <Link to="/alarms/new" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90">
            <Plus className="h-3.5 w-3.5" /> {t('alarm.newRule')}
          </Link>
        </div>
      </div>

      {flash && (
        <p role="status" className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary">{flash}</p>
      )}
      {error && (
        <div className="rounded-xl border border-crit/40 bg-crit/10 p-3 text-sm text-crit">{t('alarm.error', { msg: error })}</div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {kpis.map(([label, value, tone]) => (
          <Card key={label}>
            <CardContent className="pt-4">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('alarm.search')} className="pl-9" />
        </div>
        <Select value={pollerFilter} onChange={(e) => setPollerFilter(e.target.value)} className="w-40">
          <option value="all">{t('alarm.col.poller')} : {t('pxinv.filter.all')}</option>
          {pollers.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
        </Select>
        <Select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} className="w-36">
          <option value="all">{t('alarm.col.state')} : {t('pxinv.filter.all')}</option>
          <option value="active">{t('alarm.state.active')}</option>
          <option value="inactive">{t('alarm.state.inactive')}</option>
        </Select>
        <Select value={provFilter} onChange={(e) => setProvFilter(e.target.value)} className="w-40">
          <option value="all">{t('alarm.col.provision')} : {t('pxinv.filter.all')}</option>
          <option value="ok">{t('alarm.provision.ok')}</option>
          <option value="error">{t('alarm.provision.error')}</option>
          <option value="pending">{t('alarm.provision.pending')}</option>
        </Select>
      </div>

      {loading && rules.length === 0 ? (
        <div className="space-y-2 rounded-xl border p-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : (
        <div className="rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <Th k="name">{t('alarm.col.name')}</Th>
                <Th k="target">{t('alarm.col.target')}</Th>
                <Th k="metric">{t('alarm.col.metric')}</Th>
                <Th k="threshold">{t('alarm.col.threshold')}</Th>
                <Th k="poller">{t('alarm.col.poller')}</Th>
                <Th k="host">{t('alarm.col.host')}</Th>
                <Th k="service">{t('alarm.col.service')}</Th>
                <Th k="alarm">{t('alarm.col.alarm')}</Th>
                <Th k="state">{t('alarm.col.state')}</Th>
                <Th k="provision">{t('alarm.col.provision')}</Th>
                <Th k="lastAlarm">{t('alarm.col.lastAlarm')}</Th>
                <TableHead>{t('alarm.col.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={12} className="py-8 text-center text-xs text-muted-foreground">{t('alarm.empty')}</TableCell>
                </TableRow>
              ) : visible.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-muted-foreground">{targetLabel(r)}</TableCell>
                  <TableCell>{t(`alarm.metric.${r.metric}`)}</TableCell>
                  <TableCell className="tabular-nums">
                    {r.operator} {r.threshold}
                    {r.recoveryThreshold != null && (
                      <span className="text-muted-foreground"> · {t('alarm.col.recovery')} {r.recoveryThreshold}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.pollerId}</TableCell>
                  <TableCell className="text-muted-foreground">{r.centreonHost}</TableCell>
                  <TableCell className="text-muted-foreground">{r.centreonService}</TableCell>
                  <TableCell>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${alarmTone(r.currentState)}`}>
                      {t(`alarm.sev.${r.currentState}`)}
                    </span>
                    {r.acknowledgedAt != null && (
                      <span
                        className="ml-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                        title={t('alarm.acked.hint', { by: r.acknowledgedBy ?? '—', at: new Date(r.acknowledgedAt).toLocaleString() })}
                      >
                        ✓ {r.acknowledgedBy ?? '—'}
                      </span>
                    )}
                    {r.pendingDeletion === true && (
                      <span
                        className="ml-1 rounded-full bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium text-warn"
                        title={t('alarm.pendingDeletion.hint', { msg: r.pendingDeletionError ?? '—' })}
                      >
                        {t('alarm.state.pendingDeletion')}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => void toggleActive(r)}
                      title={r.active ? t('alarm.action.deactivate') : t('alarm.action.activate')}
                      className={`flex h-5 w-9 items-center rounded-full p-0.5 transition-colors ${r.active ? 'bg-ok/70' : 'bg-muted-foreground/30'}`}
                    >
                      <span className={`flex h-4 w-4 items-center justify-center rounded-full bg-white shadow transition-transform ${r.active ? 'translate-x-4' : ''}`} />
                    </button>
                  </TableCell>
                  <TableCell>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${provisionTone(r)}`} title={r.provisionMessage}>
                      {t(`alarm.provision.${r.provisionStatus}`)}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.lastAlarmAt ? new Date(r.lastAlarmAt).toLocaleString() : '—'}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" title={r.acknowledgedAt ? t('alarm.action.unack') : t('alarm.action.ack')} onClick={() => void doAck(r)}>
                        {r.acknowledgedAt ? <Undo2 className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                      </Button>
                      <Button variant="ghost" size="sm" title={t('alarm.action.test')} onClick={() => void doTest(r)}><Send className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="sm" title={t('alarm.action.reprovision')} onClick={() => void doReprovision(r)}><RotateCw className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="sm" title={t('alarm.action.edit')} onClick={() => doEdit(r)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="sm" title={t('alarm.action.delete')} onClick={() => void doDelete(r)}><Trash2 className="h-3.5 w-3.5 text-crit" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{visible.length} / {rules.length} · {t('pxinv.filter.text')}</p>
    </div>
  );
}
