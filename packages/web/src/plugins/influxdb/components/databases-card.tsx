import { useTranslation } from 'react-i18next';
import { Database } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';

/** Carte « Bases » : liste des bases InfluxDB + rétention. */
export function InfluxDatabasesCard({ databases, enabled }: { databases: Array<{ name: string; retention: string | null }>; enabled: boolean }) {
  const { t } = useTranslation();
  return (
    <Card className="border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          {t('influxdb.databases.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {!enabled || databases.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">{t('influxdb.databases.empty')}</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('influxdb.databases.name')}</TableHead>
                <TableHead>{t('influxdb.databases.retention')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {databases.map((d) => (
                <TableRow key={d.name}>
                  <TableCell className="font-mono text-sm">{d.name}</TableCell>
                  <TableCell>
                    {/* L'API GET /api/v3/configure/database ne renvoie pas la rétention
                        (limite InfluxDB 3 Core) → « — » (inconnu) plutôt que « infinie »
                        (faux : ex. raw = 31 j) — GitHub #16. */}
                    {d.retention ? (
                      <span className="font-mono text-sm">{d.retention}</span>
                    ) : (
                      <span className="text-sm text-muted-foreground">{t('influxdb.databases.retention.unknown')}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
