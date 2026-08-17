import { type VariantProps, cva } from 'class-variance-authority';
import * as React from 'react';

import { cn } from './utils';

const badgeVariants = cva(
  'inline-flex w-fit items-center rounded-sm border border-transparent font-mono font-bold uppercase tracking-wide transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'bg-accent text-primary-foreground',
        secondary: 'bg-bg-secondary text-text-primary',
        destructive: 'bg-status-offline/20 text-status-offline',
        outline: 'text-text-muted bg-bg-secondary/60',
        success: 'bg-status-online/20 text-status-online',
        warning: 'bg-status-warning/20 text-status-warning',
        online: 'bg-status-online/20 text-status-online',
        offline: 'bg-status-offline/20 text-status-offline',
        price: 'bg-status-price/20 text-status-price',
        info: 'bg-status-info/20 text-status-info',
        purple: 'bg-status-purple/20 text-status-purple',
      },
      size: {
        sm: 'px-1.5 py-0 text-[10px]',
        md: 'px-2.5 py-0.5 text-xs',
        lg: 'px-3 py-1 text-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

export { Badge, badgeVariants };
