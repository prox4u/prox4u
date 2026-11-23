import { useTranslation } from 'react-i18next';
import { Archive } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { formatBytes } from '../../../lib/utils';

interface ArchiveState {
  lastArchivedTs: number;
  archiveDir: string;
  fileCount: number;
  totalBytes: number;
}

/** Carte « Archivage » : état du consolidateur CSV (borne archivée, fichiers, taille). */
export function InfluxArchiveCard({ archive }: { archive: ArchiveState | null }) {
  const { t } = useTranslation();
  return (
    <Card className="border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Archive className="h-4 w-4 text-muted-foreground" />
          {t('influxdb.archive.title')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!archive ? (
          <div className="text-sm text-muted-foreground">{t('influxdb.archive.unavailable')}</div>
        ) : (
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">{t('influxdb.archive.lastArchived')}</dt>
              <dd className="tabular-nums">
                {new Date(archive.lastArchivedTs * 1000).toLocaleString()}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">{t('influxdb.archive.files')}</dt>
              <dd className="tabular-nums">
                {archive.fileCount} · {formatBytes(archive.totalBytes)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">{t('influxdb.archive.dir')}</dt>
              <dd className="truncate font-mono text-xs" title={archive.archiveDir}>
                {archive.archiveDir}
              </dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
