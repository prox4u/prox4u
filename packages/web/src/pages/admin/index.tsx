import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Boxes, ScrollText, Siren, Thermometer, Users, UserCog } from 'lucide-react';
import { parsePluginVersion } from '@prox4u/shared';
import { adminApi, type AdminState } from '../../lib/auth-api';
import { registry } from '../../core/plugin/registry';
import { AuditLog } from '../../components/admin/audit-log';
import { BackupManager } from '../../components/admin/backup-manager';
import { ModuleCatalog } from '../../components/admin/module-catalog';
import { GroupManager } from '../../components/admin/group-manager';
import { NscaConfig } from '../../components/admin/nsca-config';
import { SensorThresholds } from '../../components/admin/sensor-thresholds';
import { UserManager } from '../../components/admin/user-manager';

type Tab = 'catalog' | 'groups' | 'users' | 'nsca' | 'sensorThresholds' | 'audit' | 'backup';

/**
 * Page d'administration (rôle admin uniquement — protégée par ProtectedRoute).
 * Trois onglets : catalogue global des modules (une entrée par version, avec
 * activation), groupes, utilisateurs.
 */
export function AdminPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('catalog');
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await adminApi.state());
      setError(null);
    } catch {
      setError(t('admin.error.generic'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold tracking-tight">{t('admin.title')}</h1>

      <div className="flex gap-1 self-start rounded-xl border bg-card p-1">
        {(
          [
            { id: 'catalog', label: t('admin.tab.catalog'), icon: Boxes },
            { id: 'groups', label: t('admin.tab.groups'), icon: Users },
            { id: 'users', label: t('admin.tab.users'), icon: UserCog },
            { id: 'nsca', label: t('admin.tab.nsca'), icon: Siren },
            { id: 'sensorThresholds', label: t('admin.tab.sensorThresholds'), icon: Thermometer },
            { id: 'audit', label: t('admin.tab.audit'), icon: ScrollText },
            { id: 'backup', label: t('admin.tab.backup'), icon: Archive },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-crit/30 bg-crit/10 px-3 py-2 text-xs text-crit">
          {error}
        </p>
      )}

      {!state ? (
        <div className="rounded-xl border border-dashed px-4 py-10 text-center text-xs text-muted-foreground">…</div>
      ) : tab === 'catalog' ? (
        <ModuleCatalog
          modules={state.modules}
          plugins={registry.list()}
          onDone={() => void load()}
        />
      ) : tab === 'nsca' ? (
        <NscaConfig onDone={() => void load()} />
      ) : tab === 'sensorThresholds' ? (
        <SensorThresholds onDone={() => void load()} />
      ) : tab === 'groups' ? (
        // Les groupes autorisent des FAMILLES entières (pas des versions) —
        // une entrée par famille (id + nom) pour l'affichage lisible.
        <GroupManager
          groups={state.groups}
          users={state.users}
          modules={[
            ...new Map(
              state.modules.map((m) => {
                const family = parsePluginVersion(m.id).family;
                return [family, { id: family, name: m.name }];
              }),
            ).values(),
          ]}
          onDone={() => void load()}
        />
      ) : tab === 'audit' ? (
        // Journal d'audit : autonome (chargement propre), ne dépend pas de AdminState.
        <AuditLog />
      ) : tab === 'backup' ? (
        // Sauvegarde : autonome (export/import), ne dépend pas de AdminState.
        <BackupManager />
      ) : (
        <UserManager users={state.users} groups={state.groups} onDone={() => void load()} />
      )}
    </div>
  );
}
