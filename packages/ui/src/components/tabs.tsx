import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import * as React from 'react';

import { cn } from './utils';

const Tabs = BaseTabs.Root;

interface TabsListProps extends React.ComponentPropsWithoutRef<typeof BaseTabs.List> {
  /** Rendered after the tab list, outside the composite tablist so it does not join keyboard roving. */
  trailing?: React.ReactNode;
}

const TabsList = React.forwardRef<HTMLDivElement, TabsListProps>(({ className, trailing, ...props }, ref) => (
  <div className="flex items-start">
    <span className="border-border mt-[12px] h-1.5 w-1.5 border-t border-l" />
    <span className="bg-border mt-[12px] h-px w-5" />
    <BaseTabs.List
      ref={ref}
      className={cn('inline-flex items-center gap-4', 'text-text-muted font-mono', className)}
      {...props}
    />
    {trailing ? (
      <>
        <span className="bg-border mt-[12px] h-px w-4" />
        {trailing}
      </>
    ) : null}
    <span className="bg-border mt-[12px] h-px flex-grow" />
    <span className="border-border mt-[12px] h-1.5 w-1.5 border-t border-r" />
  </div>
));
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

interface TabsOverflowTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
}

/** A plain button in the trigger's clothing for a menu that holds the tabs the list could not fit. */
const TabsOverflowTrigger = React.forwardRef<HTMLButtonElement, TabsOverflowTriggerProps>(
  ({ className, selected = false, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(tabTriggerStyles, className)}
      data-selected={selected ? '' : undefined}
      {...props}
    />
  ),
);
TabsOverflowTrigger.displayName = 'TabsOverflowTrigger';

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

export { Tabs, TabsContent, TabsList, TabsOverflowTrigger, TabsTrigger, tabTriggerStyles as tabsTriggerClassName };
