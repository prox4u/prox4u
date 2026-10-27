import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Plus, Trash2, Users } from 'lucide-react';
import type { PublicUser } from '@prox4u/shared';
import { adminApi, type AdminGroup } from '../../lib/auth-api';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

interface Props {
  groups: AdminGroup[];
  users: PublicUser[];
  moduleIds: string[];
  onDone: () => void;
}

/**
 * CRUD des groupes : création, édition (nom/description), membres et modules
 * autorisés. Pattern drill-down : la ligne du groupe se déplie pour l'édition.
 */
export function GroupManager({ groups, users, moduleIds, onDone }: Props) {
  const { t } = useTranslation();
  const [openId, setOpenId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createGroup() {
    if (busy || !newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.createGroup(newName.trim(), newDesc.trim());
      setNewName('');
      setNewDesc('');
      onDone();
    } catch (err) {
      setError(err instanceof Error && err.message.includes('group-name-exists') ? t('admin.groups.name') : t('admin.error.generic'));
    } finally {
      setBusy(false);
    }
  }

  async function deleteGroup(g: AdminGroup) {
    if (!window.confirm(t('admin.groups.delete.confirm', { name: g.name }))) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.deleteGroup(g.id);
      if (openId === g.id) setOpenId(null);
      onDone();
    } catch {
      setError(t('admin.error.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Création */}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-3">
        <div className="min-w-40 flex-1">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('admin.groups.name')}</label>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} />
        </div>
        <div className="min-w-40 flex-[2]">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('admin.groups.description')}</label>
          <Input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
        </div>
        <Button variant="default" size="sm" disabled={busy || !newName.trim()} onClick={() => void createGroup()}>
          <Plus className="h-3.5 w-3.5" />
          {t('admin.groups.create')}
        </Button>
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-crit/30 bg-crit/10 px-3 py-2 text-xs text-crit">
          {error}
        </p>
      )}

      {/* Liste */}
      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
          {t('admin.groups.empty')}
        </p>
      ) : (
        <div className="divide-y rounded-xl border">
          {groups.map((g) => (
            <GroupRow
              key={g.id}
              group={g}
              users={users}
              moduleIds={moduleIds}
              open={openId === g.id}
              busy={busy}
              onToggle={() => setOpenId(openId === g.id ? null : g.id)}
              onDelete={() => void deleteGroup(g)}
              onDone={onDone}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GroupRow({
  group,
  users,
  moduleIds,
  open,
  busy,
  onToggle,
  onDelete,
  onDone,
}: {
  group: AdminGroup;
  users: PublicUser[];
  moduleIds: string[];
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(group.name);
  const [desc, setDesc] = useState(group.description);
  const [memberIds, setMemberIds] = useState<string[]>(group.memberIds);
  const [moduleIdsSel, setModuleIdsSel] = useState<string[]>(group.moduleIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleIn(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await adminApi.updateGroup(group.id, { name: name.trim(), description: desc.trim() });
      await adminApi.setGroupMembers(group.id, memberIds);
      await adminApi.setGroupModules(group.id, moduleIdsSel);
      onDone();
    } catch {
      setError(t('admin.error.generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 px-4 py-3">
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`} />
          <Users className="h-4 w-4 shrink-0 text-primary" />
          <span className="truncate text-sm font-medium">{group.name}</span>
          {group.description && <span className="hidden truncate text-xs text-muted-foreground md:inline">— {group.description}</span>}
        </button>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {t('admin.groups.members.count', { n: group.memberIds.length })} · {t('admin.groups.modules.count', { n: group.moduleIds.length })}
        </span>
        <Button variant="ghost" size="sm" disabled={busy || saving} onClick={onDelete} title={t('admin.groups.delete')}>
          <Trash2 className="h-3.5 w-3.5 text-crit" />
        </Button>
      </div>

      {open && (
        <div className="flex flex-col gap-4 border-t bg-secondary/30 px-6 py-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-40 flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('admin.groups.name')}</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="min-w-40 flex-[2]">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('admin.groups.description')}</label>
              <Input value={desc} onChange={(e) => setDesc(e.target.value)} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t('admin.groups.members')}</div>
              <div className="max-h-56 divide-y overflow-y-auto rounded-xl border bg-card">
                {users.map((u) => (
                  <label key={u.id} className="flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-secondary/50">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-(--color-primary)"
                      checked={memberIds.includes(u.id)}
                      onChange={() => setMemberIds((cur) => toggleIn(cur, u.id))}
                    />
                    <span className="text-xs font-medium">{u.username}</span>
                    <span className="truncate text-[11px] text-muted-foreground">{u.displayName}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t('admin.groups.modules')}</div>
              <div className="max-h-56 divide-y overflow-y-auto rounded-xl border bg-card">
                {moduleIds.map((id) => (
                  <label key={id} className="flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-secondary/50">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-(--color-primary)"
                      checked={moduleIdsSel.includes(id)}
                      onChange={() => setModuleIdsSel((cur) => toggleIn(cur, id))}
                    />
                    <span className="text-xs font-medium">{id}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {error && (
            <p role="alert" className="rounded-lg border border-crit/30 bg-crit/10 px-3 py-2 text-xs text-crit">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <Button variant="default" size="sm" disabled={saving || busy} onClick={() => void save()}>
              {t('admin.groups.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
