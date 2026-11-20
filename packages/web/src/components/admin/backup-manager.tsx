import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Upload } from 'lucide-react';
import { parseBackupBundle, type BackupBundle } from '@prox4u/shared';
import { adminApi } from '../../lib/auth-api';
import { Button } from '../ui/button';

/**
 * Sauvegarde / restauration (complément issue #2) : export d'un bundle JSON
 * (users + groupes + état du catalogue + configs de graphiques par user) et
 * import par FUSION (username/nom — les comptes locaux absents du bundle sont
 * conservés). Le bundle contient les hashes argon2id → sensible (admin only).
 */
export function BackupManager() {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  /** Bundle lu depuis le fichier, en attente de confirmation d'import. */
  const [pending, setPending] = useState<BackupBundle | null>(null);

  async function doExport() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const bundle = await adminApi.exportBackup();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `prox4u-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setResult(
        t('admin.backup.export.result', {
          users: bundle.auth.users.length,
          groups: bundle.auth.groups.length,
        }),
      );
    } catch {
      setError(t('admin.error.generic'));
    } finally {
      setBusy(false);
    }
  }

  function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // permet de re-sélectionner le même fichier
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setError(null);
      setResult(null);
      try {
        const parsed: unknown = JSON.parse(String(reader.result));
        const bundle = parseBackupBundle(parsed);
        if (!bundle) {
          setError(t('admin.backup.import.badBundle'));
          return;
        }
        setPending(bundle);
      } catch {
        setError(t('admin.backup.import.badBundle'));
      }
    };
    reader.readAsText(file);
  }

  async function doImport() {
    if (busy || !pending) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminApi.importBackup(pending);
      setPending(null);
      setResult(
        t('admin.backup.import.result', {
          usersCreated: res.usersCreated,
          usersUpdated: res.usersUpdated,
          groupsCreated: res.groupsCreated,
          groupsUpdated: res.groupsUpdated,
          userConfigs: res.userConfigsRestored,
        }),
      );
    } catch {
      setError(t('admin.error.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{t('admin.backup.hint')}</p>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="default" size="sm" disabled={busy} onClick={() => void doExport()}>
          <Download className="h-3.5 w-3.5" />
          {t('admin.backup.export')}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          <Upload className="h-3.5 w-3.5" />
          {t('admin.backup.import')}
        </Button>
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onFileSelected} />
      </div>

      {/* Confirmation d'import */}
      {pending && (
        <div className="flex flex-col gap-2 rounded-xl border border-warn/40 bg-warn/10 p-3">
          <p className="text-xs">
            {t('admin.backup.import.confirm', {
              users: pending.auth.users.length,
              groups: pending.auth.groups.length,
              date: pending.exportedAt ? new Date(pending.exportedAt).toLocaleString() : '—',
            })}
          </p>
          <div className="flex gap-2">
            <Button variant="default" size="sm" disabled={busy} onClick={() => void doImport()}>
              {t('admin.backup.import.confirmYes')}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setPending(null)}>
              {t('admin.backup.import.confirmNo')}
            </Button>
          </div>
        </div>
      )}

      {result && (
        <p role="status" className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok">
          {result}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-crit/30 bg-crit/10 px-3 py-2 text-xs text-crit">
          {error}
        </p>
      )}
    </div>
  );
}
