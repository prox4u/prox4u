import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../../lib/utils';

export interface MultiOption {
  value: string;
  label: string;
}

export interface MultiGroup {
  title: string;
  options: MultiOption[];
}

interface Props {
  groups: MultiGroup[];
  /** valeurs sélectionnées (toutes les groupes confondus) */
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  placeholder: string;
}

/** Liste déroulante à choix multiple, groupée, avec fermeture au clic extérieur. */
export function MultiSelect({ groups, selected, onChange, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  const count = selected.size;
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-xs font-medium transition-colors',
          count > 0 ? 'border-primary/40 text-primary' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {placeholder}
        {count > 0 && (
          <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none">{count}</span>
        )}
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 w-60 rounded-lg border bg-card p-2 shadow-lg">
          {groups.map((g) => (
            <div key={g.title} className="mb-2 last:mb-0">
              <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{g.title}</div>
              <div className="max-h-48 overflow-auto">
                {g.options.map((o) => {
                  const checked = selected.has(o.value);
                  return (
                    <label
                      key={o.value}
                      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-secondary"
                    >
                      <span
                        className={cn(
                          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                          checked ? 'border-primary bg-primary text-background' : 'border-muted-foreground/40',
                        )}
                      >
                        {checked && <Check className="h-2.5 w-2.5" />}
                      </span>
                      <input type="checkbox" className="sr-only" checked={checked} onChange={() => toggle(o.value)} />
                      <span className="truncate">{o.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
          {count > 0 && (
            <button
              onClick={() => onChange(new Set())}
              className="mt-1 w-full rounded border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Tout effacer
            </button>
          )}
        </div>
      )}
    </div>
  );
}
