#!/usr/bin/env node
/**
 * Calculateur de dimensionnement InfluxDB 3 Core (P3, GitHub #19).
 *
 * À partir du parc (VMs / nœuds / datastores / endpoints) + le tick du poller,
 * recommande la config InfluxDB 3 Core (file, flush, rétention, query-file-limit)
 * + la justification. Fonction pure (packages/shared) — zéro dépendance.
 *
 * Usage :
 *   node scripts/influx-sizing.mjs --vms 500 --nodes 10 [--tick 60] \
 *     [--datastores 5] [--endpoints 1] \
 *     [--queue-max 20000] [--flush-max-lines 1000] [--query-file-limit 10000]
 *
 * Les options --queue-max / --flush-max-lines / --query-file-limit sont la config
 * ACTUELLE (optionnelle) — le script signale les valeurs sous-dimensionnées.
 */
import { computeInfluxSizing } from '../packages/shared/dist/index.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

const args = parseArgs(process.argv);

if (args.help || args.h) {
  console.log(
    [
      'Calculateur de dimensionnement InfluxDB 3 Core (prox4u)',
      '',
      'Usage :',
      '  node scripts/influx-sizing.mjs --vms <n> --nodes <n> [--tick <s>] \\',
      '    [--datastores <n>] [--endpoints <n>] \\',
      '    [--queue-max <n>] [--flush-max-lines <n>] [--query-file-limit <n>]',
      '',
      'Options parc (requis) :',
      '  --vms            Nombre de VMs (QEMU + LXC), tous endpoints confondus.',
      '  --nodes          Nombre de nœuds Proxmox, tous endpoints confondus.',
      'Options parc (optionnel) :',
      '  --tick           Tick du poller en secondes (défaut 60).',
      '  --datastores     Nombre de datastores (défaut 0).',
      '  --endpoints      Nombre d’endpoints/clusters (défaut 1).',
      'Config actuelle (optionnel — détection sous-dimensionnement) :',
      '  --queue-max            INFLUX_QUEUE_MAX (défaut 20000).',
      '  --flush-max-lines      INFLUX_FLUSH_MAX_LINES (défaut 1000).',
      '  --query-file-limit     INFLUX_QUERY_FILE_LIMIT (défaut 10000).',
      '',
      'Exemple :',
      '  node scripts/influx-sizing.mjs --vms 500 --nodes 10 --tick 60 \\',
      '    --queue-max 20000 --flush-max-lines 1000',
    ].join('\n'),
  );
  process.exit(0);
}

if (args.vms === undefined || args.nodes === undefined) {
  console.error('Erreur : --vms et --nodes sont requis (voir --help).');
  process.exit(1);
}

const current = {};
if (args['queue-max'] !== undefined) current.queueMax = num(args['queue-max'], 0);
if (args['flush-max-lines'] !== undefined) current.flushMaxLines = num(args['flush-max-lines'], 0);
if (args['query-file-limit'] !== undefined) current.queryFileLimit = num(args['query-file-limit'], 0);

const r = computeInfluxSizing({
  vms: num(args.vms, 0),
  nodes: num(args.nodes, 0),
  tickSeconds: num(args.tick, 60),
  datastores: num(args.datastores, 0),
  endpoints: num(args.endpoints, 1),
  current: Object.keys(current).length > 0 ? current : undefined,
});

console.log('=== Dimensionnement InfluxDB 3 Core (prox4u) ===\n');
console.log('Parc :', `${r.linesPerTick} lignes/tick`);
console.log('  →', `${r.linesPerMinute} lignes/min · ${r.linesPerDay} lignes/j`);
console.log('');
console.log('Config recommandée :');
console.log('  INFLUX_QUEUE_MAX        =', r.queueMax);
console.log('  INFLUX_FLUSH_MAX_LINES  =', r.flushMaxLines);
console.log('  INFLUX_FLUSH_DELAY_MS   =', r.flushDelayMs);
console.log('  INFLUX_QUERY_FILE_LIMIT =', r.queryFileLimit, `(~${r.maxQueryWindowDays} j sans chunking)`);
console.log('  INFLUX_QUERY_CHUNK_DAYS =', r.chunkDays, `(${r.chunkFiles} fichiers/chunk, headroom ${r.fileHeadroom})`);
console.log('  Rétention raw           =', r.rawRetention);
console.log('  Rétention consolidated  =', r.consolidatedRetention);
console.log('');
console.log('Justification :');
for (const j of r.justification) console.log('  •', j);
if (r.warnings.length > 0) {
  console.log('');
  console.log('⚠ Config actuelle sous-dimensionnée :');
  for (const w of r.warnings) console.log('  •', w);
} else if (Object.keys(current).length > 0) {
  console.log('');
  console.log('✓ Config actuelle suffisante.');
}
