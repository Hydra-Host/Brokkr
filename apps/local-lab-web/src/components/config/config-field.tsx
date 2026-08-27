import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

import { ProvenanceChips } from '@/components/config/provenance-chips';
import type { FieldProvenance } from '@/lib/config-tree';

/** The sidebar's active-leaf bar, turned vertical. Outside the control, so it competes with neither
 *  the focus border nor the danger tint. */
function ChangedGutter({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`w-0.5 shrink-0 self-stretch ${on ? 'bg-accent shadow-[0_0_4px_var(--color-accent-glow)]' : 'bg-transparent'}`}
    />
  );
}

export interface ConfigFieldProps {
  /** Null when the config model does not declare this path. The field still renders and says so. */
  prov: FieldProvenance | null;
  path: string;
  label: string;
  /** The short machine name an operator greps for, shown beside the label. */
  tag?: string;
  description?: string;
  danger?: boolean;
  anchor: string;
  /** Set when the form holds an unsaved edit for this path, so the row can mark it before any save. */
  dirty?: boolean;
  onRevert?: () => void;
  children: (control: { disabled: boolean; id: string }) => ReactNode;
}

/** In context, not a prop: a field group added later cannot silently opt out, which is how ports and
 *  identity kept showing while the toggle claimed otherwise. Default off for every other consumer. */
export const ChangedOnlyContext = createContext(false);

export function ConfigField({
  prov,
  path,
  label,
  tag,
  description,
  danger,
  anchor,
  dirty,
  onRevert,
  children,
}: ConfigFieldProps) {
  const changedOnly = useContext(ChangedOnlyContext);
  const changed = dirty === true || prov?.overridden === true;
  if (changedOnly && prov?.overridden !== true) return null;
  const canRevert = Boolean(onRevert) && prov?.overridden === true && !prov.locked && prov.revertTo !== null;

  // The label wraps only its own text: a control nested inside a <label> inherits the whole row as its
  // accessible name, which made the revert button announce the entire field.
  const controlId = `${anchor}-input`;

  return (
    <div id={anchor} className="flex scroll-mt-4 gap-2">
      <ChangedGutter on={changed} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <label htmlFor={controlId} className={danger ? 'text-status-offline' : 'text-text-muted'}>
            {label}
          </label>
          {tag && <span className="text-text-label font-mono">{tag}</span>}
          {danger && (
            <span className="text-status-offline" title="changing this weakens a production-path check">
              ⚠
            </span>
          )}
          {canRevert && (
            <button
              type="button"
              onClick={onRevert}
              className="text-accent/80 hover:text-accent"
              title={`revert to ${prov?.revertTo}`}
            >
              revert
            </button>
          )}
          {prov ? (
            <ProvenanceChips prov={prov} />
          ) : (
            <span
              className="text-text-dim ml-auto shrink-0 font-mono text-[10px]"
              title={`${path} is not in the config model — the devenv eval seed failed, or Nix does not declare this knob`}
            >
              ?
            </span>
          )}
        </span>
        {children({ disabled: prov?.locked === true, id: controlId })}
        {description && <span className="text-text-dim text-[10px] leading-snug">{description}</span>}
        {prov?.overridden === true && prov.revertTo !== null && (
          <span className="text-text-dim font-mono text-[10px]">was {prov.revertTo}</span>
        )}
        {prov?.locked && <span className="text-status-warning/70 text-[10px]">{prov.lockReason}</span>}
      </div>
    </div>
  );
}
