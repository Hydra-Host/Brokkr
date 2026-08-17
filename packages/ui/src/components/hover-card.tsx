import { PreviewCard as BasePreviewCard } from '@base-ui/react/preview-card';
import * as React from 'react';

import { cn } from './utils';

interface HoverCardProps extends Omit<React.ComponentPropsWithoutRef<typeof BasePreviewCard.Root>, 'children'> {
  children: React.ReactNode;
  openDelay?: number;
  closeDelay?: number;
}

const HoverCard: React.FC<HoverCardProps> = ({ openDelay, closeDelay, ...props }) => {
  void openDelay;
  void closeDelay;
  return <BasePreviewCard.Root {...props} />;
};

interface HoverCardTriggerProps extends Omit<React.ComponentPropsWithoutRef<typeof BasePreviewCard.Trigger>, 'render'> {
  asChild?: boolean;
}

const HoverCardTrigger = React.forwardRef<HTMLAnchorElement, HoverCardTriggerProps>(
  ({ asChild, children, ...props }, ref) => {
    if (asChild && React.isValidElement(children)) {
      return <BasePreviewCard.Trigger ref={ref} render={children} {...props} />;
    }
    return (
      <BasePreviewCard.Trigger ref={ref} {...props}>
        {children}
      </BasePreviewCard.Trigger>
    );
  },
);
HoverCardTrigger.displayName = 'HoverCardTrigger';

interface HoverCardContentProps extends React.ComponentPropsWithoutRef<typeof BasePreviewCard.Popup> {
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
}

const HoverCardContent = React.forwardRef<HTMLDivElement, HoverCardContentProps>(
  ({ className, align = 'center', side, sideOffset = 4, ...props }, ref) => (
    <BasePreviewCard.Portal>
      <BasePreviewCard.Positioner
        sideOffset={sideOffset}
        align={align}
        side={side}
        className="!z-[9999]"
        style={{ zIndex: 9999 }}
      >
        <BasePreviewCard.Popup
          ref={ref}
          className={cn(
            'z-[9999] w-64 rounded-sm p-4 outline-none',
            'bg-bg-secondary text-text-primary border-border border font-mono shadow-md',
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
      </BasePreviewCard.Positioner>
    </BasePreviewCard.Portal>
  ),
);
HoverCardContent.displayName = 'HoverCardContent';

export { HoverCard, HoverCardContent, HoverCardTrigger };
