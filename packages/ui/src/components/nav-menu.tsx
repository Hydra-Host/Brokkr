import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { ChevronRight, GripVertical, Pin } from 'lucide-react';
import type { ComponentProps, ComponentType, ReactNode } from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible';
import { cn } from './utils';

// Presentational pieces of the app sidebar. Router-agnostic: callers render their own
// links with the exported class names. The data-slot hooks are what style-modern.css targets.

export const navRowClassName =
  'text-sidebar-foreground hover:bg-accent/10 data-active:bg-sidebar-primary data-active:text-sidebar-primary-foreground flex h-8 w-full items-center gap-2 pr-8 font-mono text-sm font-medium transition-colors';

export const navPrimaryLinkClassName =
  'border-accent text-sidebar-foreground hover:bg-accent/10 data-active:bg-sidebar-section-bg mx-3 my-2 flex h-8 shrink-0 items-center justify-center gap-2.5 rounded-md border font-mono text-sm font-medium transition-colors';

export function NavAccordion({
  icon: Icon,
  title,
  open,
  onToggle,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onToggle}>
      <CollapsibleTrigger
        data-slot="nav-section"
        className="group text-sidebar-foreground hover:bg-accent/10 aria-expanded:bg-sidebar-section-bg aria-expanded:text-accent-glow border-sidebar-border flex h-10 w-full shrink-0 items-center justify-between border-b px-4 font-mono text-[15px] font-medium transition-colors"
      >
        <span className="flex min-w-0 items-center gap-3">
          <Icon className="size-4 shrink-0" />
          <span className="truncate">{title}</span>
        </span>
        <ChevronRight className="text-text-dim/70 size-4 shrink-0 transition-transform group-aria-expanded:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div data-slot="nav-panel" className="border-sidebar-border border-b">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function NavSectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-text-dim flex h-8 items-center px-4 font-mono text-xs font-medium">{children}</div>;
}

/** Controlled tab group; Base UI supplies the tab/tabpanel wiring and arrow-key focus. */
export function NavTabs({
  value,
  onValueChange,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <BaseTabs.Root value={value} onValueChange={(next) => onValueChange(String(next))}>
      {children}
    </BaseTabs.Root>
  );
}

export function NavTabList({ children }: { children: ReactNode }) {
  return <BaseTabs.List className="flex h-9 items-center gap-2 px-4">{children}</BaseTabs.List>;
}

export function NavTab({ value, children }: { value: string; children: ReactNode }) {
  return (
    <BaseTabs.Tab
      value={value}
      className="text-text-dim aria-selected:bg-sidebar-section-bg aria-selected:text-accent-glow rounded-sm px-2 py-0.5 font-mono text-xs font-bold transition-colors"
    >
      {children}
    </BaseTabs.Tab>
  );
}

export function NavTabPanel({ value, children }: { value: string; children: ReactNode }) {
  return <BaseTabs.Panel value={value}>{children}</BaseTabs.Panel>;
}

export function NavEmptyHint({ children }: { children: ReactNode }) {
  return <div className="text-text-dim/70 flex h-8 items-center pl-6 font-mono text-xs italic">{children}</div>;
}

/** Row wrapper: hover reveals the pin button, drag state dims the row. */
export function NavRow({
  className,
  dragging = false,
  children,
  ...props
}: ComponentProps<'li'> & { dragging?: boolean }) {
  return (
    <li className={cn('group/leaf relative', dragging && 'opacity-40', className)} {...props}>
      {children}
    </li>
  );
}

export function NavDropIndicator({ position }: { position: 'above' | 'below' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'bg-accent pointer-events-none absolute right-2 left-2 h-px shadow-[0_0_4px_var(--color-accent-glow)]',
        position === 'above' ? '-top-px' : '-bottom-px',
      )}
    />
  );
}

export function NavDragHandle() {
  return (
    <span
      aria-hidden="true"
      className="text-text-dim/50 group-hover/leaf:text-text-dim pointer-events-none absolute top-1/2 left-5 flex size-4 -translate-y-1/2 items-center justify-center transition-colors"
    >
      <GripVertical className="size-3" />
    </span>
  );
}

export function NavPinButton({
  pinned,
  active,
  label,
  onToggle,
}: {
  pinned: boolean;
  active: boolean;
  label: string;
  onToggle: () => void;
}) {
  const title = pinned ? `Unpin ${label}` : `Pin ${label}`;
  return (
    <button
      type="button"
      data-slot="nav-pin"
      aria-label={title}
      title={title}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        'hover:bg-accent/20 absolute top-1/2 right-2 z-10 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm transition-opacity',
        active
          ? 'text-sidebar-primary-foreground opacity-100'
          : pinned
            ? 'text-accent-glow opacity-100'
            : 'text-text-dim opacity-0 group-hover/leaf:opacity-100 focus-visible:opacity-100',
      )}
    >
      <Pin className={cn('size-3', pinned && 'rotate-45 fill-current')} />
    </button>
  );
}
