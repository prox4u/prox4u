import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw, Save, Thermometer, Trash2 } from 'lucide-react';
import { sensorKey, tempTone, type SensorThresholdEntry } from '@prox4u/shared';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { sensorThresholdsApi } from '../../plugins/node-sensors/lib/sensor-thresholds-api';

interface Props {
  onDone: () => void;
}

/** Couleur d'un badge de température selon le ton (ok/warn/crit/na). */
function toneClass(tone: 'ok' | 'warn' | 'crit' | 'na'): string {
  switch (tone) {
    case 'crit': return 'bg-crit/15 text-crit';
    case 'warn': return 'bg-warn/15 text-warn';
    case 'ok': return 'bg-ok/15 text-ok';
    default: return 'bg-muted text-muted-foreground';
  }
}

/**
 * Onglet Administration « Seuils capteurs » (module node-sensors).
 *
 * - Un seuil personnalisé PAR CAPTEUR (clé `node/chip/feature`), en °C.
 * - Baisser uniquement : le seuil perso ne peut pas dépasser le seuil firmware
 *   (clamping côté input `max` ET côté serveur au PUT).
 * - Firmware toujours affiché (lecture seule) ; vide = fallback firmware.
 * - Sauvegarde explicite (bouton « Enregistrer ») + reset par ligne + tout.
 */
export function SensorThresholds({ onDone }: Props) {
  const { t } = useTranslation();
  const [sensors, setSensors] = useState<SensorThresholdEntry[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /** Synchronise l'état local depuis une réponse serveur. */
  const apply = useCallback((res: { sensors: SensorThresholdEntry[] }) => {
    setSensors(res.sensors);
    const next: Record<string, string> = {};
    for (const s of res.sensors) {
      const key = sensorKey(s);
      next[key] = s.custom !== null ? String(s.custom) : '';
    }
    setDraft(next);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await sensorThresholdsApi.list());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [apply]);

  useEffect(() => { void load(); }, [load]);

  function setDraftValue(key: string, val: string) {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: val }));
  }

  async function save() {
    // Ne remonter que les valeurs saisies (non vides) et valides (> 0).
    const thresholds: Record<string, number> = {};
    for (const [key, raw] of Object.entries(draft)) {
      const v = raw.trim() === '' ? NaN : Number(raw);
      if (Number.isFinite(v) && v > 0) thresholds[key] = v;
    }
    setBusy(true);
    setError(null);
    try {
      apply(await sensorThresholdsApi.save(thresholds));
      setSaved(true);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resetOne(s: SensorThresholdEntry) {
    setBusy(true);
    setError(null);
    try {
      apply(await sensorThresholdsApi.resetOne(s.node, s.chip, s.feature));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resetAll() {
    if (!window.confirm(t('sensorThresholds.resetAll.confirm'))) return;
    setBusy(true);
    setError(null);
    try {
      apply(await sensorThresholdsApi.resetAll());
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const anyCustom = sensors.some((s) => s.custom !== null);

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      {error && (
        <p role="alert" className="rounded-lg border border-crit/30 bg-crit/10 px-3 py-2 text-xs text-crit">
          {t('sensorThresholds.error', { msg: error })}
        </p>
      )}
      {saved && (
        <p role="status" className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok">{t('sensorThresholds.saved')}</p>
      )}

      <section className="space-y-1">
        <div className="flex items-center gap-2">
          <Thermometer className="h-4 w-4" />
          <h3 className="text-sm font-semibold">{t('sensorThresholds.title')}</h3>
        </div>
        <p className="text-xs text-muted-foreground">{t('sensorThresholds.hint')}</p>
      </section>

      {sensors.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
          {t('sensorThresholds.noData')}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('sensorThresholds.node')}</TableHead>
              <TableHead>{t('sensorThresholds.chip')}</TableHead>
              <TableHead>{t('sensorThresholds.feature')}</TableHead>
              <TableHead>{t('sensorThresholds.temp')}</TableHead>
              <TableHead>{t('sensorThresholds.firmware')}</TableHead>
              <TableHead className="w-32">{t('sensorThresholds.custom')}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sensors.map((s) => {
              const key = sensorKey(s);
              const effective = s.custom ?? s.firmware;
              const tone = tempTone(s.temp, effective);
              return (
                <TableRow key={key}>
                  <TableCell className="font-medium">{s.node}</TableCell>
                  <TableCell className="max-w-40 truncate" title={s.chip}>{s.chip}</TableCell>
                  <TableCell>{s.feature}</TableCell>
                  <TableCell>
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${toneClass(tone)}`}>
                      {s.temp !== null ? `${s.temp}°C` : '—'}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{s.firmware !== null ? `${s.firmware}°C` : '—'}</TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      value={draft[key] ?? ''}
                      max={s.firmware ?? undefined}
                      min={0}
                      step={1}
                      placeholder={s.firmware !== null ? String(s.firmware) : ''}
                      onChange={(e) => setDraftValue(key, e.target.value)}
                      className="w-24"
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void resetOne(s)}
                      disabled={busy || s.custom === null}
                      title={t('sensorThresholds.reset')}
                    >
                      <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {!anyCustom && sensors.length > 0 && (
        <p className="text-xs text-muted-foreground">{t('sensorThresholds.noneDefined')}</p>
      )}

      <div className="flex items-center gap-2">
        <Button variant="outline" size="md" onClick={() => void save()} disabled={busy}>
          <Save className="h-3.5 w-3.5" /> {busy ? '…' : t('sensorThresholds.save')}
        </Button>
        <Button variant="ghost" size="md" onClick={() => void resetAll()} disabled={busy || !anyCustom}>
          <Trash2 className="mr-1 h-3.5 w-3.5 text-crit" /> {t('sensorThresholds.resetAll')}
        </Button>
      </div>
    </div>
  );
}
