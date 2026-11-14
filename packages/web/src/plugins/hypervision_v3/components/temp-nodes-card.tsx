import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { NodeSensorsResponse, SensorReading, SensorThresholds, SmartDevice } from '@prox4u/shared';
import { effectiveSensorThreshold, tempTone } from '@prox4u/shared';
import { Skeleton } from '../../../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '../../../components/ui/table';

/**
 * Vue d'ensemble v3 — carte « Températures » par nœud : la PLUS HAUTE température
 * du nœud, d'une part sur les capteurs lm-sensors (chips CPU/GPU/NIC/NVMe),
 * d'autre part sur les disques SMART. Coloration :
 *  - capteurs : seuil effectif par capteur (perso ≤ firmware, repli 80/60 °C —
 *    helper partagé tempTone) ; le pire ton gagne (un capteur critique colore la
 *    cellule, même si le max provient d'un autre capteur) ;
 *  - disques : seuil critique 80 °C / avertissement 60 °C (convention page
 *    Capteurs nœuds — les disques n'ont pas de seuils personnalisés).
 * Le nombre de capteurs / de disques lus s'affiche en discret après la valeur.
 * Source : GET /api/node-sensors (live — agent hôte Telegraf, cache 1 min).
 * 0 °C SMART = pas de capteur (smartTempDisplay) → exclu du max.
 */
type Tone = 'ok' | 'warn' | 'crit';
const TONE_CLS: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', crit: 'text-crit' };
const TONE_RANK: Record<Tone, number> = { ok: 0, warn: 1, crit: 2 };

/** Max + pire ton des capteurs d'UN nœud (tempInput non nul uniquement). */
function nodeChipsMax(
  sensors: SensorReading[],
  node: string,
  thresholds: SensorThresholds,
): { maxTemp: number | null; tone: Tone | null; count: number } {
  let maxTemp: number | null = null;
  let worst: Tone | null = null;
  let count = 0;
  for (const s of sensors) {
    if (s.node !== node || s.tempInput == null) continue;
    count += 1;
    if (maxTemp == null || s.tempInput > maxTemp) maxTemp = s.tempInput;
    const effective = effectiveSensorThreshold(s, thresholds);
    const tone = tempTone(s.tempInput, effective);
    if (tone !== 'na' && (worst == null || TONE_RANK[tone] > TONE_RANK[worst])) worst = tone;
  }
  return { maxTemp, tone: worst, count };
}

/** Max + ton des disques SMART d'UN nœud (temp_c > 0 uniquement). */
function nodeDisksMax(devices: SmartDevice[], node: string): { maxTemp: number | null; tone: Tone | null; count: number } {
  let maxTemp: number | null = null;
  let count = 0;
  for (const d of devices) {
    if (d.node !== node || !d.tempC || d.tempC <= 0) continue;
    count += 1;
    if (maxTemp == null || d.tempC > maxTemp) maxTemp = d.tempC;
  }
  const tone: Tone | null = maxTemp == null ? null : maxTemp >= 80 ? 'crit' : maxTemp >= 60 ? 'warn' : 'ok';
  return { maxTemp, tone, count };
}

/**
 * Corps de la carte « Températures — par nœud » (tableau seul) — grille
 * personnalisable v3. Nœuds sans capteur : « — » (jamais de valeur inventée).
 */
export function TempNodesBody({ data, loading }: { data: NodeSensorsResponse | null; loading: boolean }) {
  const { t } = useTranslation();

  // Une ligne par nœud connu (data.nodes) — les nœuds sans mesure ont des « — ».
  const rows = useMemo(() => {
    if (!data) return [];
    return [...data.nodes].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((node) => ({
      node,
      chips: nodeChipsMax(data.sensors, node, data.sensorThresholds),
      disks: nodeDisksMax(data.smart, node),
    }));
  }, [data]);

  const hasAnyTemp = rows.some((r) => r.chips.maxTemp != null || r.disks.maxTemp != null);

  return (
    <div className="h-full overflow-x-auto">
      {loading && rows.length === 0 ? (
        <Skeleton className="m-2 h-32 w-full" />
      ) : rows.length === 0 || !hasAnyTemp ? (
        <div className="px-3 py-8 text-center text-xs text-muted-foreground">{t('overview.tempNodes.none')}</div>
      ) : (
        <Table>
          <TableHeader>
            <tr>
              <TableHead>{t('topbar.nodes')}</TableHead>
              <TableHead>{t('overview.tempNodes.chips')}</TableHead>
              <TableHead>{t('overview.tempNodes.disks')}</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <tr key={r.node}>
                <TableCell className="font-medium">{r.node}</TableCell>
                <TableCell className="tabular-nums">
                  {r.chips.maxTemp != null ? (
                    <span className={r.chips.tone ? TONE_CLS[r.chips.tone] : 'text-foreground'}>
                      {r.chips.maxTemp} °C
                      <span className="ml-1.5 text-[10px] text-muted-foreground" title={t('overview.tempNodes.count', { n: r.chips.count })}>
                        · {r.chips.count}
                      </span>
                    </span>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="tabular-nums">
                  {r.disks.maxTemp != null ? (
                    <span className={r.disks.tone ? TONE_CLS[r.disks.tone] : 'text-foreground'}>
                      {r.disks.maxTemp} °C
                      <span className="ml-1.5 text-[10px] text-muted-foreground" title={t('overview.tempNodes.count', { n: r.disks.count })}>
                        · {r.disks.count}
                      </span>
                    </span>
                  ) : (
                    '—'
                  )}
                </TableCell>
              </tr>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
