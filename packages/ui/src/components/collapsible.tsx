import { Collapsible as BaseCollapsible } from '@base-ui/react/collapsible';
import * as React from 'react';

import { cn } from './utils';

const Collapsible = BaseCollapsible.Root;

interface CollapsibleTriggerProps
  extends Omit<React.ComponentPropsWithoutRef<typeof BaseCollapsible.Trigger>, 'render'> {
  asChild?: boolean;
}

const CollapsibleTrigger = React.forwardRef<HTMLButtonElement, CollapsibleTriggerProps>(
  ({ asChild, children, ...props }, ref) => {
    if (asChild && React.isValidElement(children)) {
      return <BaseCollapsible.Trigger ref={ref} render={children} {...props} />;
    }
    return (
      <BaseCollapsible.Trigger ref={ref} {...props}>
        {children}
      </BaseCollapsible.Trigger>
    );
  },
);
CollapsibleTrigger.displayName = 'CollapsibleTrigger';

interface CollapsibleContentProps extends React.ComponentPropsWithoutRef<typeof BaseCollapsible.Panel> {
  className?: string;
}

const CollapsibleContent = React.forwardRef<HTMLDivElement, CollapsibleContentProps>(
  ({ className, style, ...props }, ref) => (
    <BaseCollapsible.Panel
      ref={ref}
      keepMounted
      className={cn(
        'grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-in-out',
        'data-[open]:grid-rows-[1fr]',
        '[&>*]:overflow-hidden',
        className,
      )}
      style={{ ...style, display: 'grid' }}
      {...props}
    />
  ),
);
CollapsibleContent.displayName = 'CollapsibleContent';

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
