import { THANOS_WINDOWS, type ThanosWindow } from './range-window';

export function WindowChips({ value, onChange }: { value: ThanosWindow; onChange: (w: ThanosWindow) => void }) {
  return (
    <div className="flex items-center gap-1">
      {THANOS_WINDOWS.map((w) => (
        <button
          key={w}
          onClick={() => onChange(w)}
          className={[
            'rounded border px-2 py-0.5 font-mono text-[11px] transition',
            value === w
              ? 'border-accent/50 bg-accent/10 text-accent'
              : 'border-border-dim text-text-dim hover:text-text-muted',
          ].join(' ')}
        >
          {w}
        </button>
      ))}
    </div>
  );
}
