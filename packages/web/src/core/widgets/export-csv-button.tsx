import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Bouton « export CSV » du slot extra des frames de widgets (monitors VM / nœud) —
 * même style que les boutons d'export des cartes v2.
 */
export function ExportCsvButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={t('vm.mon.export')}
      className="rounded-md border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      <Download className="h-3.5 w-3.5" />
    </button>
  );
}
