import { ScrollArea as BaseScrollArea } from '@base-ui/react/scroll-area';
import * as React from 'react';

import { cn } from './utils';

const ScrollArea = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseScrollArea.Root>>(
  ({ className, children, ...props }, ref) => (
    <BaseScrollArea.Root ref={ref} className={cn('relative overflow-hidden', className)} {...props}>
      <BaseScrollArea.Viewport className="h-full w-full rounded-[inherit]">{children}</BaseScrollArea.Viewport>
      <ScrollBar />
      <BaseScrollArea.Corner />
    </BaseScrollArea.Root>
  ),
);
ScrollArea.displayName = 'ScrollArea';

interface ScrollBarProps extends React.ComponentPropsWithoutRef<typeof BaseScrollArea.Scrollbar> {
  orientation?: 'vertical' | 'horizontal';
}

const ScrollBar = React.forwardRef<HTMLDivElement, ScrollBarProps>(
  ({ className, orientation = 'vertical', ...props }, ref) => (
    <BaseScrollArea.Scrollbar
      ref={ref}
      orientation={orientation}
      className={cn(
        'flex touch-none transition-colors select-none',
        orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent p-px',
        orientation === 'horizontal' && 'h-2.5 border-t border-t-transparent p-px',
        className,
      )}
      {...props}
    >
      <BaseScrollArea.Thumb className={cn('bg-border relative rounded-full', orientation === 'vertical' && 'flex-1')} />
    </BaseScrollArea.Scrollbar>
  ),
);
ScrollBar.displayName = 'ScrollBar';

export { ScrollArea, ScrollBar };
