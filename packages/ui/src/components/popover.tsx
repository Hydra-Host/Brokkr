import { Popover as BasePopover } from '@base-ui/react/popover';
import * as React from 'react';

import { cn } from './utils';

const Popover = BasePopover.Root;

interface PopoverTriggerProps extends Omit<React.ComponentPropsWithoutRef<typeof BasePopover.Trigger>, 'render'> {
  asChild?: boolean;
}

const PopoverTrigger = React.forwardRef<HTMLButtonElement, PopoverTriggerProps>(
  ({ asChild, children, ...props }, ref) => {
    if (asChild && React.isValidElement(children)) {
      return <BasePopover.Trigger ref={ref} render={children} {...props} />;
    }
    return (
      <BasePopover.Trigger ref={ref} {...props}>
        {children}
      </BasePopover.Trigger>
    );
  },
);
PopoverTrigger.displayName = 'PopoverTrigger';

const PopoverClose = BasePopover.Close;

interface PopoverContentProps extends React.ComponentPropsWithoutRef<typeof BasePopover.Popup> {
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
}

const PopoverContent = React.forwardRef<HTMLDivElement, PopoverContentProps>(
  ({ className, align = 'center', side, sideOffset = 4, ...props }, ref) => (
    <BasePopover.Portal>
      <BasePopover.Positioner
        sideOffset={sideOffset}
        align={align}
        side={side}
        className="!z-[9999]"
        style={{ zIndex: 9999 }}
      >
        <BasePopover.Popup
          ref={ref}
          className={cn(
            'z-[9999] w-72 rounded-sm p-4',
            'bg-bg-secondary text-text-primary border-border border font-mono shadow-md',
            'outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2',
            'data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            className,
          )}
          style={{ zIndex: 9999 }}
          {...props}
        />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  ),
);
PopoverContent.displayName = 'PopoverContent';

export { Popover, PopoverClose, PopoverContent, PopoverTrigger };
