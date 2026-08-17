import { CirclePlus, Server } from 'lucide-react';

import { cn } from '@repo/ui/utils';

export function ServerCommissionIcon({ className }: { className?: string }) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)} aria-hidden>
      <Server className="size-full" />
      <span className="bg-background group-hover:bg-accent absolute -right-0.5 -bottom-0.5 flex size-[65%] items-center justify-center rounded-[1px] transition-colors">
        <CirclePlus className="size-full" />
      </span>
    </span>
  );
}
