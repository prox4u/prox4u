import { useState } from 'react';
import { Building2, ChevronDown, ChevronRight, Cpu, MonitorSmartphone, Server } from 'lucide-react';
import type { VmTreeNode } from '@prox4u/shared';
import { cn } from '../../../lib/utils';

interface Props {
  tree: VmTreeNode;
  selectedId: string;
  onSelect: (id: string) => void;
}

const KIND_ICON = {
  datacenter: Building2,
  endpoint: Server,
  node: Cpu,
} as const;

/**
 * Arborescence vCenter : Datacenter → endpoints (clusters) → nœuds.
 * Clic sur un nœud = sélection (le tableau affiche son parc) + bascule d'expansion.
 * Le compteur à droite est « en marche / total ».
 */
export function VmTree({ tree, selectedId, onSelect }: Props) {
  // Ouvert par défaut : la racine et ses endpoints.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set([tree.id, ...(tree.children?.map((c) => c.id) ?? [])]),
  );

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderNode = (node: VmTreeNode, depth: number) => {
    // La v1 ne construit pas de feuilles VM (includeVms absent) — branche inatteinte,
    // mais le type partagé l'autorise désormais.
    const Icon = node.kind === 'vm' ? MonitorSmartphone : KIND_ICON[node.kind];
    const hasChildren = (node.children?.length ?? 0) > 0;
    const isOpen = expanded.has(node.id);
    return (
      <div key={node.id}>
        <button
          onClick={() => {
            onSelect(node.id);
            if (hasChildren) toggle(node.id);
          }}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          className={cn(
            'flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs transition-colors',
            selectedId === node.id
              ? 'bg-accent font-medium text-foreground'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
          )}
        >
          {hasChildren ? (
            isOpen ? (
              <ChevronDown className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0" />
            )
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{node.label}</span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            <span className="text-ok">{node.runningCount}</span>/{node.vmCount}
          </span>
        </button>
        {isOpen && node.children?.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return <div className="space-y-0.5">{renderNode(tree, 0)}</div>;
}
