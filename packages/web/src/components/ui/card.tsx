import { forwardRef, type HTMLAttributes } from 'react';
import { GripVertical } from 'lucide-react';
import { cn } from '../../lib/utils';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex h-full flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm transition-colors hover:border-primary/30 dark:shadow-xl dark:shadow-black/30',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  draggable = false,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { draggable?: boolean }) {
  return (
    <div
      className={cn('relative flex flex-col gap-1 p-4 pb-2', draggable && 'drag-handle select-none', className)}
      {...props}
    >
      {draggable && (
        <GripVertical className="absolute right-3 top-3 h-4 w-4 text-muted-foreground/50" aria-hidden />
      )}
      {children}
    </div>
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-sm font-semibold tracking-tight', className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-xs text-muted-foreground', className)} {...props} />;
}

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex-1 p-4 pt-2', className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';
