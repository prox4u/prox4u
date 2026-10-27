import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, OctagonAlert } from 'lucide-react';
import type { Alert } from '@prox4u/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';

export function AlertsList({ alerts }: { alerts: Alert[] }) {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader draggable>
        <CardTitle>{t('alerts.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {alerts.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg bg-ok/10 p-3 text-sm text-ok">
            <CheckCircle2 className="h-4 w-4" /> {t('alerts.none')}
          </div>
        ) : (
          <ul className="space-y-2">
            {alerts.map((a) => (
              <li
                key={a.id}
                className={`flex items-start gap-2 rounded-lg border p-2.5 text-sm ${
                  a.severity === 'crit' ? 'border-crit/30 bg-crit/10 text-crit' : 'border-warn/30 bg-warn/10 text-warn'
                }`}
              >
                {a.severity === 'crit' ? (
                  <OctagonAlert className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <span>{t(a.messageKey, a.params)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
