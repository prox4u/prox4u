import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        default: 'border-transparent bg-secondary text-secondary-foreground',
        ok: 'border-ok/30 bg-ok/15 text-ok',
        warn: 'border-warn/30 bg-warn/15 text-warn',
        crit: 'border-crit/30 bg-crit/15 text-crit',
        primary: 'border-transparent bg-primary text-primary-foreground',
      },
    },
    defaultVariants: { tone: 'default' },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
