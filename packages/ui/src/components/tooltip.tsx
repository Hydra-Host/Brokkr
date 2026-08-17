import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import * as React from 'react';

import { cn } from './utils';

const TooltipProvider = ({ children }: { children: React.ReactNode; delayDuration?: number }) => {
  return <>{children}</>;
};

const Tooltip = BaseTooltip.Root;

interface TooltipTriggerProps extends Omit<React.ComponentPropsWithoutRef<typeof BaseTooltip.Trigger>, 'render'> {
  asChild?: boolean;
}

const TooltipTrigger = React.forwardRef<HTMLButtonElement, TooltipTriggerProps>(
  ({ className, asChild, children, ...props }, ref) => {
    if (asChild && React.isValidElement(children)) {
      return <BaseTooltip.Trigger ref={ref} className={cn('cursor-pointer', className)} render={children} {...props} />;
    }
    return (
      <BaseTooltip.Trigger ref={ref} className={cn('cursor-pointer', className)} {...props}>
        {children}
      </BaseTooltip.Trigger>
    );
  },
);
TooltipTrigger.displayName = 'TooltipTrigger';

const TooltipArrow = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseTooltip.Arrow>>(
  ({ className, ...props }, ref) => (
    <BaseTooltip.Arrow ref={ref} className={cn('fill-bg-secondary', className)} {...props} />
  ),
);
TooltipArrow.displayName = 'TooltipArrow';

interface TooltipContentProps extends React.ComponentPropsWithoutRef<typeof BaseTooltip.Popup> {
  sideOffset?: number;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}

const TooltipContent = React.forwardRef<HTMLDivElement, TooltipContentProps>(
  ({ className, sideOffset = 4, side = 'top', align = 'center', children, ...props }, ref) => (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner
        sideOffset={sideOffset}
        side={side}
        align={align}
        className="!z-[9999]"
        style={{ zIndex: 9999 }}
      >
        <BaseTooltip.Popup
          ref={ref}
          className={cn(
            'bg-bg-secondary text-text-primary border-border z-[9999] overflow-hidden rounded-sm border px-3 py-1.5 font-mono text-sm shadow-md',
            'animate-in fade-in-0 zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
            className,
          )}
          style={{ zIndex: 9999 }}
          {...props}
        >
          {children}
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  ),
);
TooltipContent.displayName = 'TooltipContent';

export { Tooltip, TooltipArrow, TooltipContent, TooltipProvider, TooltipTrigger };
