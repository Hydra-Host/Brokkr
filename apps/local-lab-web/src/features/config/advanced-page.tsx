import { useMemo, useState } from 'react';

import { ApplyBar } from '@/components/config/apply-bar';
import { RejectedWrites } from '@/components/config/rejected-writes';
import { SectionRail, scrollToSection, type RailItem } from '@/components/config/section-rail';
import { UnsavedNavGate } from '@/components/config/unsaved-nav-gate';
import { SectionHeading } from '@/components/console';
import type { ConfigTreeEntry, RejectedEntry } from '@/contract';
import { AREA_SECTIONS, knobAnchor, knobLocation } from '@/features/config/knob-location';
import { tsr } from '@/lib/api';
import { isLocked } from '@/lib/config-tree';
import { thrownBodyError } from '@/lib/errors';
import { useConfigModel } from '@/lib/use-config-model';

const SECTIONS = AREA_SECTIONS.advanced;
const RESIDUE = 'NOT YET EDITABLE';

/** Everything the catalog declares that this page owns, plus the residue no rule claims. */
function partition(entries: ConfigTreeEntry[]): Record<string, ConfigTreeEntry[]> {
  const out: Record<string, ConfigTreeEntry[]> = Object.fromEntries(SECTIONS.map((s) => [s, []]));
  for (const entry of entries) {
    const where = knobLocation(entry.path);
    if (where === null) out[RESIDUE].push(entry);
    else if (where.area === 'advanced') out[where.section].push(entry);
  }
  return out;
}

export function ConfigAdvancedPage() {
  const model = useConfigModel();
  const put = tsr.putStackConfig.useMutation();
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  const [rejected, setRejected] = useState<RejectedEntry[]>([]);
  const [error, setError] = useState('');
  const [active, setActive] = useState<string>();

  const bySection = useMemo(() => partition(model.entries), [model.entries]);
  const dirty = Object.keys(edits).length;

  const save = () => {
    if (dirty === 0) return;
    setError('');
    put.mutate(
      { body: { entries: edits } },
      {
        onSuccess: (res) => {
          setEdits({});
          setRejected(res.body.rejected);
          void model.refetch();
        },
        onError: (err: unknown) => setError(thrownBodyError(err) ?? 'the save was refused'),
      },
    );
  };

  const rail: RailItem[] = SECTIONS.map((id) => ({
    id,
    label: id.toLowerCase(),
    changed: bySection[id].filter((entry) => edits[entry.path] !== undefined).length,
    note: `${bySection[id].length}`,
  }));
  const select = (id: string) => {
    setActive(id);
    scrollToSection(id);
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:h-[calc(100dvh-7rem)] lg:grid-cols-[260px_1fr]">
      <UnsavedNavGate dirty={dirty > 0} what="advanced config" />
      <SectionRail items={rail} activeId={active} onSelect={select} />

      <div className="flex min-h-0 flex-col gap-4 lg:overflow-auto">
        <div className="border-status-warning/50 bg-status-warning/10 text-status-warning rounded-md border px-3 py-2 text-[11px]">
          These change how the stack is built. Most need a redeploy, and the read-only ones say why.
        </div>

        <ApplyBar
          model={{
            seeded: model.seeded !== false,
            overridden: model.entries.filter((entry) => entry.overridden === true).length,
            total: model.entries.length,
            unsaved: dirty,
          }}
          actions={
            <button
              onClick={save}
              disabled={dirty === 0 || put.isPending}
              className="bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1 text-[11px] disabled:opacity-40"
            >
              {put.isPending ? 'saving…' : dirty > 0 ? 'Save config' : 'Saved'}
            </button>
          }
        />

        {model.error && (
          <div className="text-status-offline text-sm">failed to load the config model — {model.error}</div>
        )}
        {error && <div className="text-status-offline text-[11px]">{error}</div>}
        <RejectedWrites rejected={rejected} />

        {SECTIONS.map((section) => (
          <Section
            key={section}
            id={section}
            entries={bySection[section]}
            edits={edits}
            onSet={(path, value) => setEdits((m) => ({ ...m, [path]: value }))}
          />
        ))}
      </div>
    </div>
  );
}

function Section({
  id,
  entries,
  edits,
  onSet,
}: {
  id: string;
  entries: ConfigTreeEntry[];
  edits: Record<string, string | null>;
  onSet: (path: string, value: string) => void;
}) {
  return (
    <div id={id} className="scroll-mt-2 space-y-2">
      <SectionHeading>{id}</SectionHeading>
      <div className="border-border-dim bg-text-dim/[0.02] space-y-2 rounded-lg border p-3">
        {entries.length === 0 ? (
          <div className="text-text-dim text-[11px]">
            {id === 'NOT YET EDITABLE' ? 'every catalogued path has an editor' : 'nothing declared here on this stack'}
          </div>
        ) : (
          entries.map((entry) => (
            <AdvancedField key={entry.path} entry={entry} edit={edits[entry.path]} onSet={onSet} />
          ))
        )}
      </div>
    </div>
  );
}

/** A secret is never rendered as an input, whatever `writable` says: hubPrivateKey is the master
 *  switch for the whole enrolment subsystem and an empty value puts every bridge on the plaintext path. */
function AdvancedField({
  entry,
  edit,
  onSet,
}: {
  entry: ConfigTreeEntry;
  edit: string | null | undefined;
  onSet: (path: string, value: string) => void;
}) {
  const anchor = knobAnchor(entry.path);
  const changed = edit !== undefined;
  const locked = isLocked(entry);
  const readOnly = !entry.writable || entry.secret || locked;
  const shown = edit ?? entry.value ?? '';

  return (
    <div id={anchor} className="flex scroll-mt-2 gap-2">
      <span aria-hidden className={`w-0.5 shrink-0 self-stretch ${changed ? 'bg-accent' : 'bg-transparent'}`} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <label htmlFor={`${anchor}-input`} className="text-text-muted">
            {entry.label}
          </label>
          <span className="text-text-label font-mono text-[10px]">{entry.path}</span>
          {entry.danger && <span className="text-status-warning">⚠</span>}
          {locked && <span className="text-status-warning text-[10px]">🔒 ${entry.pinnedBy}</span>}
        </div>

        {readOnly ? (
          <ReadOnlyValue entry={entry} />
        ) : (
          <Control entry={entry} id={`${anchor}-input`} value={shown} onSet={(v) => onSet(entry.path, v)} />
        )}

        <div className="text-text-dim text-[10px]">{entry.description}</div>
      </div>
    </div>
  );
}

function ReadOnlyValue({ entry }: { entry: ConfigTreeEntry }) {
  const reason = entry.secret
    ? 'shown as state only — its value never reaches this page'
    : entry.pinnedBy
      ? `unset $${entry.pinnedBy} to change it`
      : entry.applyClass === 'inert'
        ? 'nothing reads this path today, so changing it would have no effect'
        : 'no writer owns this path; set it in devenv.local.nix';
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="text-text-primary font-mono text-[11px]">
        {entry.secret ? (entry.valueDigest ? `● keyed ${entry.valueDigest}` : '● set') : (entry.value ?? '(unset)')}
      </span>
      <span className="text-text-label text-[10px]">{reason}</span>
    </div>
  );
}

const INPUT =
  'border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 rounded border px-1.5 py-1 font-mono text-[11px] outline-none';

function Control({
  entry,
  id,
  value,
  onSet,
}: {
  entry: ConfigTreeEntry;
  id: string;
  value: string;
  onSet: (v: string) => void;
}) {
  if (entry.kind === 'bool' || entry.kind === 'select') {
    const options = entry.kind === 'bool' ? ['true', 'false'] : entry.choices;
    return (
      <select id={id} value={value} onChange={(e) => onSet(e.target.value)} className={`${INPUT} w-32`}>
        {options.map((o) => (
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
      type={entry.kind === 'number' || entry.kind === 'port' ? 'number' : 'text'}
      value={value}
      onChange={(e) => onSet(e.target.value)}
      className={`${INPUT} w-40`}
    />
  );
}
