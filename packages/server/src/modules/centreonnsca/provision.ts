import { spawn } from 'node:child_process';
import {
  clapiDeleteCommands,
  clapiDeleteHostCommands,
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
  /**
   * true si le provisioning a CRÉÉ l'hôte Centreon (transport REST, hôte absent
   * + IP fournie). Le caller enregistre alors l'hôte dans `managedHosts`
   * (éligible à la suppression orpheline). false si l'hôte préexistait (ou
   * transport CLAPI qui présume l'hôte existant).
   */
  hostCreated?: boolean;
}

/**
 * Résultat de la SUPPRESSION d'un service Centreon (GitHub #20) :
 *  - `deleted`   : service supprimé + config poller régénérée/déployée ;
 *  - `not-found` : service absent de Centreon (rien à supprimer — idempotent) ;
 *  - `error`     : échec (central injoignable, HTTP, CLAPI) → la règle Prox4u
 *                  reste en « suppression en attente » (réessai automatique).
 */
export interface DeleteServiceResult {
  status: 'deleted' | 'not-found' | 'error';
  message: string;
}

/**
 * Résultat de la SUPPRESSION d'un hôte Centreon (orphelin) :
 *  - `deleted`   : hôte supprimé + config poller régénérée/déployée ;
 *  - `not-found` : hôte absent de Centreon (rien à supprimer — idempotent) ;
 *  - `error`     : échec (central injoignable, HTTP, CLAPI) → réessai
 *                  (suppression en attente de la règle, ou balayage suivant).
 */
export interface DeleteHostResult {
  status: 'deleted' | 'not-found' | 'error';
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
  // CLAPI présume que l'hôte existe déjà (pas d'auto-création) → jamais créé.
  return { ok: true, hostCreated: false, message: `service créé, config générée et déployée sur le poller « ${poller.name} » (CLAPI ${cfg.clapiMode})` };
}

/** Indicateurs d'« inconnu/absent » dans les messages d'erreur CLAPI (heuristic). */
const CLAPI_NOT_FOUND_RE = /not\s+(found|exist)|doesn'?t\s+exist|no\s+such|unknown|introuvable|absent|inexistant/i;

/**
 * Supprime le service via CLAPI : `SERVICE -a del` + POLLERGENERATE + CFGMOVE
 * (clapiDeleteCommands). Si la ligne `del` échoue avec un message d'« absent »
 * → `not-found` (idempotent) ; sinon `error` (réessai).
 */
async function deleteClapi(cfg: CentreonConfig, host: string, service: string, poller: CentreonPoller): Promise<DeleteServiceResult> {
  if (!cfg.clapiHost || !cfg.clapiUser) return { status: 'error', message: 'CLAPI : hôte et utilisateur non configurés' };
  const commands = clapiDeleteCommands(host, service, poller.name);
  for (const line of commands) {
    const r = await runClapiLine(cfg, line);
    if (!r.ok) {
      // `SERVICE -a del` sur un service absent renvoie une erreur → idempotent.
      if (line.startsWith('SERVICE -a del') && CLAPI_NOT_FOUND_RE.test(r.message)) {
        return { status: 'not-found', message: `service « ${service} » absent de Centreon (CLAPI — suppression idempotente)` };
      }
      return { status: 'error', message: `CLAPI « ${line.split(' -v ')[0]} » : ${r.message}` };
    }
  }
  return { status: 'deleted', message: `service « ${service} » supprimé, config régénérée et déployée sur le poller « ${poller.name} » (CLAPI ${cfg.clapiMode})` };
}

/**
 * Supprime l'HÔTE via CLAPI : `HOST -a del` + POLLERGENERATE + CFGMOVE
 * (clapiDeleteHostCommands). Si la ligne `del` échoue avec un message
 * d'« absent » → `not-found` (idempotent) ; sinon `error` (réessai).
 */
async function deleteHostClapi(cfg: CentreonConfig, host: string, poller: CentreonPoller): Promise<DeleteHostResult> {
  if (!cfg.clapiHost || !cfg.clapiUser) return { status: 'error', message: 'CLAPI : hôte et utilisateur non configurés' };
  const commands = clapiDeleteHostCommands(host, poller.name);
  for (const line of commands) {
    const r = await runClapiLine(cfg, line);
    if (!r.ok) {
      // `HOST -a del` sur un hôte absent renvoie une erreur → idempotent.
      if (line.startsWith('HOST -a del') && CLAPI_NOT_FOUND_RE.test(r.message)) {
        return { status: 'not-found', message: `hôte « ${host} » absent de Centreon (CLAPI — suppression idempotente)` };
      }
      return { status: 'error', message: `CLAPI « ${line.split(' -v ')[0]} » : ${r.message}` };
    }
  }
  return { status: 'deleted', message: `hôte « ${host} » supprimé, config régénérée et déployée sur le poller « ${poller.name} » (CLAPI ${cfg.clapiMode})` };
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
async function findHostId(cfg: CentreonConfig, host: string, pollerId: number, hostAddress?: string): Promise<{ id: number; created: boolean }> {
  // NB : `filter[name]` (match exact) est le SEUL paramètre de filtre
  // fonctionnel de l'API (`?name=` est ignoré → liste tronquée à la 1ʳᵉ page).
  const data = (await rest(cfg, 'GET', `/configuration/hosts?filter[name]=${encodeURIComponent(host)}`)) as {
    result?: Array<{ id: number; name: string }>;
  };
  const found = (data.result ?? []).find((h) => h.name === host);
  if (found) return { id: found.id, created: false };
  const created = (await rest(cfg, 'POST', '/configuration/hosts', {
    name: host,
    address: hostAddress ?? host,
    monitoring_server_id: pollerId,
  })) as { id?: number };
  if (!created?.id) throw new Error('POST /configuration/hosts n\'a pas renvoyé d\'id');
  return { id: created.id, created: true };
}

/**
 * Recherche l'hôte par nom SANS création → id, ou null si absent (REST).
 * Sert au comptage de services et à la suppression d'orphelin.
 */
async function findHostIdRest(cfg: CentreonConfig, host: string): Promise<number | null> {
  const data = (await rest(cfg, 'GET', `/configuration/hosts?filter[name]=${encodeURIComponent(host)}`)) as {
    result?: Array<{ id: number; name: string }>;
  };
  const found = (data.result ?? []).find((h) => h.name === host);
  return found ? found.id : null;
}

/**
 * Nombre de services d'un hôte Centreon (REST) — garde-fou « 0 service
 * restant » de la suppression d'orphelin. L'API ne filtre PAS par hôte
 * (`filter[host_id]` → 500 « paramètre non autorisé ») → on liste les services
 * (pagination, limite 10/page imposée) et on compte côté client ceux dont le
 * tableau `hosts` contient l'hôte. `stopAt` permet de s'arrêter dès qu'un
 * service est trouvé (le garde-fou n'a besoin que de 0 vs >0).
 */
async function countHostServicesRest(cfg: CentreonConfig, hostId: number, stopAt = Infinity): Promise<number> {
  let count = 0;
  let page = 1;
  const PAGE_LIMIT = 10; // limite de page imposée par l'API (page_size ignoré)
  const MAX_PAGES = 100; // garde anti-boucle (1000 services)
  for (;;) {
    const data = (await rest(cfg, 'GET', `/configuration/services?page=${page}`)) as {
      result?: Array<{ hosts?: Array<{ id: number }> }>;
      meta?: { total?: number };
    };
    const items = data.result ?? [];
    for (const s of items) {
      if ((s.hosts ?? []).some((h) => h.id === hostId)) {
        count += 1;
        if (count >= stopAt) return count;
      }
    }
    const total = data.meta?.total ?? items.length;
    if (items.length === 0 || page * PAGE_LIMIT >= total || page >= MAX_PAGES) break;
    page += 1;
  }
  return count;
}

/**
 * Nombre de services d'un hôte (tous transports) pour le garde-fou orphelin :
 *  - REST : comptage réel (hôte absent → 0) ;
 *  - CLAPI : `null` (inconnu) → le garde-fou conserve l'hôte (conservatif).
 *    (En pratique `managedHosts` n'est rempli qu'en REST — CLAPI présume
 *    l'hôte existant — donc ce cas est rare.)
 */
export async function countHostServices(cfg: CentreonConfig, host: string): Promise<number | null> {
  if (cfg.transport === 'clapi') return null;
  if (!cfg.restUrl || !cfg.restToken) return null;
  try {
    const hostId = await findHostIdRest(cfg, host);
    if (hostId === null) return 0; // hôte absent → aucun service
    return await countHostServicesRest(cfg, hostId);
  } catch {
    return null; // central injoignable → inconnu (conservatif)
  }
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
  const { id: hostId, created: hostCreated } = await findHostId(cfg, host, pollerId, hostAddress);
  const commandId = await findCommandId(cfg, 'check_dummy');
  // Service : idempotent — existant (même nom sur l'hôte) → on le met à jour ;
  // absent → création. (POST en double renvoie 409.)
  // NB : `filter[name]` (match exact) est le SEUL paramètre de filtre fonctionnel
  // de l'API (`name`/`host_id` sont ignorés) → évite la troncature de page.
  let serviceId: number | undefined;
  const existing = (await rest(cfg, 'GET', `/configuration/services?filter[name]=${encodeURIComponent(service)}`)) as {
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
  return { ok: true, hostCreated, message: `service passif en place sur « ${host} », config générée et déployée sur le poller « ${poller.name} » (REST /api/latest)` };
}

/**
 * Supprime le service via l'API `/api/latest/` : recherche par nom (les noms
 * auto-générés `Prox4u-Alarm-…` sont uniques) → absent = `not-found`
 * (idempotent, pas de generate/reload) ; présent → DELETE + régénération/
 * redéploiement de la config du poller. Toute exception (réseau/HTTP) = `error`.
 */
async function deleteRest(cfg: CentreonConfig, host: string, service: string, poller: CentreonPoller): Promise<DeleteServiceResult> {
  if (!cfg.restUrl) return { status: 'error', message: 'REST : URL de l\'API non configurée' };
  if (!cfg.restToken) return { status: 'error', message: 'REST : token d\'API non configuré (CENTREON_REST_TOKEN ou Page 3)' };
  // NB : le paramètre `name` est IGNORÉ par l'API Centreon — seul `filter[name]`
  // (match exact) filtre côté serveur. Sans filtre, la liste peut être tronquée
  // (page par défaut) et le service introuvable → faux « not-found ».
  const data = (await rest(cfg, 'GET', `/configuration/services?filter[name]=${encodeURIComponent(service)}`)) as {
    result?: Array<{ id: number; name: string }>;
  };
  const found = (data.result ?? []).find((s) => s.name === service);
  if (!found) return { status: 'not-found', message: `service « ${service} » absent de Centreon (rien à supprimer sur l'hôte « ${host} »)` };
  await rest(cfg, 'DELETE', `/configuration/services/${found.id}`);
  const pollerId = await findPollerId(cfg, poller);
  await rest(cfg, 'GET', `/configuration/monitoring-servers/${pollerId}/generate`);
  await rest(cfg, 'GET', `/configuration/monitoring-servers/${pollerId}/reload`);
  return { status: 'deleted', message: `service « ${service} » supprimé de Centreon, config régénérée et déployée sur le poller « ${poller.name} » (REST /api/latest)` };
}

/**
 * Supprime l'HÔTE via l'API `/api/latest/` (orphelin) : recherche par nom
 * (`filter[name]`, match exact) → absent = `not-found` (idempotent, pas de
 * generate/reload) ; présent → DELETE + régénération/redéploiement de la
 * config du poller. Toute exception (réseau/HTTP) = `error`.
 */
async function deleteHostRest(cfg: CentreonConfig, host: string, poller: CentreonPoller): Promise<DeleteHostResult> {
  if (!cfg.restUrl) return { status: 'error', message: 'REST : URL de l\'API non configurée' };
  if (!cfg.restToken) return { status: 'error', message: 'REST : token d\'API non configuré (CENTREON_REST_TOKEN ou Page 3)' };
  const hostId = await findHostIdRest(cfg, host);
  if (hostId === null) return { status: 'not-found', message: `hôte « ${host} » absent de Centreon (rien à supprimer)` };
  await rest(cfg, 'DELETE', `/configuration/hosts/${hostId}`);
  const pollerId = await findPollerId(cfg, poller);
  await rest(cfg, 'GET', `/configuration/monitoring-servers/${pollerId}/generate`);
  await rest(cfg, 'GET', `/configuration/monitoring-servers/${pollerId}/reload`);
  return { status: 'deleted', message: `hôte « ${host} » supprimé de Centreon, config régénérée et déployée sur le poller « ${poller.name} » (REST /api/latest)` };
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

/**
 * Supprime le service Centreon de la règle selon le transport configuré
 * (GitHub #20 — cohérence Prox4u ↔ Centreon). `deleted`/`not-found` = la règle
 * Prox4u peut être retirée ; `error` = central injoignable/échec → la règle
 * reste en « suppression en attente » (réessai automatique par l'engine).
 * Toute exception est capturée (jamais de throw).
 */
export async function deleteCenteronService(
  cfg: CentreonConfig,
  host: string,
  service: string,
  poller: CentreonPoller,
): Promise<DeleteServiceResult> {
  try {
    if (cfg.transport === 'clapi') return await deleteClapi(cfg, host, service, poller);
    return await deleteRest(cfg, host, service, poller);
  } catch (err) {
    return { status: 'error', message: (err as Error).message };
  }
}

/**
 * Supprime l'HÔTE Centreon (orphelin) selon le transport configuré. N'est
 * appelé que si les 3 garde-fous sont passés (hôte dans `managedHosts` +
 * aucune règle ne le cible + 0 service restant). `deleted`/`not-found` =
 * l'hôte est retiré de Centreon ; `error` = central injoignable/échec →
 * réessai (suppression en attente de la règle, ou balayage suivant).
 * Toute exception est capturée (jamais de throw).
 */
export async function deleteCenteronHost(
  cfg: CentreonConfig,
  host: string,
  poller: CentreonPoller,
): Promise<DeleteHostResult> {
  try {
    if (cfg.transport === 'clapi') return await deleteHostClapi(cfg, host, poller);
    return await deleteHostRest(cfg, host, poller);
  } catch (err) {
    return { status: 'error', message: (err as Error).message };
  }
}
