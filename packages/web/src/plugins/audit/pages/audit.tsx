import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Boxes, CheckCircle2, Cpu, HardDrive, Server, ShieldCheck } from 'lucide-react';
import type { AuditFinding, AuditSeverity, AuditTarget } from '@prox4u/shared';
import { useMulti } from '../../../core/data/use-endpoint';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Progress } from '../../../components/ui/progress';
import { Skeleton } from '../../../components/ui/skeleton';

/** Sévérité → teinte du badge (info = neutre). */
const SEV_TONE: Record<AuditSeverity, 'crit' | 'warn' | 'default'> = {
  crit: 'crit',
  warn: 'warn',
  info: 'default',
};

/** Score → teinte (≥80 ok · 50–79 warn · <50 crit). */
function scoreTone(score: number): 'ok' | 'warn' | 'crit' {
  if (score >= 80) return 'ok';
  if (score >= 50) return 'warn';
  return 'crit';
}

/** Icône de la cible d'un constat. */
function TargetIcon({ target }: { target: AuditTarget }) {
  const cls = 'h-3.5 w-3.5 shrink-0';
  switch (target.kind) {
    case 'vm':
      return <Cpu className={cls} />;
    case 'node':
      return <Server className={cls} />;
    case 'storage':
      return <HardDrive className={cls} />;
    case 'cluster':
      return <Boxes className={cls} />;
  }
}

/** Une ligne de constat : sévérité + message + cible cliquable. */
function FindingRow({ finding, onNavigate }: { finding: AuditFinding; onNavigate: (t: AuditTarget) => void }) {
  const { t } = useTranslation();
  const msg = t(finding.messageKey, finding.params ?? {});
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
      <Badge tone={SEV_TONE[finding.severity]} className="shrink-0">
        {t(`audit.severity.${finding.severity}`)}
      </Badge>
      <span className="min-w-0 flex-1 truncate text-sm" title={msg}>
        {msg}
      </span>
      <button
        type="button"
        onClick={() => onNavigate(finding.target)}
        className="flex shrink-0 items-center gap-1.5 rounded-md border bg-secondary/40 px-2 py-1 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-secondary"
        title={t('audit.openTarget')}
      >
        <TargetIcon target={finding.target} />
        <span className="max-w-[180px] truncate">{finding.target.label}</span>
      </button>
    </div>
  );
}

/** Section de constats d'une sévérité (masquée si vide). */
function SeveritySection({
  severity,
  findings,
  onNavigate,
}: {
  severity: AuditSeverity;
  findings: AuditFinding[];
  onNavigate: (t: AuditTarget) => void;
}) {
  const { t } = useTranslation();
  if (findings.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Badge tone={SEV_TONE[severity]}>{t(`audit.severity.${severity}`)}</Badge>
        <span className="text-xs text-muted-foreground">
          {findings.length} {findings.length > 1 ? t('audit.findings.plural') : t('audit.findings.singular')}
        </span>
      </div>
      <div className="space-y-1.5">
        {findings.map((f, i) => (
          <FindingRow key={`${f.check}-${f.target.label}-${i}`} finding={f} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
}

export function AuditPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const multi = useMulti();
  const eps = multi?.endpoints ?? [];
  const [endpointId, setEndpointId] = useState<string | null>(null);

  // Endpoint sélectionné (défaut : endpoint par défaut, repli premier).
  const ep =
    (endpointId ? eps.find((e) => e.id === endpointId) : undefined) ??
    eps.find((e) => e.id === multi?.defaultEndpointId) ??
    eps[0];
  const audit = ep?.snapshot?.audit ?? null;

  // Cible cliquable → navigation vers le détail concerné.
  function go(target: AuditTarget) {
    switch (target.kind) {
      case 'vm':
        navigate(`/vms?tree=${target.endpointId}/${target.node}&vm=${target.vmid}`);
        break;
      case 'node':
        navigate(`/e/${target.endpointId}/n/${target.node}`);
        break;
      case 'storage':
        navigate('/storage');
        break;
      case 'cluster':
        navigate(`/e/${target.endpointId}`);
        break;
    }
  }

  // Constats groupés par sévérité (l'ordre est déjà crit → warn → info dans le score).
  const grouped = useMemo(() => {
    const g: Record<AuditSeverity, AuditFinding[]> = { crit: [], warn: [], info: [] };
    for (const f of audit?.findings ?? []) g[f.severity].push(f);
    return g;
  }, [audit]);

  // Chargement : pas encore de snapshot WS.
  if (!multi) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* En-tête + sélecteur d'endpoint (multi-endpoints seulement). */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold tracking-tight">{t('audit.title')}</h1>
        </div>
        {eps.length > 1 && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {t('audit.endpoint')}
            <select
              value={ep?.id ?? ''}
              onChange={(e) => setEndpointId(e.target.value)}
              className="max-w-[240px] rounded-md border bg-card px-2 py-1.5 text-xs font-medium text-foreground"
            >
              {eps.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* Score de configuration. */}
      {audit ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('audit.score')}</CardTitle>
            <CardDescription>{t('audit.scoreDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-6">
              <div className="flex flex-col items-center">
                <span className={`text-5xl font-bold tabular-nums ${scoreTone(audit.score) === 'ok' ? 'text-ok' : scoreTone(audit.score) === 'warn' ? 'text-warn' : 'text-crit'}`}>
                  {audit.score}
                </span>
                <Badge tone={scoreTone(audit.score)} className="mt-2">
                  {t(audit.labelKey)}
                </Badge>
              </div>
              <div className="min-w-[240px] flex-1 space-y-3">
                <Progress value={audit.score} tone={scoreTone(audit.score)} />
                <div className="flex flex-wrap gap-2">
                  <Badge tone="crit">
                    {audit.counts.crit} {t('audit.severity.crit')}
                  </Badge>
                  <Badge tone="warn">
                    {audit.counts.warn} {t('audit.severity.warn')}
                  </Badge>
                  <Badge tone="default">
                    {audit.counts.info} {t('audit.severity.info')}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {audit.checksPassed}/{audit.checksTotal} {t('audit.checksPassed')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {t('audit.noData')}
          </CardContent>
        </Card>
      )}

      {/* Constats par sévérité. */}
      {audit && (
        <Card>
          <CardHeader>
            <CardTitle>{t('audit.findings.title')}</CardTitle>
            <CardDescription>{t('audit.findings.desc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {audit.findings.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-ok/30 bg-ok/10 px-4 py-3 text-sm text-ok">
                <CheckCircle2 className="h-4 w-4" />
                {t('audit.empty')}
              </div>
            ) : (
              <>
                <SeveritySection severity="crit" findings={grouped.crit} onNavigate={go} />
                <SeveritySection severity="warn" findings={grouped.warn} onNavigate={go} />
                <SeveritySection severity="info" findings={grouped.info} onNavigate={go} />
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
