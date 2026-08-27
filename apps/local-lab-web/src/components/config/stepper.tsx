/** Disabled at a bound rather than silently clamping, so a stepper that cannot move says why on the
 *  control rather than in prose further down. */
export function Stepper({
  label,
  tag,
  value,
  min,
  max,
  disabledReason,
  locked,
  onChange,
}: {
  label: string;
  tag: string;
  value: number;
  min: number;
  max: number;
  disabledReason?: string;
  /** Set when a pin holds the path: both buttons go inert and the reason becomes their title. */
  locked?: string;
  onChange: (n: number) => void;
}) {
  const btn = 'text-text-muted hover:bg-hover-bg px-1.5 py-0.5 disabled:opacity-30 disabled:cursor-not-allowed';
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-[11px]">
        <span className="text-text-muted">{label}</span>
        <span className="text-text-label font-mono">{tag}</span>
      </span>
      <div className="border-border-dim flex w-fit items-center overflow-hidden rounded border font-mono text-xs">
        <button
          type="button"
          onClick={() => onChange(value - 1)}
          disabled={locked !== undefined || value <= min}
          title={locked ?? (value <= min ? `${min} is the lowest this can go` : undefined)}
          className={btn}
        >
          −
        </button>
        <span className="text-text-primary px-2">{value}</span>
        <button
          type="button"
          onClick={() => onChange(value + 1)}
          disabled={locked !== undefined || value >= max}
          title={locked ?? (value >= max ? (disabledReason ?? `${max} is the highest this can go`) : undefined)}
          className={btn}
        >
          +
        </button>
      </div>
      {value >= max && disabledReason && <span className="text-text-dim text-[10px]">{disabledReason}</span>}
    </div>
  );
}
