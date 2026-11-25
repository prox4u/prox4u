import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Database, DatabaseBackup, Download, History, RotateCcw, Trash2, Zap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Input, Select } from '../../../components/ui/input';
import { Dialog } from '../../../components/ui/dialog';
import {
  downloadInfluxExport,
  fetchInfluxBackups,
  fetchInfluxTables,
  influxDownloadUrl,
  postInfluxAction,
} from '../../../core/api/apiClient';

type Risk = 'safe' | 'caution' | 'critical';

/** Action en attente de validation (étape avant exécution). */
interface PendingAction {
  action: string;
  label: string;
  risk: Risk;
  what: string;
  impact: string;
  details?: Array<{ k: string; v: string }>;
  body?: Record<string, unknown>;
}

/** Métadonnées de validation par action (risque + clés i18n label/what/impact). */
const ACTION_META: Record<string, { risk: Risk; labelKey: string; whatKey: string; impactKey: string }> = {
  'flush': { risk: 'safe', labelKey: 'influxdb.actions.flush', whatKey: 'influxdb.actions.flush.what', impactKey: 'influxdb.actions.flush.impact' },
  'archive/run': { risk: 'safe', labelKey: 'influxdb.actions.archiveRun', whatKey: 'influxdb.actions.archiveRun.what', impactKey: 'influxdb.actions.archiveRun.impact' },
  'archive/reset': { risk: 'caution', labelKey: 'influxdb.actions.archiveReset', whatKey: 'influxdb.actions.archiveReset.what', impactKey: 'influxdb.actions.archiveReset.impact' },
  'export': { risk: 'safe', labelKey: 'influxdb.actions.export', whatKey: 'influxdb.actions.export.what', impactKey: 'influxdb.actions.export.impact' },
  'database/backup': { risk: 'safe', labelKey: 'influxdb.actions.backup', whatKey: 'influxdb.actions.backup.what', impactKey: 'influxdb.actions.backup.impact' },
  'database/restore': { risk: 'caution', labelKey: 'influxdb.actions.restore', whatKey: 'influxdb.actions.restore.what', impactKey: 'influxdb.actions.restore.impact' },
  'database/recreate': { risk: 'critical', labelKey: 'influxdb.actions.recreate', whatKey: 'influxdb.actions.recreate.what', impactKey: 'influxdb.actions.recreate.impact' },
  'database/drop': { risk: 'critical', labelKey: 'influxdb.actions.dropDb', whatKey: 'influxdb.actions.dropDb.what', impactKey: 'influxdb.actions.dropDb.impact' },
  'table/drop': { risk: 'critical', labelKey: 'influxdb.actions.dropTable', whatKey: 'influxdb.actions.dropTable.what', impactKey: 'influxdb.actions.dropTable.impact' },
};

/** Style du badge de risque (palette du design system). */
const RISK_BADGE: Record<Risk, string> = {
  safe: 'border-ok/30 bg-ok/10 text-ok',
  caution: 'border-warn/30 bg-warn/10 text-warn',
  critical: 'border-crit/30 bg-crit/10 text-crit',
};

/**
 * Panneau « Actions » InfluxDB — visible seulement si `canAct` (admin ou groupe
 * INFLUX_ACTION_GROUPS). Chaque action passe par une ÉTAPE DE VALIDATION avant
 * exécution : explication de la tâche + impact + niveau de risque (sûre /
 * attention / critique) + Annuler / Continuer. Chaque action est tracée côté
 * serveur dans l'audit admin.
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
  const [result, setResult] = useState<{ ok: boolean; msg: string; downloadFile?: string } | null>(null);
  // dialog ouvert (destructifs + export + sauvegarde/restauration) + champs
  const [dialog, setDialog] = useState<null | 'recreate' | 'drop-db' | 'drop-table' | 'export' | 'backup' | 'restore'>(null);
  const [db, setDb] = useState('');
  const [table, setTable] = useState('');
  const [retention, setRetention] = useState('');
  // drop-db : sauvegarde préalable (checkbox)
  const [dropBackup, setDropBackup] = useState(false);
  // restauration : liste des sauvegardes (GET /api/influxdb/backups) + sélection
  const [backups, setBackups] = useState<Array<{ file: string; db: string; createdAt: string; size: number; tables: number; rows: number }>>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [restoreFile, setRestoreFile] = useState('');
  const [expFrom, setExpFrom] = useState('');
  const [expTo, setExpTo] = useState('');
  // Export multi-tables : liste dynamique (GET /api/influxdb/tables) + sélection.
  const [expTables, setExpTables] = useState<string[]>([]);
  const [expTablesLoading, setExpTablesLoading] = useState(false);
  const [expSelected, setExpSelected] = useState<Set<string>>(new Set());
  // Étape de validation avant exécution (toutes les actions).
  const [pending, setPending] = useState<PendingAction | null>(null);

  if (!canAct) return null;

  const dbNames = databases.map((d) => d.name);
  if (dbNames.length > 0 && !dbNames.includes(db)) setDb(dbNames[0]);

  const run = async (action: string, body?: Record<string, unknown>) => {
    setBusy(action);
    setResult(null);
    try {
      if (action === 'export') {
        // Téléchargement direct : le ZIP part en mémoire → navigateur (aucun fichier serveur).
        const s = await downloadInfluxExport(body as { tables: string[]; from: number; to: number });
        setResult({ ok: true, msg: t('influxdb.actions.export.result', { tables: s.tables, rows: s.rows, file: s.file }) });
      } else {
        const r = await postInfluxAction(action, body);
        if (action === 'database/backup') {
          // Sauvegarde persistante : lien de téléchargement (optionnel) dans le banner.
          setResult({
            ok: true,
            msg: t('influxdb.actions.backup.result', {
              file: r.file,
              tables: Array.isArray(r.tables) ? r.tables.length : 0,
              rows: r.totalRows ?? 0,
            }),
            downloadFile: typeof r.file === 'string' ? r.file : undefined,
          });
        } else if (action === 'database/restore') {
          const rows = Array.isArray(r.tables)
            ? (r.tables as Array<{ written?: number }>).reduce((s, x) => s + (x.written ?? 0), 0)
            : 0;
          setResult({ ok: true, msg: t('influxdb.actions.restore.result', { db: r.db, rows }) });
        } else if (action === 'database/drop' && typeof r.backup === 'string') {
          // Drop avec sauvegarde préalable : la copie de sécurité est téléchargeable.
          setResult({
            ok: true,
            msg: t('influxdb.actions.done', { action }) + ` — ${JSON.stringify(r)}`,
            downloadFile: r.backup,
          });
        } else {
          setResult({ ok: true, msg: t('influxdb.actions.done', { action }) + (r && Object.keys(r).length ? ` — ${JSON.stringify(r)}` : '') });
        }
      }
      onAction();
    } catch (err) {
      const e = err as Error & { code?: string; status?: number };
      setResult({ ok: false, msg: t('influxdb.actions.error', { action, detail: e.message }) });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Ouvre l'étape de validation avant exécution (explication + impact + risque).
   * `whatKey`/`impactKey` : overrides des clés i18n (ex. drop-db avec sauvegarde).
   */
  const requestAction = (
    action: string,
    body?: Record<string, unknown>,
    details?: Array<{ k: string; v: string }>,
    whatParams?: Record<string, unknown>,
    whatKey?: string,
    impactKey?: string,
  ) => {
    const meta = ACTION_META[action];
    if (!meta) return;
    setResult(null);
    setPending({
      action,
      label: t(meta.labelKey),
      risk: meta.risk,
      what: t(whatKey ?? meta.whatKey, whatParams ?? {}),
      impact: t(impactKey ?? meta.impactKey, whatParams ?? {}),
      details,
      body,
    });
  };

  /** « Continuer » dans l'étape de validation → exécution. */
  const confirmPending = () => {
    if (!pending) return;
    const { action, body } = pending;
    setPending(null);
    void run(action, body);
  };

  const openDialog = (d: 'recreate' | 'drop-db' | 'drop-table' | 'backup' | 'restore') => {
    setResult(null);
    if (d === 'drop-db') setDropBackup(false);
    if (d === 'restore') void loadBackups();
    setDialog(d);
  };

  const loadBackups = async () => {
    setBackupsLoading(true);
    try {
      const r = await fetchInfluxBackups();
      setBackups(r.backups);
    } catch {
      setBackups([]);
    } finally {
      setBackupsLoading(false);
    }
  };

  /** « Continuer » du dialog paramètres → étape de validation (avec les valeurs saisies). */
  const confirm = () => {
    if (dialog === 'recreate') {
      const ret = retention || t('influxdb.actions.retention.infinite');
      requestAction(
        'database/recreate',
        { db, ...(retention ? { retention } : {}) },
        [
          { k: t('influxdb.actions.db'), v: db },
          { k: t('influxdb.actions.retention'), v: ret },
        ],
        { db, retention: ret },
      );
    } else if (dialog === 'drop-db') {
      const details: Array<{ k: string; v: string }> = [{ k: t('influxdb.actions.db'), v: db }];
      if (dropBackup) details.push({ k: t('influxdb.actions.dropDb.backupCheckbox'), v: '✓' });
      requestAction(
        'database/drop',
        { db, backup: dropBackup },
        details,
        { db },
        dropBackup ? 'influxdb.actions.dropDb.whatBackup' : undefined,
        dropBackup ? 'influxdb.actions.dropDb.impactBackup' : undefined,
      );
    } else if (dialog === 'backup') {
      requestAction('database/backup', { db }, [{ k: t('influxdb.actions.db'), v: db }], { db });
    } else if (dialog === 'restore') {
      const b = backups.find((x) => x.file === restoreFile);
      if (b) {
        requestAction(
          'database/restore',
          { file: b.file },
          [
            { k: t('influxdb.actions.backupFile'), v: b.file },
            { k: t('influxdb.actions.db'), v: b.db },
            { k: t('influxdb.actions.tables'), v: String(b.tables) },
            { k: t('influxdb.actions.rows'), v: String(b.rows) },
          ],
          { file: b.file, db: b.db, tables: b.tables, rows: b.rows },
        );
      }
    } else if (dialog === 'drop-table') {
      requestAction(
        'table/drop',
        { db, table },
        [
          { k: t('influxdb.actions.db'), v: db },
          { k: t('influxdb.actions.table'), v: table },
        ],
        { db, table },
      );
    } else if (dialog === 'export') {
      const from = Math.floor(new Date(expFrom).getTime() / 1000);
      const to = Math.floor(new Date(expTo).getTime() / 1000);
      if (Number.isFinite(from) && Number.isFinite(to) && from < to && expSelected.size > 0) {
        requestAction(
          'export',
          { tables: [...expSelected], from, to },
          [
            { k: t('influxdb.actions.tables'), v: String(expSelected.size) },
            { k: t('influxdb.actions.period'), v: `${expFrom} → ${expTo}` },
          ],
          { tables: expSelected.size, from: expFrom, to: expTo },
        );
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
          <Button variant="outline" size="sm" disabled={!enabled || busy !== null} onClick={() => requestAction('flush')}>
            <Zap className="mr-1 h-3.5 w-3.5" />
            {busy === 'flush' ? t('influxdb.actions.running') : t('influxdb.actions.flush')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => requestAction('archive/run')}>
            <Archive className="mr-1 h-3.5 w-3.5" />
            {busy === 'archive/run' ? t('influxdb.actions.running') : t('influxdb.actions.archiveRun')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => requestAction('archive/reset')}>
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            {busy === 'archive/reset' ? t('influxdb.actions.running') : t('influxdb.actions.archiveReset')}
          </Button>
          <Button variant="outline" size="sm" disabled={!enabled || busy !== null} onClick={openExport}>
            <Download className="mr-1 h-3.5 w-3.5" />
            {t('influxdb.actions.export')}
          </Button>
          <Button variant="outline" size="sm" disabled={!enabled || busy !== null} onClick={() => openDialog('backup')}>
            <DatabaseBackup className="mr-1 h-3.5 w-3.5" />
            {t('influxdb.actions.backup')}
          </Button>
          <Button variant="outline" size="sm" disabled={!enabled || busy !== null} onClick={() => openDialog('restore')}>
            <History className="mr-1 h-3.5 w-3.5" />
            {t('influxdb.actions.restore')}
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
            className={`mt-3 flex flex-wrap items-center gap-x-2 rounded-md border p-2 text-xs ${result.ok ? 'border-ok/30 bg-ok/10 text-ok' : 'border-crit/30 bg-crit/10 text-crit'}`}
          >
            <span>{result.msg}</span>
            {result.downloadFile && (
              <a href={influxDownloadUrl(result.downloadFile)} download className="underline hover:no-underline">
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
                {t('influxdb.actions.continue')}
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
            <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-secondary/50">
              <input
                type="checkbox"
                checked={dropBackup}
                onChange={(e) => setDropBackup(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              <span>{t('influxdb.actions.dropDb.backupCheckbox')}</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialog(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" disabled={!db || busy !== null} onClick={confirm}>
                {t('influxdb.actions.continue')}
              </Button>
            </div>
          </div>
        </Dialog>

        {/* Dialog sauvegarder une base (non destructif) — ZIP persistant sur le serveur */}
        <Dialog open={dialog === 'backup'} onClose={() => setDialog(null)} title={t('influxdb.actions.backup')}>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('influxdb.actions.backup.confirm')}</p>
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
                {t('influxdb.actions.continue')}
              </Button>
            </div>
          </div>
        </Dialog>

        {/* Dialog restaurer une base (attention) — réinjection line-protocol */}
        <Dialog open={dialog === 'restore'} onClose={() => setDialog(null)} title={t('influxdb.actions.restore')}>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('influxdb.actions.restore.confirm')}</p>
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">{t('influxdb.actions.backupFile')}</span>
              {backupsLoading ? (
                <p className="text-xs text-muted-foreground">{t('influxdb.actions.tablesLoading')}</p>
              ) : backups.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('influxdb.actions.backupsEmpty')}</p>
              ) : (
                <Select value={restoreFile} onChange={(e) => setRestoreFile(e.target.value)} className="w-full">
                  {backups.map((b) => (
                    <option key={b.file} value={b.file}>
                      {b.file} — {b.db} ({b.createdAt.slice(0, 16).replace('T', ' ')})
                    </option>
                  ))}
                </Select>
              )}
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialog(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" disabled={restoreFile === '' || busy !== null || backupsLoading} onClick={confirm}>
                {t('influxdb.actions.continue')}
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
                {t('influxdb.actions.continue')}
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
                {t('influxdb.actions.continue')}
              </Button>
            </div>
          </div>
        </Dialog>

        {/* Étape de validation avant exécution (toutes les actions) */}
        <Dialog
          open={pending !== null}
          onClose={() => setPending(null)}
          title={
            pending ? (
              <span className="flex items-center gap-2">
                <span className="truncate">{pending.label}</span>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${RISK_BADGE[pending.risk]}`}>
                  {t(`influxdb.actions.risk.${pending.risk}`)}
                </span>
              </span>
            ) : ''
          }
        >
          {pending && (
            <div className="space-y-3">
              <div>
                <span className="text-sm font-medium">{t('influxdb.actions.whatHappens')}</span>
                <p className="mt-1 text-sm text-muted-foreground">{pending.what}</p>
              </div>
              <div>
                <span className="text-sm font-medium">{t('influxdb.actions.impact')}</span>
                <p className="mt-1 text-sm text-muted-foreground">{pending.impact}</p>
              </div>
              {pending.details && pending.details.length > 0 && (
                <div className="space-y-1 rounded-md border p-2 text-xs">
                  {pending.details.map((d) => (
                    <div key={d.k}>
                      <span className="text-muted-foreground">{d.k} : </span>
                      <span className="font-mono">{d.v}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setPending(null)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  size="sm"
                  className={pending.risk === 'critical' ? 'border border-crit/50 bg-crit/10 text-crit hover:bg-crit/20' : undefined}
                  onClick={confirmPending}
                >
                  {t('influxdb.actions.continue')}
                </Button>
              </div>
            </div>
          )}
        </Dialog>
      </CardContent>
    </Card>
  );
}
