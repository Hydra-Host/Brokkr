import { ChevronDown } from 'lucide-react';

interface MobileTabSelectProps {
  tabs: { name: string; value: string }[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
}

export function MobileTabSelect({ tabs, value, onValueChange, className }: MobileTabSelectProps) {
  return (
    <div className={`relative sm:hidden ${className ?? ''}`}>
      <select
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        className="bg-background text-foreground border-border w-full appearance-none rounded-md border px-3 py-2 pr-8 font-mono text-sm"
      >
        {tabs.map((tab) => (
          <option key={tab.value} value={tab.value}>
            {tab.name}
          </option>
        ))}
      </select>
      <ChevronDown className="text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2" />
    </div>
  );
}
