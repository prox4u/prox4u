import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, Plus, RotateCcw, Save, Trash2, Wifi } from 'lucide-react';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { influxShardsApi, type InfluxShard } from '../../plugins/influxdb/lib/influx-shards-api';

interface Props {
  onDone: () => void;
}

/** État du formulaire d'ajout/édition d'un shard. */
interface Draft {
  endpointId: string;
  url: string;
  token: string;
  rawDb: string;
  aggDb: string;
  caCert: string;
}

const EMPTY_DRAFT: Draft = { endpointId: '', url: '', token: '', rawDb: '', aggDb: '', caCert: '' };

/**
 * Onglet Administration « Shards InfluxDB » (GitHub #18, Phase 0 dormant).
 *
 * - Liste des shards configurés (endpoint → instance InfluxDB) + actions
 *   (tester la connexion, retirer).
 * - Formulaire d'ajout/édition : endpoint (dropdown des endpoints connus),
 *   URL, token (vide = global), bases (vide = globales), CA (vide = global).
 * - Sharding dormant : liste vide → tout reste sur l'instance globale.
 * - Sauvegarde explicite par shard (upsert) ; « Tout retirer » = retour
 *   instance unique.
 */
export function InfluxShards({ onDone }: Props) {
  const { t } = useTranslation();
  const [shards, setShards] = useState<InfluxShard[]>([]);
  const [endpoints, setEndpoints] = useState<Array<{ id: string; name: string }>>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, boolean | null>>({});

  const apply = useCallback((res: { shards: InfluxShard[]; endpoints: Array<{ id: string; name: string }> }) => {
    setShards(res.shards);
    setEndpoints(res.endpoints);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await influxShardsApi.list());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [apply]);

  useEffect(() => { void load(); }, [load]);

  function startAdd() {
    setDraft({ ...EMPTY_DRAFT, endpointId: endpoints[0]?.id ?? '' });
    setEditing(true);
    setSaved(false);
  }

  function startEdit(s: InfluxShard) {
    setDraft({
      endpointId: s.endpointId,
      url: s.url,
      token: s.token ?? '',
      rawDb: s.rawDb ?? '',
      aggDb: s.aggDb ?? '',
      caCert: s.caCert ?? '',
    });
    setEditing(true);
    setSaved(false);
  }

  function cancel() {
    setEditing(false);
    setDraft(EMPTY_DRAFT);
  }

  function setDraftField(field: keyof Draft, val: string) {
    setSaved(false);
    setDraft((d) => ({ ...d, [field]: val }));
  }

  async function save() {
    if (!draft.endpointId || !draft.url.trim()) return;
    const shard: InfluxShard = {
      endpointId: draft.endpointId,
      url: draft.url.trim(),
    };
    if (draft.token.trim()) shard.token = draft.token.trim();
    if (draft.rawDb.trim()) shard.rawDb = draft.rawDb.trim();
    if (draft.aggDb.trim()) shard.aggDb = draft.aggDb.trim();
    if (draft.caCert.trim()) shard.caCert = draft.caCert.trim();
    setBusy(true);
    setError(null);
    try {
      apply(await influxShardsApi.upsert(shard));
      setSaved(true);
      setEditing(false);
      setDraft(EMPTY_DRAFT);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeOne(s: InfluxShard) {
    if (!window.confirm(t('influxShards.remove.confirm', { endpoint: s.endpointId }))) return;
    setBusy(true);
    setError(null);
    try {
      apply(await influxShardsApi.remove(s.endpointId));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    if (!window.confirm(t('influxShards.clearAll.confirm'))) return;
    setBusy(true);
    setError(null);
    try {
      apply(await influxShardsApi.clearAll());
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(endpointId: string) {
    setTestResult((r) => ({ ...r, [endpointId]: null }));
    try {
      const res = await influxShardsApi.test(endpointId);
      setTestResult((r) => ({ ...r, [endpointId]: res.ping }));
    } catch {
      setTestResult((r) => ({ ...r, [endpointId]: false }));
    }
  }

  const endpointName = (id: string) => endpoints.find((e) => e.id === id)?.name ?? id;

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      {error && (
        <p role="alert" className="rounded-lg border border-crit/30 bg-crit/10 px-3 py-2 text-xs text-crit">
          {t('influxShards.error', { msg: error })}
        </p>
      )}
      {saved && (
        <p role="status" className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok">{t('influxShards.saved')}</p>
      )}

      <section className="space-y-1">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4" />
          <h3 className="text-sm font-semibold">{t('influxShards.title')}</h3>
        </div>
        <p className="text-xs text-muted-foreground">{t('influxShards.hint')}</p>
      </section>

      {shards.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
          {t('influxShards.dormant')}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('influxShards.endpoint')}</TableHead>
              <TableHead>{t('influxShards.url')}</TableHead>
              <TableHead>{t('influxShards.rawDb')}</TableHead>
              <TableHead>{t('influxShards.aggDb')}</TableHead>
              <TableHead className="w-24">{t('influxShards.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shards.map((s) => {
              const tr = testResult[s.endpointId];
              return (
                <TableRow key={s.endpointId}>
                  <TableCell className="font-medium">{endpointName(s.endpointId)}</TableCell>
                  <TableCell className="max-w-52 truncate" title={s.url}>{s.url}</TableCell>
                  <TableCell className="text-muted-foreground">{s.rawDb ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{s.aggDb ?? '—'}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void testConnection(s.endpointId)}
                        title={t('influxShards.test')}
                      >
                        <Wifi className={`h-3.5 w-3.5 ${tr === true ? 'text-ok' : tr === false ? 'text-crit' : 'text-muted-foreground'}`} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => startEdit(s)}
                        title={t('influxShards.edit')}
                      >
                        <Save className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void removeOne(s)}
                        disabled={busy}
                        title={t('influxShards.remove')}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-crit" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {/* Formulaire d'ajout/édition */}
      {editing ? (
        <section className="space-y-3 rounded-xl border bg-card p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium">{t('influxShards.endpoint')}</label>
              <Select
                value={draft.endpointId}
                onChange={(e) => setDraftField('endpointId', e.target.value)}
                disabled={shards.some((s) => s.endpointId === draft.endpointId)}
              >
                {endpoints.map((e) => (
                  <option key={e.id} value={e.id} disabled={shards.some((s) => s.endpointId === e.id && e.id !== draft.endpointId)}>
                    {e.name} ({e.id})
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">{t('influxShards.url')}</label>
              <Input
                value={draft.url}
                onChange={(e) => setDraftField('url', e.target.value)}
                placeholder={t('influxShards.urlPlaceholder')}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">{t('influxShards.token')}</label>
              <Input
                type="password"
                value={draft.token}
                onChange={(e) => setDraftField('token', e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">{t('influxShards.caCert')}</label>
              <Input
                value={draft.caCert}
                onChange={(e) => setDraftField('caCert', e.target.value)}
                placeholder="data/tls/influxdb-cert.pem"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">{t('influxShards.rawDb')}</label>
              <Input value={draft.rawDb} onChange={(e) => setDraftField('rawDb', e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">{t('influxShards.aggDb')}</label>
              <Input value={draft.aggDb} onChange={(e) => setDraftField('aggDb', e.target.value)} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="md" onClick={() => void save()} disabled={busy || !draft.endpointId || !draft.url.trim()}>
              <Save className="h-3.5 w-3.5" /> {busy ? '…' : t('influxShards.save')}
            </Button>
            <Button variant="ghost" size="md" onClick={cancel}>
              {t('influxShards.cancel')}
            </Button>
          </div>
        </section>
      ) : (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="md" onClick={startAdd} disabled={endpoints.length === 0}>
            <Plus className="h-3.5 w-3.5" /> {t('influxShards.add')}
          </Button>
          <Button variant="ghost" size="md" onClick={() => void clearAll()} disabled={busy || shards.length === 0}>
            <RotateCcw className="mr-1 h-3.5 w-3.5 text-crit" /> {t('influxShards.clearAll')}
          </Button>
        </div>
      )}
    </div>
  );
}
