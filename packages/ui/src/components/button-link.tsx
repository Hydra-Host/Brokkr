import { Link, type LinkProps } from '@tanstack/react-router';
import { type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { Button, buttonVariants } from './button';

export interface ButtonLinkProps extends LinkProps, VariantProps<typeof buttonVariants> {
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
}

const ButtonLink = React.forwardRef<HTMLAnchorElement, ButtonLinkProps>(
  ({ className, disabled, variant, size, children, ...props }, ref) => {
    if (disabled) {
      return (
        <Button disabled variant={variant} size={size} className={className}>
          {children}
        </Button>
      );
    }

    return (
      <Button asChild variant={variant} size={size} className={className}>
        <Link ref={ref} preload="intent" {...(props as any)}>
          {children}
        </Link>
      </Button>
    );
  },
);
ButtonLink.displayName = 'ButtonLink';

export { ButtonLink };
