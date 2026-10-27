import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const GRADIENTS: Record<string, string> = {
  ok: 'linear-gradient(90deg, #059669, #34d399)',
  warn: 'linear-gradient(90deg, #d97706, #fbbf24)',
  crit: 'linear-gradient(90deg, #dc2626, #f87171)',
  default: 'linear-gradient(90deg, #6366f1, #818cf8)',
};

export function Progress({
  value,
  tone = 'default',
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { value: number; tone?: 'default' | 'ok' | 'warn' | 'crit' }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <div
        className="h-full rounded-full transition-all duration-700"
        style={{ width: `${clamped}%`, background: GRADIENTS[tone] }}
      />
    </div>
  );
}
