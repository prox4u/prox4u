import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, KeyRound, Lock, LockOpen, Plus } from 'lucide-react';
import type { PublicUser, Role } from '@prox4u/shared';
import { adminApi, type AdminGroup } from '../../lib/auth-api';
import { useAuth } from '../../store/auth';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/input';

interface Props {
  users: PublicUser[];
  groups: AdminGroup[];
  onDone: () => void;
}

/**
 * Gestion des utilisateurs : création (mdp initial forçant le changement),
 * **verrouillage/déverrouillage** (cadenas — `active: false` : le login est
 * refusé en 403 `disabled` ET les sessions actives sont invalidées
 * immédiatement au prochain appel API), réinitialisation du mdp, affectation
 * aux groupes. Garde-fou anti-verrouillage : un admin ne peut pas se
 * verrouiller ni se dégrader lui-même (boutons désactivés + refus serveur).
 */
export function UserManager({ users, groups, onDone }: Props) {
  const { t } = useTranslation();
  const me = useAuth((s) => s.user);

  const [showCreate, setShowCreate] = useState(false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<{ username: string; password: string } | null>(null);

  async function createUser() {
    if (busy || !username.trim() || !displayName.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.createUser({
        username: username.trim(),
        displayName: displayName.trim(),
        password,
        role,
        groupIds,
      });
      setUsername('');
      setDisplayName('');
      setPassword('');
      setRole('user');
      setGroupIds([]);
      setShowCreate(false);
      onDone();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setError(msg.includes('username-exists') ? t('admin.users.error.exists') : t('admin.error.generic'));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(u: PublicUser) {
    if (busy) return;
    if (!window.confirm(t('admin.users.resetPassword.confirm', { username: u.username }))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminApi.resetPassword(u.id);
      setResetResult({ username: u.username, password: res.temporaryPassword });
      onDone();
    } catch {
      setError(t('admin.error.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Barre d'actions */}
      <div className="flex items-center justify-between">
        <Button variant={showCreate ? 'outline' : 'default'} size="sm" onClick={() => setShowCreate(!showCreate)}>
          <Plus className="h-3.5 w-3.5" />
          {t('admin.users.create')}
        </Button>
      </div>

      {/* Formulaire de création */}
      {showCreate && (
        <div className="flex flex-col gap-2 rounded-xl border bg-card p-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('admin.users.username')}</label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('admin.users.displayName')}</label>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('admin.users.password')}</label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('admin.users.role')}</label>
              <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="user">{t('role.user')}</option>
                <option value="admin">{t('role.admin')}</option>
              </Select>
            </div>
          </div>
          {groups.length > 0 && (
            <div className="flex flex-wrap gap-3">
              {groups.map((g) => (
                <label key={g.id} className="flex cursor-pointer items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-(--color-primary)"
                    checked={groupIds.includes(g.id)}
                    onChange={() =>
                      setGroupIds((cur) => (cur.includes(g.id) ? cur.filter((x) => x !== g.id) : [...cur, g.id]))
                    }
                  />
                  {g.name}
                </label>
              ))}
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="default" size="sm" disabled={busy || !username.trim() || !displayName.trim() || !password} onClick={() => void createUser()}>
              {t('admin.users.create')}
            </Button>
          </div>
        </div>
      )}

      {/* Résultat reset mdp */}
      {resetResult && (
        <p role="status" className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok">
          {t('admin.users.resetPassword.result', { password: resetResult.password })}{' '}
          <button type="button" className="underline" onClick={() => setResetResult(null)}>
            OK
          </button>
        </p>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-crit/30 bg-crit/10 px-3 py-2 text-xs text-crit">
          {error}
        </p>
      )}

      {/* Tableau */}
      {users.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">{t('admin.users.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-secondary/50 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('admin.users.username')}</th>
                <th className="px-3 py-2 font-medium">{t('admin.users.displayName')}</th>
                <th className="px-3 py-2 font-medium">{t('admin.users.role')}</th>
                <th className="px-3 py-2 font-medium">{t('admin.users.groups')}</th>
                <th className="px-3 py-2 font-medium">{t('admin.users.state')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('admin.users.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {users.map((u) => (
                <UserRow key={u.id} user={u} groups={groups} isSelf={me?.id === u.id} busy={busy} onDone={onDone} onReset={() => void resetPassword(u)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UserRow({
  user,
  groups,
  isSelf,
  busy,
  onDone,
  onReset,
}: {
  user: PublicUser;
  groups: AdminGroup[];
  isSelf: boolean;
  busy: boolean;
  onDone: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [groupIds, setGroupIds] = useState<string[]>(user.groupIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveGroups() {
    setSaving(true);
    setError(null);
    try {
      await adminApi.updateUser(user.id, { groupIds });
      onDone();
    } catch {
      setError(t('admin.error.generic'));
    } finally {
      setSaving(false);
    }
  }

  async function patch(patch: { active?: boolean; role?: Role }) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await adminApi.updateUser(user.id, patch);
      onDone();
    } catch (err) {
      setError(err instanceof Error && err.message.includes('self-modification') ? t('admin.users.error.self') : t('admin.error.generic'));
    } finally {
      setSaving(false);
    }
  }

  // Garde-fou anti-verrouillage (miroir du refus serveur) : un admin ne peut
  // pas se verrouiller ni se dégrader lui-même.
  const canDeactivate = !(isSelf && user.active);
  const canToggleRole = !(isSelf && user.role === 'admin');

  return (
    <>
      <tr className="align-middle">
        <td className="px-3 py-2 font-medium">{user.username}</td>
        <td className="px-3 py-2 text-muted-foreground">{user.displayName}</td>
        <td className="px-3 py-2">
          <Badge tone={user.role === 'admin' ? 'primary' : 'default'}>{t(`role.${user.role}`)}</Badge>
        </td>
        <td className="px-3 py-2 text-xs text-muted-foreground">
          {groups
            .filter((g) => user.groupIds.includes(g.id))
            .map((g) => g.name)
            .join(', ') || '—'}
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={user.active ? 'ok' : 'crit'}>{t(user.active ? 'admin.users.active' : 'admin.users.inactive')}</Badge>
            {user.mustChangePassword && (
              <span title={t('admin.users.mustChange')}>
                <KeyRound className="h-3.5 w-3.5 text-warn" />
              </span>
            )}
          </div>
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || saving || !canDeactivate}
              onClick={() => void patch({ active: !user.active })}
              title={t(user.active ? 'admin.users.deactivate' : 'admin.users.activate')}
            >
              {user.active ? <Lock className="h-3.5 w-3.5 text-warn" /> : <LockOpen className="h-3.5 w-3.5 text-ok" />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || saving || !canToggleRole}
              onClick={() => void patch({ role: user.role === 'admin' ? 'user' : 'admin' })}
              title={t('admin.users.role')}
            >
              <span className="text-[10px] font-semibold uppercase">{user.role === 'admin' ? '↓' : '↑'}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || saving || user.provider !== 'local'}
              onClick={onReset}
              title={t('admin.users.resetPassword')}
            >
              <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
            <Button variant="ghost" size="sm" disabled={busy || saving} onClick={() => setOpen(!open)} title={t('admin.users.groups')}>
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
            </Button>
          </div>
          {error && <p role="alert" className="mt-1 text-right text-[11px] text-crit">{error}</p>}
        </td>
      </tr>
      {open && (
        <tr className="bg-secondary/30">
          <td colSpan={6} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-medium text-muted-foreground">{t('admin.users.groups')} :</span>
              {groups.length === 0 ? (
                <span className="text-xs text-muted-foreground">—</span>
              ) : (
                groups.map((g) => (
                  <label key={g.id} className="flex cursor-pointer items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-(--color-primary)"
                      checked={groupIds.includes(g.id)}
                      onChange={() =>
                        setGroupIds((cur) => (cur.includes(g.id) ? cur.filter((x) => x !== g.id) : [...cur, g.id]))
                      }
                    />
                    {g.name}
                  </label>
                ))
              )}
              <Button variant="default" size="sm" disabled={saving || busy} onClick={() => void saveGroups()}>
                {t('admin.groups.save')}
              </Button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
