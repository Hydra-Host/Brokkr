export interface RailItem {
  id: string;
  label: string;
  /** Knobs in this section whose value differs from their default. */
  changed: number;
  note?: string;
}

/** The same accent bar the sidebar marks its active leaf with, so the reader already knows it. */
function ChangedMark({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="text-accent ml-auto flex shrink-0 items-center gap-1 text-[10px]" title={`${count} changed`}>
      <span className="bg-accent h-2.5 w-0.5 shadow-[0_0_4px_var(--color-accent-glow)]" />
      {count}
    </span>
  );
}

export function SectionRail({
  items,
  activeId,
  onSelect,
  header,
  footer,
}: {
  items: RailItem[];
  activeId?: string;
  onSelect: (id: string) => void;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="space-y-3 pr-1 lg:min-h-0 lg:overflow-auto">
      {header}
      <div className="space-y-0.5">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => onSelect(item.id)}
            aria-current={activeId === item.id ? 'true' : undefined}
            className={[
              'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] tracking-wide uppercase transition',
              activeId === item.id
                ? 'bg-accent/10 text-accent'
                : 'text-text-dim hover:bg-hover-bg hover:text-text-muted',
            ].join(' ')}
          >
            <span className="min-w-0 truncate">{item.label}</span>
            {item.note && <span className="text-text-label shrink-0 normal-case">{item.note}</span>}
            <ChangedMark count={item.changed} />
          </button>
        ))}
      </div>
      {footer}
    </div>
  );
}

/** Scroll within one page rather than navigate: a back button that walked section by section would be
 *  worse than none. */
export const scrollToSection = (id: string): void => {
  document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
};
