import type { StackKnob } from '@/contract';

const INPUT =
  'border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-full rounded border px-2 py-1 outline-none disabled:cursor-not-allowed disabled:opacity-50';

/** Kind comes from the option's own Nix type, so a control cannot offer a shape the module system
 *  disagrees with. Changed state lives in the row's gutter, not here. */
export function KnobControl({
  knob,
  value,
  disabled,
  id,
  onSet,
}: {
  knob: StackKnob;
  value: string;
  disabled: boolean;
  id: string;
  onSet: (v: string) => void;
}) {
  // a knob the option declares no default for shows empty rather than the string "null"
  const shown = value === '' ? (knob.default ?? '') : value;

  if (knob.kind === 'bool') {
    const on = shown === 'true';
    return (
      <button
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => onSet(on ? 'false' : 'true')}
        className={[
          'w-fit rounded border px-2 py-1 font-mono text-xs transition disabled:cursor-not-allowed disabled:opacity-50',
          on ? 'border-status-online/40 text-status-online/80' : 'border-border-dim text-text-dim',
        ].join(' ')}
      >
        {shown}
      </button>
    );
  }

  if (knob.kind === 'select') {
    return (
      <select
        id={id}
        disabled={disabled}
        value={shown}
        onChange={(e) => onSet(e.target.value)}
        className={`${INPUT} font-mono text-xs`}
      >
        {(knob.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      id={id}
      type={knob.kind === 'number' ? 'number' : 'text'}
      disabled={disabled}
      value={shown}
      onChange={(e) => onSet(e.target.value)}
      className={`${INPUT} font-mono text-xs`}
    />
  );
}
