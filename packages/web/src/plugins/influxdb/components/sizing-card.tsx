import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge, AlertTriangle } from 'lucide-react';
import { fetchInfluxSizing } from '../../../core/api/apiClient';
import type { InfluxSizingResponse } from '../../../core/api/types';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';

/**
 * Carte « Dimensionnement » (P3, GitHub #19) : calculateur de config InfluxDB 3
 * Core à partir du parc réel (VMs/nœuds/datastores du dernier poll + tick).
 * Affiche la config recommandée + avertissements (config actuelle sous-dimensionnée)
 * + justification (repliable). Lecture seule — GET /api/influxdb/sizing.
 */
export function InfluxSizingCard() {
  const { t } = useTranslation();
  const [data, setData] = useState<InfluxSizingResponse | null>(null);
  const [showJustif, setShowJustif] = useState(false);

  useEffect(() => {
    fetchInfluxSizing()
      .then(setData)
      .catch((err) => console.warn('chargement /api/influxdb/sizing en échec', err));
  }, []);

  const s = data?.sizing;
  const input = data?.input;

  return (
    <Card className="border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-muted-foreground" />
          {t('influxdb.sizing.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!data || !s || !input ? (
          <div className="p-1 text-sm text-muted-foreground">{t('influxdb.sizing.loading')}</div>
        ) : (
          <>
            {/* Parc + taux d'écriture */}
            <div className="text-sm">
              <span className="text-muted-foreground">{t('influxdb.sizing.parc')} :</span>{' '}
              <span className="font-medium">
                {input.vms} {t('influxdb.sizing.vms')} · {input.nodes} {t('influxdb.sizing.nodes')} · {input.datastores}{' '}
                {t('influxdb.sizing.datastores')} · {input.endpoints} {t('influxdb.sizing.endpoints')}
              </span>
              <span className="text-muted-foreground"> · tick {input.tickSeconds} s</span>
              <div className="mt-1 text-muted-foreground">
                {t('influxdb.sizing.writeRate')}:{' '}
                <span className="font-mono text-foreground">
                  {s.linesPerTick}/tick · {s.linesPerMinute}/min · {s.linesPerDay}/j
                </span>
              </div>
            </div>

            {/* Config recommandée */}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('influxdb.sizing.param')}</TableHead>
                  <TableHead className="text-right">{t('influxdb.sizing.recommended')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <Row k={t('influxdb.sizing.queueMax')} v={s.queueMax} />
                <Row k={t('influxdb.sizing.flushMaxLines')} v={s.flushMaxLines} />
                <Row k={t('influxdb.sizing.flushDelayMs')} v={`${s.flushDelayMs} ms`} />
                <Row k={t('influxdb.sizing.queryFileLimit')} v={`${s.queryFileLimit} (~${s.maxQueryWindowDays} j)`} />
                <Row k={t('influxdb.sizing.chunkDays')} v={`${s.chunkDays} j (${s.chunkFiles} fichiers, ${s.fileHeadroom})`} />
                <Row k={t('influxdb.sizing.rawRetention')} v={s.rawRetention} />
                <Row k={t('influxdb.sizing.consolidatedRetention')} v={s.consolidatedRetention} />
              </TableBody>
            </Table>

            {/* Avertissements (config actuelle sous-dimensionnée) */}
            {s.warnings.length > 0 && (
              <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
                {s.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Justification (repliable) */}
            <div>
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => setShowJustif((v) => !v)}
              >
                {showJustif ? t('influxdb.sizing.justifHide') : t('influxdb.sizing.justifShow')}
              </button>
              {showJustif && (
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {s.justification.map((j, i) => (
                    <li key={i}>• {j}</li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string | number }) {
  return (
    <TableRow>
      <TableCell className="text-sm text-muted-foreground">{k}</TableCell>
      <TableCell className="text-right font-mono text-sm">{v}</TableCell>
    </TableRow>
  );
}
