import { type VariantProps, cva } from 'class-variance-authority';
import * as React from 'react';

import { cn } from './utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center font-mono font-bold text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-accent text-primary-foreground hover:bg-accent-glow',
        destructive: 'bg-status-offline text-foreground hover:bg-status-offline/90',
        ghost: 'text-text-muted hover:text-accent hover:bg-transparent',
        link: 'text-accent underline-offset-4 hover:underline',
        outline: 'border border-accent text-accent bg-transparent hover:bg-accent hover:text-primary-foreground',
        secondary: 'bg-bg-secondary text-text-primary border border-border hover:border-accent hover:text-accent',
        success: 'bg-status-online text-primary-foreground hover:bg-status-online/90',
        warning: 'bg-amber-500 text-primary-foreground hover:bg-amber-400',
      },
      size: {
        default: 'h-10 px-4 py-2 rounded-sm',
        sm: 'h-9 px-3 rounded-sm text-xs',
        lg: 'h-11 px-8 rounded-sm',
        icon: 'h-10 w-10 rounded-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type = 'button', children, ...props }, ref) => {
    if (asChild) {
      const child = React.Children.only(children) as React.ReactElement<{ className?: string }>;
      return React.cloneElement(child, {
        className: cn('cursor-pointer', buttonVariants({ variant, size, className }), child.props.className),
        ref,
        ...props,
      } as React.HTMLAttributes<HTMLElement>);
    }

    return (
      <button
        className={cn('cursor-pointer', buttonVariants({ variant, size, className }))}
        ref={ref}
        type={type}
        {...props}
      >
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
