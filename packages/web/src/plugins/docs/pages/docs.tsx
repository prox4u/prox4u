import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import {
  BookOpen,
  Boxes,
  Database,
  HardDrive,
  LayoutDashboard,
  MonitorSmartphone,
  Network,
  ShieldCheck,
  Siren,
  Thermometer,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../../../store/auth';
import { renderMarkdown } from '../lib/markdown';
import '../docs.css';

// Notices Markdown (source dans le repo, bundlées au build via `?raw`).
// Une notice = un fichier .md ; `content: null` → état « à venir ».
import centreonNscaMd from '../content/centreon-nsca.md?raw';

/**
 * Catalogue des notices : une entrée PAR FAMILLE de plugin (id = famille).
 * L'accès à une notice suit l'accès au module : la liste est filtrée par
 * `visibleModuleIds` (autorisé ∩ préférences) — même source que ModuleRoute.
 * `content` = null → notice « à venir » (placeholder).
 */
const DOC_MODULES: Array<{
  id: string;
  labelKey: string;
  icon: LucideIcon;
  content: string | null;
}> = [
  { id: 'hypervision', labelKey: 'nav.overview', icon: LayoutDashboard, content: null },
  { id: 'network', labelKey: 'nav.topology', icon: Network, content: null },
  { id: 'storage', labelKey: 'nav.storage', icon: HardDrive, content: null },
  { id: 'vm-view', labelKey: 'nav.vmView', icon: MonitorSmartphone, content: null },
  { id: 'proxmox-inventory', labelKey: 'nav.proxmoxInventory', icon: Boxes, content: null },
  { id: 'centreon-nsca', labelKey: 'nav.alarms', icon: Siren, content: centreonNscaMd },
  { id: 'node-sensors', labelKey: 'nav.nodeSensors', icon: Thermometer, content: null },
  { id: 'audit', labelKey: 'nav.audit', icon: ShieldCheck, content: null },
  { id: 'influxdb', labelKey: 'nav.influxdb', icon: Database, content: null },
];

/**
 * Page Documentation — sidebar (modules accessibles) + rendu Markdown.
 * - /docs            → première notice accessible
 * - /docs/:moduleId  → notice du module (redirige /profile si non accessible)
 */
export function DocsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { moduleId } = useParams<{ moduleId: string }>();
  const visibleModuleIds = useAuth((s) => s.visibleModuleIds);

  // Notices accessibles (ordre du catalogue).
  const accessible = useMemo(
    () => DOC_MODULES.filter((m) => visibleModuleIds.includes(m.id)),
    [visibleModuleIds],
  );

  // Module affiché : celui de l'URL, sinon la 1ʳᵉ notice rédigée accessible
  // (repli : le 1ᵉʳ module accessible, même placeholder « à venir »).
  const activeId =
    moduleId ?? accessible.find((m) => m.content)?.id ?? accessible[0]?.id;
  const active = DOC_MODULES.find((m) => m.id === activeId);

  // URL explicite vers un module non accessible → profil (comme ModuleRoute).
  if (moduleId && !visibleModuleIds.includes(moduleId)) {
    return <Navigate to="/profile" replace />;
  }
  // URL explicite vers un id qui n'est pas une notice connue → repli /docs.
  if (moduleId && !active) {
    return <Navigate to="/docs" replace />;
  }

  // Aucun module visible → message.
  if (accessible.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
        <BookOpen className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium">{t('docs.noAccess')}</p>
      </div>
    );
  }

  return (
    <div className="flex gap-5">
      {/* Sidebar — modules accessibles. */}
      <aside className="w-56 shrink-0">
        <div className="sticky top-0 space-y-1">
          <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('docs.subtitle')}
          </p>
          {accessible.map((m) => {
            const Icon = m.icon;
            const isActive = m.id === active?.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => navigate(`/docs/${m.id}`)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                  isActive
                    ? 'bg-secondary font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{t(m.labelKey)}</span>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Contenu — rendu Markdown. */}
      <main className="min-w-0 flex-1">
        {active ? (
          active.content ? (
            <article
              className="docs-prose"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(active.content) }}
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
              <BookOpen className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">{t(active.labelKey)}</p>
              <p className="text-xs text-muted-foreground">{t('docs.comingSoon')}</p>
            </div>
          )
        ) : null}
      </main>
    </div>
  );
}
