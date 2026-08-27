import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Warehouse } from 'lucide-react';

const CHIP_CLASS =
  'group border-border-dim bg-muted/40 text-foreground/90 hover:border-primary/40 hover:bg-primary/10 hover:text-primary inline-flex max-w-full items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs font-medium transition-colors';

const CHIP_ICON_CLASS = 'text-muted-foreground group-hover:text-primary size-3.5 shrink-0 transition-colors';

const CHIP_ARROW_CLASS = 'size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100';

export function ZoneChip({ id, name }: { id: string; name: string }) {
  return (
    <Link to="/dcim/zones/$zoneId" params={{ zoneId: id }} onClick={(e) => e.stopPropagation()} className={CHIP_CLASS}>
      <Warehouse className={CHIP_ICON_CLASS} />
      <span className="truncate">{name}</span>
      <ArrowUpRight className={CHIP_ARROW_CLASS} />
    </Link>
  );
}
