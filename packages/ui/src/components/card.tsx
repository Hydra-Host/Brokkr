import * as React from 'react';
import { cn } from './utils';

function Card({ className, children, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn(
        'group/card relative flex flex-col gap-4 py-4',
        'bg-bg-primary text-text-primary',
        'rounded-sm border [border-color:var(--card-border-color,var(--color-border))] shadow-sm',
        'font-mono',
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute -top-px -left-px h-2 w-2 border-t border-l [border-color:var(--card-border-color,var(--color-border))] transition-colors" />
      <span className="pointer-events-none absolute -top-px -right-px h-2 w-2 border-t border-r [border-color:var(--card-border-color,var(--color-border))] transition-colors" />
      <span className="pointer-events-none absolute -bottom-px -left-px h-2 w-2 border-b border-l [border-color:var(--card-border-color,var(--color-border))] transition-colors" />
      <span className="pointer-events-none absolute -right-px -bottom-px h-2 w-2 border-r border-b [border-color:var(--card-border-color,var(--color-border))] transition-colors" />
      {children}
    </div>
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-4 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-4',
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-title"
      className={cn('text-accent font-mono text-xl leading-none font-medium', className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-description" className={cn('text-text-muted font-mono text-sm', className)} {...props} />;
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-action"
      className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('px-4 font-mono', className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center px-4 font-mono [.border-t]:pt-4', className)}
      {...props}
    />
  );
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
