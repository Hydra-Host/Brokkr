import { Search } from 'lucide-react';
import { Button } from './button';

export function SearchTriggerButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="text-muted-foreground hover:text-text-primary w-full justify-start gap-2 font-mono text-xs"
      onClick={onClick}
    >
      <Search className="h-3.5 w-3.5" />
      <span className="flex-1 text-left">Search...</span>
      <kbd className="bg-muted pointer-events-none inline-flex h-5 items-center gap-0.5 rounded border px-1.5 font-mono text-[10px] font-medium opacity-60">
        <span className="text-xs">&#8984;</span>K
      </kbd>
    </Button>
  );
}
