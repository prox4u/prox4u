import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { suggestCenteronHost, type CentreonConfig, type CentreonPoller, type VmMapping } from '@prox4u/shared';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/input';
import { alarmsApi, type CentreonEnvSecrets } from '../../plugins/centreon-nsca/lib/nsca-api';

interface Props {
  onDone: () => void;
}

/**
 * Page 3 — Configuration du module Centreon (NSCA). Onglet de la page
 * Administration (Catalogue des modules / Groupes / Utilisateurs / Centreon).
 *
 * - Activer/désactiver le module (l'engine n'agit que si actif).
 * - Transport de provisioning : CLAPI (SSH/local) ou API REST v1.
 * - Central : hôte CLAPI (ou URL REST) + identifiants (jamais loggués,
 *   masqués en •••••• à la relecture — « inchangé » si on les renvoie tels quels).
 * - Pollers : liste configurable (Linux, Windows, Infra… + ajout libre).
 * - Mapping VM → hôte Centreon (auto-suggestion + override manuel).
 */
export function NscaConfig({ onDone }: Props) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<CentreonConfig | null>(null);
  const [envSecrets, setEnvSecrets] = useState<CentreonEnvSecrets | null>(null);
  const [pollers, setPollers] = useState<CentreonPoller[]>([]);
  const [mappings, setMappings] = useState<VmMapping[]>([]);
  const [vms, setVms] = useState<import('../../plugins/centreon-nsca/lib/nsca-api').TargetVm[]>([]);
  const [newPollerName, setNewPollerName] = useState('');
  const [newPollerIp, setNewPollerIp] = useState('');
  const [newMapVm, setNewMapVm] = useState('');
  const [newMapHost, setNewMapHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function load() {
    try {
      const [data, targets] = await Promise.all([alarmsApi.config(), alarmsApi.targets()]);
      setConfig(data.config);
      setEnvSecrets(data.envSecrets);
      setPollers(data.pollers);
      setMappings(data.mappings);
      setVms(targets.vms);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Chargement au montage
  useEffect(() => { void load(); }, []);

  function setCfg(patch: Partial<CentreonConfig>) {
    setSaved(false);
    setConfig((c) => (c ? { ...c, ...patch } : c));
  }
  function setNsca(patch: Partial<CentreonConfig['nsca']>) {
    setSaved(false);
    setConfig((c) => (c ? { ...c, nsca: { ...c.nsca, ...patch } } : c));
  }
  /** Hint : le secret est fourni par le .env du serveur (prévalence sur la saisie). */
  function envHint(flag: boolean | undefined, envVar: string) {
    if (!flag) return null;
    return <span className="font-normal text-muted-foreground">{t('alarm.admin.envSecrets', { var: envVar })}</span>;
  }
  function addPoller() {
    const name = newPollerName.trim();
    if (!name) return;
    setSaved(false);
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const ip = newPollerIp.trim();
    if (!pollers.some((p) => p.id === id)) setPollers((p) => [...p, { id, name, ...(ip ? { ip } : {}) }]);
    setNewPollerName('');
    setNewPollerIp('');
  }
  function setPollerIp(id: string, ip: string) {
    setSaved(false);
    setPollers((p) => p.map((x) => (x.id === id ? { ...x, ip: ip.trim() || undefined } : x)));
  }
  function removePoller(id: string) {
    setSaved(false);
    setPollers((p) => p.filter((x) => x.id !== id));
  }
  function setMappingHost(key: string, host: string) {
    setSaved(false);
    setMappings((ms) => ms.map((m) => (mappingKey(m) === key ? { ...m, centreonHost: host } : m)));
  }
  /** Sélection d'une VM → propose le hôte (auto-suggestion) si non renseigné. */
  function onPickMapVm(value: string) {
    setNewMapVm(value);
    const vm = vms.find((v) => `${v.endpointId}/${v.vmid}` === value);
    if (vm) setNewMapHost((h) => h || suggestCenteronHost(vm.name));
  }
  function addMapping() {
    const vm = vms.find((v) => `${v.endpointId}/${v.vmid}` === newMapVm);
    const host = newMapHost.trim();
    if (!vm || !host) return;
    setSaved(false);
    const key = `${vm.endpointId}/${vm.vmid}`;
    if (!mappings.some((m) => mappingKey(m) === key)) {
      setMappings((ms) => [...ms, { endpointId: vm.endpointId, vmid: vm.vmid, vmName: vm.name, centreonHost: host }]);
    }
    setNewMapVm('');
    setNewMapHost('');
  }
  function removeMapping(key: string) {
    setSaved(false);
    setMappings((ms) => ms.filter((m) => mappingKey(m) !== key));
  }

  async function save() {
    if (!config) return;
    setBusy(true);
    setError(null);
    try {
      await alarmsApi.saveConfig({ config, pollers, mappings });
      setSaved(true);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!config) {
    return <div className="rounded-xl border border-dashed px-4 py-10 text-center text-xs text-muted-foreground">…</div>;
  }

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      {error && (
        <p role="alert" className="rounded-lg border border-crit/30 bg-crit/10 px-3 py-2 text-xs text-crit">
          {t('alarm.admin.error', { msg: error })}
        </p>
      )}
      {saved && (
        <p role="status" className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok">{t('alarm.admin.saved')}</p>
      )}

      {/* Activation + transport */}
      <section className="space-y-3">
        <label className="flex items-center gap-2 text-xs font-medium">
          <input type="checkbox" checked={config.enabled} onChange={(e) => setCfg({ enabled: e.target.checked })} className="h-4 w-4 rounded border" />
          {t('alarm.admin.enabled')}
          <span className="font-normal text-muted-foreground">— {t('alarm.admin.enabled.hint')}</span>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t('alarm.admin.transport')}
          <Select value={config.transport} onChange={(e) => setCfg({ transport: e.target.value as 'clapi' | 'rest' })}>
            <option value="clapi">{t('alarm.admin.transport.clapi')}</option>
            <option value="rest">{t('alarm.admin.transport.rest')}</option>
          </Select>
        </label>
      </section>

      {/* Central — CLAPI */}
      {config.transport === 'clapi' && (
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="text-sm font-semibold">{t('alarm.admin.central')} — CLAPI</h3>
          <label className="flex flex-col gap-1 text-xs font-medium">
            {t('alarm.admin.clapiMode')}
            <Select value={config.clapiMode} onChange={(e) => setCfg({ clapiMode: e.target.value as 'ssh' | 'local' })}>
              <option value="ssh">{t('alarm.admin.clapiMode.ssh')}</option>
              <option value="local">{t('alarm.admin.clapiMode.local')}</option>
            </Select>
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs font-medium">
              {t('alarm.admin.clapiHost')}
              <Input value={config.clapiHost} onChange={(e) => setCfg({ clapiHost: e.target.value })} placeholder="central.example" />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium">
              {t('alarm.admin.clapiUser')}
              <Input value={config.clapiUser} onChange={(e) => setCfg({ clapiUser: e.target.value })} placeholder="clapi" />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium sm:col-span-2">
              {t('alarm.admin.clapiPassword')}
              <Input
                type="password"
                value={config.clapiPassword}
                onChange={(e) => setCfg({ clapiPassword: e.target.value })}
                placeholder={config.clapiPassword ? '' : '••••••'}
                autoComplete="new-password"
              />
              <span className="font-normal text-muted-foreground">{t('alarm.admin.clapiPassword.hint')}</span>
              {envHint(envSecrets?.clapiPassword, 'CENTREON_CLAPI_PASSWORD')}
            </label>
          </div>
        </section>
      )}

      {/* Central — REST v1 */}
      {config.transport === 'rest' && (
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="text-sm font-semibold">{t('alarm.admin.central')} — REST v1</h3>
          <label className="flex flex-col gap-1 text-xs font-medium">
            {t('alarm.admin.restUrl')}
            <Input value={config.restUrl} onChange={(e) => setCfg({ restUrl: e.target.value })} placeholder="https://central:8080" />
            <span className="font-normal text-muted-foreground">{t('alarm.admin.restUrl.hint')}</span>
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs font-medium">
              {t('alarm.admin.restUser')}
              <Input value={config.restUser} onChange={(e) => setCfg({ restUser: e.target.value })} placeholder="api" />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium">
              {t('alarm.admin.restToken')}
              <Input
                type="password"
                value={config.restToken}
                onChange={(e) => setCfg({ restToken: e.target.value })}
                placeholder={config.restToken ? '' : '••••••'}
                autoComplete="new-password"
              />
              <span className="font-normal text-muted-foreground">{t('alarm.admin.restToken.hint')}</span>
              {envHint(envSecrets?.restToken, 'CENTREON_REST_TOKEN')}
            </label>
          </div>
        </section>
      )}

      {/* Serveur NSCA */}
      <section className="space-y-3 rounded-xl border p-4">
        <h3 className="text-sm font-semibold">{t('alarm.admin.nsca')}</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs font-medium sm:col-span-2">
            {t('alarm.admin.nsca.host')}
            <Input value={config.nsca.server} onChange={(e) => setNsca({ server: e.target.value })} placeholder="central.example" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            {t('alarm.admin.nsca.port')}
            <Input type="number" value={config.nsca.port} onChange={(e) => setNsca({ port: Number(e.target.value) })} />
          </label>
          <label className="flex items-end gap-2 pb-2 text-xs font-medium">
            <input type="checkbox" checked={config.nsca.encrypt} onChange={(e) => setNsca({ encrypt: e.target.checked })} className="h-4 w-4 rounded border" />
            {t('alarm.admin.nsca.encrypt')}
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium sm:col-span-2">
            {t('alarm.admin.nsca.password')}
            <Input
              type="password"
              value={config.nsca.password}
              onChange={(e) => setNsca({ password: e.target.value })}
              placeholder={config.nsca.password ? '' : '••••••'}
              autoComplete="new-password"
            />
            {envHint(envSecrets?.nscaPassword, 'CENTREON_NSCA_PASSWORD')}
          </label>
        </div>
      </section>

      {/* Trames périodiques (heartbeat OK services + check hôte) */}
      <section className="space-y-3 rounded-xl border p-4">
        <h3 className="text-sm font-semibold">{t('alarm.admin.frames')}</h3>
        <p className="text-xs text-muted-foreground">{t('alarm.admin.frames.hint')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium">
            {t('alarm.admin.okHeartbeat')}
            <Input
              type="number"
              min={0}
              value={config.okHeartbeatSeconds}
              onChange={(e) => setCfg({ okHeartbeatSeconds: Math.max(0, Number(e.target.value)) })}
            />
            <span className="font-normal text-muted-foreground">{t('alarm.admin.okHeartbeat.hint')}</span>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            {t('alarm.admin.hostCheck')}
            <Input
              type="number"
              min={0}
              value={config.hostCheckSeconds}
              onChange={(e) => setCfg({ hostCheckSeconds: Math.max(0, Number(e.target.value)) })}
            />
            <span className="font-normal text-muted-foreground">{t('alarm.admin.hostCheck.hint')}</span>
          </label>
        </div>
      </section>

      {/* Pollers — deux entrées : nom + IP (IP = destination NSCA du poller) */}
      <section className="space-y-3 rounded-xl border p-4">
        <h3 className="text-sm font-semibold">{t('alarm.admin.pollers')}</h3>
        <p className="text-xs text-muted-foreground">{t('alarm.admin.pollers.hint')}</p>
        <div className="flex flex-col gap-2">
          {pollers.map((p) => (
            <div key={p.id} className="flex items-center gap-2 text-xs">
              <span className="w-32 truncate font-medium" title={p.name}>{p.name}</span>
              <Input value={p.ip ?? ''} onChange={(e) => setPollerIp(p.id, e.target.value)} placeholder={t('alarm.admin.poller.ip')} className="flex-1 font-mono" />
              <span className="hidden text-muted-foreground sm:inline">({p.id})</span>
              <Button variant="ghost" size="sm" onClick={() => removePoller(p.id)} title={t('alarm.admin.poller.delete')}>
                <Trash2 className="h-3.5 w-3.5 text-crit" />
              </Button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input value={newPollerName} onChange={(e) => setNewPollerName(e.target.value)} placeholder={t('alarm.admin.poller.name')} className="flex-1" />
          <Input value={newPollerIp} onChange={(e) => setNewPollerIp(e.target.value)} placeholder={t('alarm.admin.poller.ip')} className="flex-1 font-mono" />
          <Button variant="outline" size="md" onClick={addPoller}>
            <Plus className="h-3.5 w-3.5" /> {t('alarm.admin.poller.add')}
          </Button>
        </div>
      </section>

      {/* Mappings VM → hôte Centreon (+ bouton Ajouter pour d'autres correspondances) */}
      <section className="space-y-3 rounded-xl border p-4">
        <h3 className="text-sm font-semibold">{t('alarm.admin.mappings')}</h3>
        <p className="text-xs text-muted-foreground">{t('alarm.admin.mappings.hint')}</p>
        <div className="flex flex-col gap-2">
          {mappings.length === 0 && <p className="text-xs text-muted-foreground">—</p>}
          {mappings.map((m) => {
            const key = mappingKey(m);
            return (
              <div key={key} className="flex items-center gap-2 text-xs">
                <span className="w-40 truncate font-medium" title={`${m.vmName} (#${m.vmid})`}>{m.vmName}</span>
                <span className="text-muted-foreground">→</span>
                <Input value={m.centreonHost} onChange={(e) => setMappingHost(key, e.target.value)} className="flex-1" />
                <Button variant="ghost" size="sm" onClick={() => removeMapping(key)} title={t('alarm.admin.mapping.delete')}>
                  <Trash2 className="h-3.5 w-3.5 text-crit" />
                </Button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2 border-t pt-3">
          <Select value={newMapVm} onChange={(e) => onPickMapVm(e.target.value)} className="w-48">
            <option value="">{t('alarm.admin.mapping.vm')}</option>
            {vms.map((v) => (
              <option key={`${v.endpointId}/${v.vmid}`} value={`${v.endpointId}/${v.vmid}`}>
                {v.name} (#{v.vmid} — {v.endpointId})
              </option>
            ))}
          </Select>
          <Input value={newMapHost} onChange={(e) => setNewMapHost(e.target.value)} placeholder={t('alarm.admin.mapping.host')} className="flex-1" />
          <Button variant="outline" size="md" onClick={addMapping} disabled={!newMapVm || !newMapHost.trim()}>
            <Plus className="h-3.5 w-3.5" /> {t('alarm.admin.mapping.add')}
          </Button>
        </div>
      </section>

      <Button variant="default" onClick={() => void save()} disabled={busy}>
        {busy ? '…' : t('alarm.admin.save')}
      </Button>
    </div>
  );
}

function mappingKey(m: VmMapping): string {
  return `${m.endpointId}/${m.vmid}`;
}
