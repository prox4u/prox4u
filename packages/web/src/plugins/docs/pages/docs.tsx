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
// Deux versions par notice : FR (`content/<id>.md`) + EN (`content/en/<id>.md`).
// La version affichée suit la langue de l'app (`i18n.language`) ; repli FR si EN absent.
// `content: null` → état « à venir ».
import hypervisionFr from '../content/hypervision.md?raw';
import hypervisionEn from '../content/en/hypervision.md?raw';
import networkFr from '../content/network.md?raw';
import networkEn from '../content/en/network.md?raw';
import storageFr from '../content/storage.md?raw';
import storageEn from '../content/en/storage.md?raw';
import vmViewFr from '../content/vm-view.md?raw';
import vmViewEn from '../content/en/vm-view.md?raw';
import proxmoxInventoryFr from '../content/proxmox-inventory.md?raw';
import proxmoxInventoryEn from '../content/en/proxmox-inventory.md?raw';
import centreonNscaFr from '../content/centreon-nsca.md?raw';
import centreonNscaEn from '../content/en/centreon-nsca.md?raw';
import nodeSensorsFr from '../content/node-sensors.md?raw';
import nodeSensorsEn from '../content/en/node-sensors.md?raw';
import auditFr from '../content/audit.md?raw';
import auditEn from '../content/en/audit.md?raw';
import influxdbFr from '../content/influxdb.md?raw';
import influxdbEn from '../content/en/influxdb.md?raw';

/** Contenu d'une notice : FR (référence) + EN (optionnelle, repli FR si null). */
type DocContent = { fr: string; en: string | null };

/**
 * Catalogue des notices : une entrée PAR FAMILLE de plugin (id = famille).
 * L'accès à une notice suit l'accès au module : la liste est filtrée par
 * `visibleModuleIds` (autorisé ∩ préférences) — même source que ModuleRoute.
 * `content` = null → notice « à venir » (placeholder).
 * La version affichée suit la langue de l'app (`i18n.language`).
 */
const DOC_MODULES: Array<{
  id: string;
  labelKey: string;
  icon: LucideIcon;
  content: DocContent | null;
}> = [
  { id: 'hypervision', labelKey: 'nav.overview', icon: LayoutDashboard, content: { fr: hypervisionFr, en: hypervisionEn } },
  { id: 'network', labelKey: 'nav.topology', icon: Network, content: { fr: networkFr, en: networkEn } },
  { id: 'storage', labelKey: 'nav.storage', icon: HardDrive, content: { fr: storageFr, en: storageEn } },
  { id: 'vm-view', labelKey: 'nav.vmView', icon: MonitorSmartphone, content: { fr: vmViewFr, en: vmViewEn } },
  { id: 'proxmox-inventory', labelKey: 'nav.proxmoxInventory', icon: Boxes, content: { fr: proxmoxInventoryFr, en: proxmoxInventoryEn } },
  { id: 'centreon-nsca', labelKey: 'nav.alarms', icon: Siren, content: { fr: centreonNscaFr, en: centreonNscaEn } },
  { id: 'node-sensors', labelKey: 'nav.nodeSensors', icon: Thermometer, content: { fr: nodeSensorsFr, en: nodeSensorsEn } },
  { id: 'audit', labelKey: 'nav.audit', icon: ShieldCheck, content: { fr: auditFr, en: auditEn } },
  { id: 'influxdb', labelKey: 'nav.influxdb', icon: Database, content: { fr: influxdbFr, en: influxdbEn } },
];

/**
 * Page Documentation — sidebar (modules accessibles) + rendu Markdown.
 * - /docs            → première notice accessible
 * - /docs/:moduleId  → notice du module (redirige /profile si non accessible)
 */
export function DocsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { moduleId } = useParams<{ moduleId: string }>();
  // Langue de la notice : suit la langue de l'app (switcher topbar) ; repli FR.
  const lang: 'fr' | 'en' = i18n.language === 'en' ? 'en' : 'fr';
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
              dangerouslySetInnerHTML={{ __html: renderMarkdown(active.content[lang] ?? active.content.fr) }}
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
