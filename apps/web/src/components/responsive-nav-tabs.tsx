import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';

import { Tabs, TabsList, TabsTrigger } from '@repo/ui/components/tabs';

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

      <div className="hidden sm:block">
        <Tabs value={activeValue}>
          <TabsList className={tabsListClassName}>
            {tabs.map((tab) => (
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
