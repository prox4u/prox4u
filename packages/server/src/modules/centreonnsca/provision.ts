import { spawn } from 'node:child_process';
import {
  clapiProvisionCommands,
  shellQuote,
  type CentreonConfig,
  type CentreonPoller,
} from '@prox4u/shared';

/**
 * Provisioning Centreon — création du service passif + déploiement de config.
 * Deux transports, choisis dans la config du module (Page 3 admin) :
 *
 *  - **CLAPI** (centreon CLI) : local (Prox4u sur le central) ou SSH
 *    (Prox4u hors central — cas nominal). Le mot de passe est lu sur stdin
 *    (`-p "$(cat)"`) → jamais dans la ligne de commande (ps) ni dans les logs.
 *    Présume que l'hôte + la commande check_dummy existent déjà.
 *  - **REST** (HTTP `/api/latest/`, Centreon ≥ 22.10) : header `X-AUTH-TOKEN`
 *    (token d'API). L'API legacy `/api/restapi` (Basic auth) a été supprimée en
 *    26.10. Auto-provisionnement complet : crée l'hôte (si `hostAddress` fourni
 *    et absent), la commande `check_dummy` (si absente), le service passif
 *    (idempotent), puis génère + redéploie la config du poller.
 *
 * Robustesse : tout échec retourne { ok:false, message } — jamais d'exception.
 * Sécurité : le mot de passe / token n'est JAMAIS loggué (seul un message
 * générique + l'erreur brute du binaire/HTTP est renvoyée).
 */

export interface ProvisionResult {
  ok: boolean;
  message: string;
}

const TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// CLAPI
// ---------------------------------------------------------------------------

/**
 * Exécute UNE ligne CLAPI (ex. `SERVICE -a add -v "h;s"`). Le mot de passe est
 * injecté sur stdin via `-p "$(cat)"` → absent de l'argv (local) et du command
 * distant (SSH) : invisible par `ps`, jamais loggué.
 */
function runClapiLine(cfg: CentreonConfig, line: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    // `-u` est shell-quoté (clapiUser vient de la config) ; `-p "$(cat)"` reste en
    // double quotes pour que le shell lit le mot de passe sur stdin (jamais dans l'argv).
    // `line` contient déjà des arguments shell-quotés (clapiProvisionCommands).
    const centreon = `centreon -u ${shellQuote(cfg.clapiUser)} -p "$(cat)" ${line}`;
    let cmd: string;
    let args: string[];
    if (cfg.clapiMode === 'ssh') {
      cmd = 'ssh';
      args = [
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        `${cfg.clapiUser}@${cfg.clapiHost}`,
        centreon,
      ];
    } else {
      cmd = 'sh';
      args = ['-c', centreon];
    }
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, message: `timeout CLAPI (${TIMEOUT_MS / 1000} s)` });
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        message: cfg.clapiMode === 'ssh'
          ? `SSH vers ${cfg.clapiUser}@${cfg.clapiHost} impossible : ${e.message} (clé SSH configurée ?)`
          : `centreon CLI indisponible : ${e.message}`,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, message: out.trim() || 'ok' });
      else resolve({ ok: false, message: (err.trim() || out.trim() || `exit ${code}`).slice(0, 400) });
    });
    // mot de passe sur stdin (lu par `$(cat)`), jamais dans l'argv.
    child.stdin.write(cfg.clapiPassword);
    child.stdin.end();
  });
}

/** Provisionne via CLAPI : add + setparams + POLLERGENERATE + CFGMOVE. */
async function provisionClapi(cfg: CentreonConfig, host: string, service: string, poller: CentreonPoller): Promise<ProvisionResult> {
  if (!cfg.clapiHost || !cfg.clapiUser) return { ok: false, message: 'CLAPI : hôte et utilisateur non configurés' };
  const commands = clapiProvisionCommands(host, service, poller.name);
  for (const line of commands) {
    const r = await runClapiLine(cfg, line);
    if (!r.ok) return { ok: false, message: `CLAPI « ${line.split(' -v ')[0]} » : ${r.message}` };
  }
  return { ok: true, message: `service créé, config générée et déployée sur le poller « ${poller.name} » (CLAPI ${cfg.clapiMode})` };
}

// ---------------------------------------------------------------------------
// REST — nouvelle API `/api/latest/` (Centreon ≥ 22.10), header X-AUTH-TOKEN
// ---------------------------------------------------------------------------

/** Commande standard des checks passifs (créée si absente sur un central neuf). */
const CHECK_DUMMY_COMMAND_LINE = '/usr/lib/centreon/plugin-scripts/check_dummy.pl $ARG1$ $ARG2$';

/** Appelle l'API REST de Centreon (`/api/latest/`, auth par header X-AUTH-TOKEN). */
async function rest(cfg: CentreonConfig, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${cfg.restUrl.replace(/\/$/, '')}/api/latest${path}`, {
    method,
    headers: {
      'X-AUTH-TOKEN': cfg.restToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // le corps peut contenir un détail d'erreur (jamais de token)
    throw new Error(`REST ${method} ${path} → HTTP ${res.status} : ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Poller cible = « monitoring server » de l'API nouvelle. Matching : nom du
 * poller de la config, sinon son IP (= address du monitoring server), sinon le
 * serveur unique (central seul).
 */
async function findPollerId(cfg: CentreonConfig, poller: CentreonPoller): Promise<number> {
  const data = (await rest(cfg, 'GET', '/configuration/monitoring-servers')) as {
    result?: Array<{ id: number; name: string; address?: string | null }>;
  };
  const servers = data.result ?? [];
  let found = servers.find((s) => s.name === poller.name);
  if (!found && poller.ip) found = servers.find((s) => s.address === poller.ip);
  if (!found && servers.length === 1) found = servers[0];
  if (!found) throw new Error(`poller « ${poller.name} » introuvable dans l'API REST (monitoring-servers)`);
  return found.id;
}

/**
 * Hôte Centreon : recherche par nom ; si absent, création automatique sur le
 * poller cible. Adresse = IP de la VM/nœud Proxmox si connue (`hostAddress`),
 * sinon le nom de l'hôte (pour un check PASSIF l'adresse n'est pas
 * fonctionnellement utilisée — l'hôte reste créable même sans IP).
 */
async function findHostId(cfg: CentreonConfig, host: string, pollerId: number, hostAddress?: string): Promise<number> {
  const data = (await rest(cfg, 'GET', `/configuration/hosts?name=${encodeURIComponent(host)}`)) as {
    result?: Array<{ id: number; name: string }>;
  };
  const found = (data.result ?? []).find((h) => h.name === host);
  if (found) return found.id;
  const created = (await rest(cfg, 'POST', '/configuration/hosts', {
    name: host,
    address: hostAddress ?? host,
    monitoring_server_id: pollerId,
  })) as { id?: number };
  if (!created?.id) throw new Error('POST /configuration/hosts n\'a pas renvoyé d\'id');
  return created.id;
}

/**
 * Commande de check : recherche par nom ; `check_dummy` est créée si absente.
 * NB : l'API renvoie un tableau JSON brut avec `Accept: application/json`
 * (notre header) et un document Hydra `{ member: [...] }` sans — les deux
 * formats sont gérés.
 */
async function findCommandId(cfg: CentreonConfig, name: string): Promise<number> {
  const data = (await rest(cfg, 'GET', '/configuration/commands')) as
    | Array<{ id: number; name: string }>
    | { member?: Array<{ id: number; name: string }> };
  const list = Array.isArray(data) ? data : (data.member ?? []);
  const found = list.find((c) => c.name === name);
  if (found) return found.id;
  const created = (await rest(cfg, 'POST', '/configuration/commands', {
    name,
    command_line: CHECK_DUMMY_COMMAND_LINE,
    type: 'Check',
    is_shell_enabled: false,
  })) as { id?: number };
  if (!created?.id) throw new Error(`commande « ${name} » introuvable et création impossible`);
  return created.id;
}

/**
 * Provisionne via l'API `/api/latest/` : poller → hôte (auto-créé si IP fournie)
 * → check_dummy (auto-créée si absente) → service passif (idempotent) →
 * génération + redéploiement de la config du poller.
 */
async function provisionRest(cfg: CentreonConfig, host: string, service: string, poller: CentreonPoller, hostAddress?: string): Promise<ProvisionResult> {
  if (!cfg.restUrl) return { ok: false, message: 'REST : URL de l\'API non configurée' };
  if (!cfg.restToken) return { ok: false, message: 'REST : token d\'API non configuré (CENTREON_REST_TOKEN ou Page 3)' };
  const pollerId = await findPollerId(cfg, poller);
  const hostId = await findHostId(cfg, host, pollerId, hostAddress);
  const commandId = await findCommandId(cfg, 'check_dummy');
  // Service : idempotent — existant (même nom sur l'hôte) → on le met à jour ;
  // absent → création. (POST en double renvoie 409.)
  let serviceId: number | undefined;
  const existing = (await rest(cfg, 'GET', `/configuration/services?host_id=${hostId}&name=${encodeURIComponent(service)}`)) as {
    result?: Array<{ id: number; name: string }>;
  };
  const foundSvc = (existing.result ?? []).find((s) => s.name === service);
  if (foundSvc) {
    serviceId = foundSvc.id;
  } else {
    const created = (await rest(cfg, 'POST', '/configuration/services', {
      name: service,
      host_id: hostId,
      check_command_id: commandId,
    })) as { id?: number };
    if (!created?.id) throw new Error('POST /configuration/services n\'a pas renvoyé d\'id');
    serviceId = created.id;
  }
  await rest(cfg, 'PATCH', `/configuration/services/${serviceId}`, {
    passive_check_enabled: 1,
    active_check_enabled: 0,
    max_check_attempts: 1,
    volatility_enabled: 1,
  });
  await rest(cfg, 'GET', `/configuration/monitoring-servers/${pollerId}/generate`);
  await rest(cfg, 'GET', `/configuration/monitoring-servers/${pollerId}/reload`);
  return { ok: true, message: `service passif en place sur « ${host} », config générée et déployée sur le poller « ${poller.name} » (REST /api/latest)` };
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

/**
 * Provisionne le service passif de la règle selon le transport configuré.
 * `hostAddress` (IP de la VM/nœud Proxmox) permet au transport REST de créer
 * l'hôte Centreon s'il est absent. Toute erreur est capturée et renvoyée
 * (règle conservée, statut « erreur »).
 */
export async function provisionService(
  cfg: CentreonConfig,
  host: string,
  service: string,
  poller: CentreonPoller,
  hostAddress?: string,
): Promise<ProvisionResult> {
  try {
    if (cfg.transport === 'clapi') return await provisionClapi(cfg, host, service, poller);
    return await provisionRest(cfg, host, service, poller, hostAddress);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
