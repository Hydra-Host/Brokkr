import { Anvil } from 'lucide-react';

import { cn } from '@/components/ui/utils';

interface SidebarWordmarkProps {
  className?: string;
  collapsed?: boolean;
}

export function SidebarWordmark({ className, collapsed }: SidebarWordmarkProps) {
  const iconSquare = (
    <span className="bg-accent/10 border-border-dim flex size-8 shrink-0 items-center justify-center rounded-md border">
      <Anvil className="text-accent size-4" aria-hidden />
    </span>
  );

  if (collapsed) {
    return <div className={cn('flex items-center justify-center', className)}>{iconSquare}</div>;
  }

  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      {iconSquare}
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="text-text-primary truncate text-sm font-bold">Brokkr Sim</span>
        <span className="text-text-muted truncate text-[10px] font-medium tracking-wider uppercase">Self Host UI</span>
      </div>
    </div>
  );
}
