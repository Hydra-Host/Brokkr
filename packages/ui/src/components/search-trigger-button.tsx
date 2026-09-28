import { Search } from 'lucide-react';
import { Button } from './button';
import { cn } from './utils';

export function SearchTriggerButton({
  onClick,
  label = 'Search...',
  className,
}: {
  onClick: () => void;
  label?: string;
  className?: string;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        'text-muted-foreground hover:text-text-primary w-full justify-start gap-2 font-mono text-xs',
        className,
      )}
      onClick={onClick}
    >
      <Search className="h-3.5 w-3.5" />
      <span className="flex-1 text-left">{label}</span>
      <kbd
        aria-hidden="true"
        className="bg-sidebar-section-bg text-accent pointer-events-none inline-flex h-6 items-center gap-0.5 rounded-sm px-1.5 font-mono text-xs font-bold"
      >
        <span className="text-xs">&#8984;</span>K
      </kbd>
    </Button>
  );
}
