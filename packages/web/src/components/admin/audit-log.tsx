import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Download, ScrollText } from 'lucide-react';
import { ADMIN_AUDIT_ACTIONS, type AdminAuditEntry } from '@prox4u/shared';
import { adminApi } from '../../lib/auth-api';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/input';

const PAGE_SIZE = 50;

/**
 * Journal d'audit des actions d'administration (complément issue #2).
 * Lecture seule : liste paginée (de la plus récente à la plus ancienne) des
 * actions admin tracées (users, groupes, catalogue, reset mdp, import/export),
 * avec filtres action/acteur et export CSV de la vue filtrée.
 */
export function AuditLog() {
  const { t, i18n } = useTranslation();
  const [entries, setEntries] = useState<AdminAuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (nextOffset: number) => {
      setLoading(true);
      setError(null);
      try {
        const page = await adminApi.auditLog({ limit: PAGE_SIZE, offset: nextOffset, action: action || undefined, actor: actor || undefined });
        setEntries(page.entries);
        setTotal(page.total);
        setOffset(nextOffset);
      } catch {
        setError(t('admin.error.generic'));
      } finally {
        setLoading(false);
      }
    },
    [action, actor, t],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  function pageStart() {
    return total === 0 ? 0 : offset + 1;
  }
  function pageEnd() {
    return Math.min(offset + PAGE_SIZE, total);
  }

  async function exportCsv() {
    try {
      // Export de la vue filtrée complète (pas seulement la page affichée).
      const all = await adminApi.auditLog({ limit: 10_000, offset: 0, action: action || undefined, actor: actor || undefined });
      const header = ['date', 'actor', 'action', 'target', 'details'];
      const rows = all.entries.map((e) => [e.t, e.actor.username, e.action, e.target ?? '', JSON.stringify(e.details ?? {})]);
      const csv = [header, ...rows]
        .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
        .join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `admin-audit-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(t('admin.error.generic'));
    }
  }

  function fmtDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'short', timeStyle: 'medium' });
    } catch {
      return iso;
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{t('admin.audit.hint')}</p>

      {/* Filtres + export */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('admin.audit.filter.action')}</label>
          <Select value={action} onChange={(e) => setAction(e.target.value)} className="w-52">
            <option value="">{t('admin.audit.filter.all')}</option>
            {ADMIN_AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t(`admin.audit.action.${a}`)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('admin.audit.filter.actor')}</label>
          <Input value={actor} onChange={(e) => setActor(e.target.value)} placeholder={t('admin.audit.filter.actorPlaceholder')} className="w-44" />
        </div>
        <Button variant="outline" size="sm" onClick={() => void load(0)}>
          {t('admin.audit.filter.apply')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void exportCsv()} className="ml-auto">
          <Download className="h-3.5 w-3.5" />
          {t('admin.audit.export')}
        </Button>
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-crit/30 bg-crit/10 px-3 py-2 text-xs text-crit">
          {error}
        </p>
      )}

      {/* Tableau */}
      {loading ? (
        <div className="rounded-xl border border-dashed px-4 py-10 text-center text-xs text-muted-foreground">…</div>
      ) : entries.length === 0 ? (
        <p className="flex items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
          <ScrollText className="h-4 w-4" />
          {t('admin.audit.empty')}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-secondary/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('admin.audit.col.date')}</th>
                  <th className="px-3 py-2 font-medium">{t('admin.audit.col.actor')}</th>
                  <th className="px-3 py-2 font-medium">{t('admin.audit.col.action')}</th>
                  <th className="px-3 py-2 font-medium">{t('admin.audit.col.target')}</th>
                  <th className="px-3 py-2 font-medium">{t('admin.audit.col.details')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {entries.map((e, i) => (
                  <tr key={`${e.t}-${i}`} className="align-top">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{fmtDate(e.t)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs font-medium">{e.actor.username}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">{t(`admin.audit.action.${e.action}`, { defaultValue: e.action })}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{e.target ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {e.details ? <code className="break-all">{JSON.stringify(e.details)}</code> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {pageStart()}–{pageEnd()} / {total}
            </span>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" disabled={offset === 0 || loading} onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}>
                <ChevronLeft className="h-3.5 w-3.5" />
                {t('admin.audit.prev')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + PAGE_SIZE >= total || loading}
                onClick={() => void load(offset + PAGE_SIZE)}
              >
                {t('admin.audit.next')}
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
