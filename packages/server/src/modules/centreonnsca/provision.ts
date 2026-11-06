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
 *  - **REST v1** (HTTP /api/restapi) : Basic auth (user + token d'API).
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
// REST v1
// ---------------------------------------------------------------------------

/** Appelle l'API REST v1 de Centreon (Basic auth user + token d'API). */
async function rest(cfg: CentreonConfig, method: string, path: string, body?: unknown): Promise<unknown> {
  const token = Buffer.from(`${cfg.restUser}:${cfg.restToken}`).toString('base64');
  const res = await fetch(`${cfg.restUrl.replace(/\/$/, '')}/api/restapi${path}`, {
    method,
    headers: {
      Authorization: `Basic ${token}`,
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

async function findHostId(cfg: CentreonConfig, host: string): Promise<number> {
  const data = (await rest(cfg, 'GET', '/host?output=host_id,host_name')) as { objects?: Array<{ host_id: number; host_name: string }> };
  const found = (data.objects ?? []).find((o) => o.host_name === host);
  if (!found) throw new Error(`hôte Centreon « ${host} » introuvable dans l'API REST (à créer avant le service)`);
  return found.host_id;
}

async function findCommandId(cfg: CentreonConfig, name: string): Promise<number> {
  const data = (await rest(cfg, 'GET', `/command?search=${encodeURIComponent(name)}`)) as { objects?: Array<{ command_id: number; command_name: string }> };
  const found = (data.objects ?? []).find((o) => o.command_name === name);
  if (!found) throw new Error(`commande « ${name} » introuvable dans l'API REST`);
  return found.command_id;
}

async function findPollerId(cfg: CentreonConfig, pollerName: string): Promise<number> {
  const data = (await rest(cfg, 'GET', '/instance/poller')) as { objects?: Array<{ poller_id: number; instance_name?: string; poller_name?: string }> };
  const found = (data.objects ?? []).find((o) => o.instance_name === pollerName || o.poller_name === pollerName);
  if (!found) throw new Error(`poller « ${pollerName} » introuvable dans l'API REST`);
  return found.poller_id;
}

/** Provisionne via REST v1 : service + params + génération/déploiement poller. */
async function provisionRest(cfg: CentreonConfig, host: string, service: string, poller: CentreonPoller): Promise<ProvisionResult> {
  if (!cfg.restUrl) return { ok: false, message: 'REST : URL de l\'API non configurée' };
  const hostId = await findHostId(cfg, host);
  const commandId = await findCommandId(cfg, 'check_dummy');
  const created = (await rest(cfg, 'POST', '/service', {
    host_id: hostId,
    name: service,
    command_id: commandId,
  })) as { service_id?: number };
  if (!created.service_id) throw new Error('POST /service n\'a pas renvoyé de service_id');
  await rest(cfg, 'PUT', `/service/${created.service_id}`, {
    passive_checks_enabled: 1,
    active_checks_enabled: 0,
    is_volatile: 1,
    max_check_attempts: 1,
  });
  const pollerId = await findPollerId(cfg, poller.name);
  await rest(cfg, 'POST', `/instance/poller/${pollerId}/config/generate`, {});
  await rest(cfg, 'POST', `/instance/poller/${pollerId}/config/move`, {});
  return { ok: true, message: `service créé, config générée et déployée sur le poller « ${poller.name} » (REST v1)` };
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

/**
 * Provisionne le service passif de la règle selon le transport configuré.
 * Toute erreur est capturée et renvoyée (règle conservée, statut « erreur »).
 */
export async function provisionService(
  cfg: CentreonConfig,
  host: string,
  service: string,
  poller: CentreonPoller,
): Promise<ProvisionResult> {
  try {
    if (cfg.transport === 'clapi') return await provisionClapi(cfg, host, service, poller);
    return await provisionRest(cfg, host, service, poller);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
