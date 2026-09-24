import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { Tabs, TabsList, TabsOverflowTrigger, TabsTrigger, tabsTriggerClassName } from '@repo/ui/components/tabs';
import { useOverflowTabs } from '@repo/ui/hooks/use-overflow-tabs';
import { cn } from '@repo/ui/utils';

interface Tab {
  name: string;
  href: string;
  value?: string;
}

interface ResponsiveNavTabsProps {
  tabs: Tab[];
  activeValue: string;
  tabsListClassName?: string;
}

export function ResponsiveNavTabs({ tabs, activeValue, tabsListClassName }: ResponsiveNavTabsProps) {
  const navigate = useNavigate();
  const { containerRef, setItemRef, visibleCount } = useOverflowTabs({ itemCount: tabs.length });
  const visible = tabs.slice(0, visibleCount);
  const overflow = tabs.slice(visibleCount);
  const hiddenActive = overflow.find((tab) => (tab.value ?? tab.href) === activeValue);

  return (
    <>
      <div className="relative mb-4 sm:hidden">
        <select
          value={activeValue}
          onChange={(e) => {
            const tab = tabs.find((t) => (t.value ?? t.href) === e.target.value);
            if (tab) navigate({ to: tab.href });
          }}
          className="bg-background text-foreground border-border w-full appearance-none rounded-md border px-3 py-2 pr-8 font-mono text-sm"
        >
          {tabs.map((tab) => (
            <option key={tab.href} value={tab.value ?? tab.href}>
              {tab.name}
            </option>
          ))}
        </select>
        <ChevronDown className="text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2" />
      </div>

      <div ref={containerRef} className="relative hidden sm:block">
        <div aria-hidden className="pointer-events-none invisible absolute top-0 left-0 flex gap-4">
          {tabs.map((tab, index) => (
            // measured bold, the widest state a tab takes once selected
            <span key={tab.href} ref={setItemRef(index)} className={cn(tabsTriggerClassName, 'font-bold')}>
              {tab.name}
            </span>
          ))}
        </div>
        <Tabs value={activeValue}>
          <TabsList
            className={tabsListClassName}
            trailing={
              overflow.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <TabsOverflowTrigger selected={hiddenActive !== undefined}>
                      {hiddenActive?.name ?? 'More'}
                      <ChevronDown className="ml-1 inline h-3.5 w-3.5" />
                    </TabsOverflowTrigger>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup className="max-h-72 overflow-y-auto overscroll-contain">
                      {overflow.map((tab) => (
                        <DropdownMenuItem key={tab.href} asChild>
                          <Link to={tab.href}>{tab.name}</Link>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )
            }
          >
            {visible.map((tab) => (
              <TabsTrigger key={tab.href} value={tab.value ?? tab.href} asChild>
                <Link to={tab.href}>{tab.name}</Link>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
    </>
  );
}
