import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import * as React from 'react';

import { cn } from './utils';

const Tabs = BaseTabs.Root;

const TabsList = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseTabs.List>>(
  ({ className, ...props }, ref) => (
    <div className="flex items-start">
      <span className="border-border mt-[12px] h-1.5 w-1.5 border-t border-l" />
      <span className="bg-border mt-[12px] h-px w-5" />
      <BaseTabs.List
        ref={ref}
        className={cn('inline-flex items-center gap-4', 'text-text-muted font-mono', className)}
        {...props}
      />
      <span className="bg-border mt-[12px] h-px flex-grow" />
      <span className="border-border mt-[12px] h-1.5 w-1.5 border-t border-r" />
    </div>
  ),
);
TabsList.displayName = 'TabsList';

interface TabsTriggerProps extends Omit<React.ComponentPropsWithoutRef<typeof BaseTabs.Tab>, 'render'> {
  asChild?: boolean;
}

const tabTriggerStyles = cn(
  'cursor-pointer px-1.5 py-0.5',
  'text-sm font-mono font-medium whitespace-nowrap',
  'text-text-muted transition-colors',
  'focus-visible:outline-none',
  'disabled:pointer-events-none disabled:opacity-50',
  'data-[selected]:text-bg-primary data-[selected]:bg-accent data-[selected]:font-bold',
  'aria-selected:text-bg-primary aria-selected:bg-accent aria-selected:font-bold',
  'hover:text-accent',
);

const TabsTrigger = React.forwardRef<HTMLElement, TabsTriggerProps>(
  ({ className, asChild, children, ...props }, ref) => {
    if (asChild && React.isValidElement(children)) {
      return (
        <BaseTabs.Tab
          ref={ref}
          className={cn(tabTriggerStyles, className)}
          nativeButton={false}
          render={children}
          {...props}
        />
      );
    }
    return (
      <BaseTabs.Tab ref={ref} className={cn(tabTriggerStyles, className)} {...props}>
        {children}
      </BaseTabs.Tab>
    );
  },
);
TabsTrigger.displayName = 'TabsTrigger';

const TabsContent = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseTabs.Panel>>(
  ({ className, ...props }, ref) => (
    <BaseTabs.Panel
      ref={ref}
      className={cn(
        'mt-4 font-mono',
        'focus-visible:ring-accent focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        className,
      )}
      {...props}
    />
  ),
);
TabsContent.displayName = 'TabsContent';

export { Tabs, TabsContent, TabsList, TabsTrigger };
