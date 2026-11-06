import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { nscaCfgContent, type NscaConfig } from '@prox4u/shared';

/**
 * Exécution de send_nsca : l'app génère le fichier `send_nsca.cfg` à partir de
 * la config du module (serveur, port, encrypt, mot de passe) puis lance
 * `send_nsca -H <server> -c <cfg>` avec la trame sur stdin.
 *
 * Robustesse : tout échec (binaire absent, timeout, réseau, code non zéro)
 * retourne { ok:false, message } — jamais d'exception vers l'appelant.
 * Sécurité : le mot de passe figure dans le fichier cfg (chmod 600) et n'est
 * JAMAIS loggué (seul le message d'erreur brut est renvoyé).
 */

export interface NscaSendResult {
  ok: boolean;
  /** return code NSCA de la trame (0/1/2/3) si ok, null sinon. */
  code: number | null;
  /** message lisible (jamais de mot de passe). */
  message: string;
}

const TIMEOUT_MS = 20_000;

/**
 * Chemin du binaire send_nsca. Détection : PATH d'abord, sinon les emplacements
 * usuels (/usr/sbin, /usr/bin). Configurable via l'env SEND_NSCA_BIN.
 */
function resolveSendNscaBin(): string {
  if (process.env.SEND_NSCA_BIN) return process.env.SEND_NSCA_BIN;
  const candidates = ['send_nsca', '/usr/sbin/send_nsca', '/usr/bin/send_nsca'];
  for (const c of candidates) {
    if (c.includes('/') && existsSync(c)) return c;
    if (which(c)) return c;
  }
  return 'send_nsca';
}

function which(bin: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const d of dirs) {
    const p = path.join(d, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Cache de la détection du support de `encrypt` par le binaire installé.
 * null = pas encore testé, true/false = résultat de la sonde.
 */
let encryptSupport: boolean | null = null;

/**
 * Détermine si le binaire send_nsca installé accepte la variable `encrypt`
 * dans le cfg. Sonde : on génère un cfg de test contenant `encrypt = 1` et on
 * le fait parser par le binaire (connexion forcément en échec — on n'est pas
 * sur un vrai daemon). Si l'erreur est « Unknown variable name `encrypt' » →
 * non supporté ; sinon (erreur de socket/connexion) → le cfg a été accepté.
 * Le résultat est mis en cache (une seule sonde par processus).
 */
export function probeEncryptSupport(dir: string, bin = resolveSendNscaBin()): Promise<boolean> {
  if (encryptSupport !== null) return Promise.resolve(encryptSupport);
  return new Promise((resolve) => {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'probe.cfg');
    writeFileSync(file, 'server = 127.0.0.1\nport = 1\nencrypt = 1\npassword = x\ntimeout = 1\n');
    const child = spawn(bin, ['-H', '127.0.0.1', '-c', file], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      // timeout sans message d'erreur cfg → le cfg a été parsé (supporté)
      encryptSupport = true;
      resolve(true);
    }, 5000);
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      encryptSupport = false; // binaire absent → on n'émet pas encrypt (sans objet)
      resolve(false);
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const unsupported = /Unknown variable name `encrypt/i.test(err + out);
      encryptSupport = !unsupported;
      resolve(encryptSupport);
    });
    child.stdin.end();
  });
}

/** Écrit le fichier de config NSCA (chmod 600) et retourne son chemin. */
export async function writeNscaCfg(cfg: NscaConfig, dir: string, bin = resolveSendNscaBin()): Promise<string> {
  const encryptSupported = await probeEncryptSupport(dir, bin);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'send_nsca.cfg');
  writeFileSync(file, nscaCfgContent(cfg, { encryptSupported }));
  chmodSync(file, 0o600);
  return file;
}

/**
 * Envoie une trame NSCA. `frame` est la trame complète (host\tservice\tcode\toutput\n).
 * Le return code est déterminé par le code de sortie de send_nsca (0 = accepté).
 */
export async function sendNsca(cfg: NscaConfig, frame: string, cfgDir: string, sendNscaBin = resolveSendNscaBin()): Promise<NscaSendResult> {
  let cfgFile: string;
  try {
    cfgFile = await writeNscaCfg(cfg, cfgDir, sendNscaBin);
  } catch (err) {
    return { ok: false, code: null, message: `écriture send_nsca.cfg impossible : ${(err as Error).message}` };
  }
  return new Promise((resolve) => {
    const child = spawn(sendNscaBin, ['-H', cfg.server, '-c', cfgFile], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, code: null, message: `timeout send_nsca (${TIMEOUT_MS / 1000} s) — serveur NSCA injoignable ?` });
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, message: `send_nsca indisponible : ${err.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // send_nsca : exit 0 = trame acceptée par le daemon. Les détails de
      // succès/échec arrivent sur stdout/stderr (jamais de mot de passe).
      if (code === 0) {
        resolve({ ok: true, code: null, message: stdout.trim() || 'trame acceptée' });
      } else {
        const detail = (stderr.trim() || stdout.trim() || `exit ${code}`).slice(0, 400);
        resolve({ ok: false, code: null, message: detail });
      }
    });
    child.stdin.write(frame);
    child.stdin.end();
  });
}
