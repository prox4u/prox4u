import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Database, Download, RotateCcw, Trash2, Zap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Input, Select } from '../../../components/ui/input';
import { Dialog } from '../../../components/ui/dialog';
import { fetchInfluxTables, postInfluxAction } from '../../../core/api/apiClient';

/**
 * Panneau « Actions » InfluxDB — visible seulement si `canAct` (admin ou groupe
 * INFLUX_ACTION_GROUPS). Non-destructifs en 1 clic ; destructifs avec dialog de
 * confirmation. Chaque action est tracée côté serveur dans l'audit admin.
 */
export function InfluxActionsPanel({
  canAct,
  enabled,
  databases,
  onAction,
}: {
  canAct: boolean;
  enabled: boolean;
  databases: Array<{ name: string; retention: string | null }>;
  onAction: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string; file?: string } | null>(null);
  // dialog ouvert (destructifs + export) + champs
  const [dialog, setDialog] = useState<null | 'recreate' | 'drop-db' | 'drop-table' | 'export'>(null);
  const [db, setDb] = useState('');
  const [table, setTable] = useState('');
  const [retention, setRetention] = useState('');
  const [expFrom, setExpFrom] = useState('');
  const [expTo, setExpTo] = useState('');
  // Export multi-tables : liste dynamique (GET /api/influxdb/tables) + sélection.
  const [expTables, setExpTables] = useState<string[]>([]);
  const [expTablesLoading, setExpTablesLoading] = useState(false);
  const [expSelected, setExpSelected] = useState<Set<string>>(new Set());

  if (!canAct) return null;

  const dbNames = databases.map((d) => d.name);
  if (dbNames.length > 0 && !dbNames.includes(db)) setDb(dbNames[0]);

  const run = async (action: string, body?: Record<string, unknown>) => {
    setBusy(action);
    setResult(null);
    try {
      const r = await postInfluxAction(action, body);
      // Export : message lisible (nb tables/lignes + nom de fichier) + bouton de téléchargement.
      if (action === 'export' && typeof r.file === 'string' && r.file) {
        const ex = Array.isArray(r.exports) ? (r.exports as Array<{ rows?: number }>) : [];
        const rows = ex.reduce((s, e) => s + (Number(e.rows) || 0), 0);
        const base = r.file.split('/').pop() ?? r.file;
        setResult({ ok: true, msg: t('influxdb.actions.export.result', { tables: ex.length, rows, file: base }), file: r.file });
      } else {
        setResult({ ok: true, msg: t('influxdb.actions.done', { action }) + (r && Object.keys(r).length ? ` — ${JSON.stringify(r)}` : '') });
      }
      onAction();
    } catch (err) {
      const e = err as Error & { code?: string; status?: number };
      setResult({ ok: false, msg: t('influxdb.actions.error', { action, detail: e.message }) });
    } finally {
      setBusy(null);
    }
  };

  const openDialog = (d: 'recreate' | 'drop-db' | 'drop-table') => {
    setResult(null);
    setDialog(d);
  };

  const confirm = () => {
    if (dialog === 'recreate') {
      void run('database/recreate', { db, ...(retention ? { retention } : {}) });
    } else if (dialog === 'drop-db') {
      void run('database/drop', { db });
    } else if (dialog === 'drop-table') {
      void run('table/drop', { db, table });
    } else if (dialog === 'export') {
      const from = Math.floor(new Date(expFrom).getTime() / 1000);
      const to = Math.floor(new Date(expTo).getTime() / 1000);
      if (Number.isFinite(from) && Number.isFinite(to) && from < to && expSelected.size > 0) {
        void run('export', { tables: [...expSelected], from, to });
      }
    }
    setDialog(null);
  };

  const openExport = () => {
    // par défaut : les 7 derniers jours (format local YYYY-MM-DDTHH:mm pour datetime-local)
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    setExpFrom(local(new Date(Date.now() - 7 * 86_400_000)));
    setExpTo(local(new Date()));
    setExpSelected(new Set());
    setResult(null);
    setDialog('export');
    void loadExpTables();
  };

  const loadExpTables = async () => {
    setExpTablesLoading(true);
    try {
      const r = await fetchInfluxTables();
      setExpTables(r.tables);
    } catch {
      setExpTables([]);
    } finally {
      setExpTablesLoading(false);
    }
  };

  const toggleTable = (tbl: string) => {
    setExpSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tbl)) next.delete(tbl);
      else next.add(tbl);
      return next;
    });
  };

  const allSelected = expTables.length > 0 && expSelected.size === expTables.length;
  const someSelected = expSelected.size > 0 && !allSelected;
  const toggleAll = () => setExpSelected(allSelected ? new Set() : new Set(expTables));

  return (
    <Card className="border">
      <CardHeader>
        <CardTitle>{t('influxdb.actions.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={!enabled || busy !== null} onClick={() => void run('flush')}>
            <Zap className="mr-1 h-3.5 w-3.5" />
            {busy === 'flush' ? t('influxdb.actions.running') : t('influxdb.actions.flush')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void run('archive/run')}>
            <Archive className="mr-1 h-3.5 w-3.5" />
            {busy === 'archive/run' ? t('influxdb.actions.running') : t('influxdb.actions.archiveRun')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void run('archive/reset')}>
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            {busy === 'archive/reset' ? t('influxdb.actions.running') : t('influxdb.actions.archiveReset')}
          </Button>
          <Button variant="outline" size="sm" disabled={!enabled || busy !== null} onClick={openExport}>
            <Download className="mr-1 h-3.5 w-3.5" />
            {t('influxdb.actions.export')}
          </Button>
          <Button variant="outline" size="sm" disabled={!enabled || busy !== null} onClick={() => openDialog('recreate')}>
            <Database className="mr-1 h-3.5 w-3.5" />
            {t('influxdb.actions.recreate')}
          </Button>
          <Button variant="outline" size="sm" disabled={!enabled || busy !== null} onClick={() => openDialog('drop-db')}>
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            {t('influxdb.actions.dropDb')}
          </Button>
          <Button variant="outline" size="sm" disabled={!enabled || busy !== null} onClick={() => openDialog('drop-table')}>
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            {t('influxdb.actions.dropTable')}
          </Button>
        </div>

        {result && (
          <div
            className={`mt-3 rounded-md border p-2 text-xs ${result.ok ? 'border-ok/30 bg-ok/10 text-ok' : 'border-crit/30 bg-crit/10 text-crit'}`}
          >
            {result.msg}
            {result.file && (
              <a
                href={`/api/influxdb/actions/download?file=${encodeURIComponent(result.file.split('/').pop() ?? result.file)}`}
                download
                className="mt-2 inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:opacity-80"
              >
                <Download className="h-3.5 w-3.5" />
                {t('influxdb.actions.download')}
              </a>
            )}
          </div>
        )}

        {/* Dialog recréer une base (destructif) */}
        <Dialog open={dialog === 'recreate'} onClose={() => setDialog(null)} title={t('influxdb.actions.recreate')}>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('influxdb.actions.recreate.confirm')}</p>
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">{t('influxdb.actions.db')}</span>
              <Select value={db} onChange={(e) => setDb(e.target.value)} className="w-full">
                {dbNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">{t('influxdb.actions.retention')}</span>
              <Input value={retention} onChange={(e) => setRetention(e.target.value)} placeholder="2y" />
              <span className="text-xs text-muted-foreground">{t('influxdb.actions.retention.hint')}</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialog(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" disabled={!db || busy !== null} onClick={confirm}>
                {t('common.confirm')}
              </Button>
            </div>
          </div>
        </Dialog>

        {/* Dialog supprimer une base (destructif) */}
        <Dialog open={dialog === 'drop-db'} onClose={() => setDialog(null)} title={t('influxdb.actions.dropDb')}>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('influxdb.actions.dropDb.confirm')}</p>
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">{t('influxdb.actions.db')}</span>
              <Select value={db} onChange={(e) => setDb(e.target.value)} className="w-full">
                {dbNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialog(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" disabled={!db || busy !== null} onClick={confirm}>
                {t('common.confirm')}
              </Button>
            </div>
          </div>
        </Dialog>

        {/* Dialog supprimer une table (destructif) */}
        <Dialog open={dialog === 'drop-table'} onClose={() => setDialog(null)} title={t('influxdb.actions.dropTable')}>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('influxdb.actions.dropTable.confirm')}</p>
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">{t('influxdb.actions.db')}</span>
              <Select value={db} onChange={(e) => setDb(e.target.value)} className="w-full">
                {dbNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">{t('influxdb.actions.table')}</span>
              <Input value={table} onChange={(e) => setTable(e.target.value)} placeholder="influxdb_self" />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialog(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" disabled={!db || !table || busy !== null} onClick={confirm}>
                {t('common.confirm')}
              </Button>
            </div>
          </div>
        </Dialog>

        {/* Dialog export CSV ad-hoc multi-tables (non destructif) — 1 CSV/table → ZIP */}
        <Dialog open={dialog === 'export'} onClose={() => setDialog(null)} title={t('influxdb.actions.export')}>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('influxdb.actions.export.confirm')}</p>
            <div className="space-y-1">
              <span className="text-sm text-muted-foreground">{t('influxdb.actions.tables')}</span>
              {expTablesLoading ? (
                <p className="text-xs text-muted-foreground">{t('influxdb.actions.tablesLoading')}</p>
              ) : expTables.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('influxdb.actions.tablesEmpty')}</p>
              ) : (
                <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border p-2">
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-secondary/50">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected;
                      }}
                      onChange={toggleAll}
                      className="h-3.5 w-3.5"
                    />
                    <span className="font-medium">{t('influxdb.actions.tablesAll')}</span>
                  </label>
                  <div className="my-1 border-t" />
                  {expTables.map((tbl) => (
                    <label key={tbl} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-secondary/50">
                      <input
                        type="checkbox"
                        checked={expSelected.has(tbl)}
                        onChange={() => toggleTable(tbl)}
                        className="h-3.5 w-3.5"
                      />
                      <span className="font-mono text-xs">{tbl}</span>
                    </label>
                  ))}
                </div>
              )}
              <span className="text-xs text-muted-foreground">{t('influxdb.actions.tablesHint')}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">{t('influxdb.actions.from')}</span>
                <Input type="datetime-local" value={expFrom} onChange={(e) => setExpFrom(e.target.value)} />
              </label>
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">{t('influxdb.actions.to')}</span>
                <Input type="datetime-local" value={expTo} onChange={(e) => setExpTo(e.target.value)} />
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialog(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" disabled={expSelected.size === 0 || !expFrom || !expTo || busy !== null || expTablesLoading} onClick={confirm}>
                {t('common.confirm')}
              </Button>
            </div>
          </div>
        </Dialog>
      </CardContent>
    </Card>
  );
}
