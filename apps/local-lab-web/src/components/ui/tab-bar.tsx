import { type ReactNode } from 'react';

import { cn } from './utils';

export interface Tab {
  id: string;
  label: string;
}

export function TabBar({
  tabs,
  active,
  onSelect,
  trailing,
  className,
}: {
  tabs: readonly Tab[];
  active: string;
  onSelect: (id: string) => void;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('border-border-dim flex items-center gap-1 border-b', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onSelect(t.id)}
          className={[
            '-mb-px border-b-2 px-3 py-2 text-sm transition',
            active === t.id
              ? 'border-accent text-text-primary'
              : 'text-text-dim hover:text-text-muted border-transparent',
          ].join(' ')}
        >
          {t.label}
        </button>
      ))}
      {trailing}
    </div>
  );
}
