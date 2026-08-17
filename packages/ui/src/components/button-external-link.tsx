import { type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { Button, buttonVariants } from './button';

export interface ButtonExternalLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement>,
    VariantProps<typeof buttonVariants> {
  disabled?: boolean;
}

const ButtonExternalLink = React.forwardRef<HTMLAnchorElement, ButtonExternalLinkProps>(
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
        <a ref={ref} target="_blank" rel="noopener noreferrer" {...props}>
          {children}
        </a>
      </Button>
    );
  },
);
ButtonExternalLink.displayName = 'ButtonExternalLink';

export { ButtonExternalLink };
