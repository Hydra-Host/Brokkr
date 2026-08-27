import { Link } from '@tanstack/react-router';

import { ApiTokenCard } from '@/components/config/api-token-card';
import { ApplyBar } from '@/components/config/apply-bar';
import { SectionHeading } from '@/components/console';
import type { ConfigTreeEntry } from '@/contract';
import { overriddenByArea, overriddenCount, sourceSummary, type OverriddenRow } from '@/features/config/config-model';
import { areaIsBuilt, type ConfigArea } from '@/features/config/knob-location';
import { tsr } from '@/lib/api';
import { errorMessage } from '@/lib/errors';

const AREA_LABEL: Record<ConfigArea, string> = {
  stack: 'Stack',
  zones: 'Zones',
  fleet: 'Fleet',
  advanced: 'Advanced',
};

const SOURCE_NOTE: Record<string, string> = {
  'stack.local.nix': 'written by this control center',
  'devenv.local.nix': 'hand-edited — the control center does not write this file',
  '.env': 'hand-edited — loaded by devenv dotenv',
};

export function ConfigOverview() {
  const q = tsr.getConfigTree.useQuery({ queryKey: ['config-tree'] });
  const body = q.data?.status === 200 ? q.data.body : null;
  const err = errorMessage(q.error);
  const entries: ConfigTreeEntry[] = body?.entries ?? [];
  const areas = overriddenByArea(entries);
  const sources = sourceSummary(entries);

  return (
    <div className="space-y-5">
      <ApplyBar model={{ seeded: body?.seeded ?? true, overridden: overriddenCount(entries), total: entries.length }} />

      {err && <div className="text-status-offline text-sm">failed to load the config model — {err}</div>}
      {!err && !body && <div className="text-text-dim text-xs">loading…</div>}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <SectionHeading>What this stack changed</SectionHeading>
          <span className="text-text-dim text-[11px]">
            every knob whose value differs from the value Nix declares — each row opens the field that owns it
          </span>
        </div>
        {body && areas.length === 0 && (
          <div className="text-text-dim text-[11px]">nothing overridden — this stack runs the declared defaults</div>
        )}
        {areas.map((area) => (
          <div key={area.area} className="space-y-1">
            <div className="text-text-dim text-[10px] tracking-wide uppercase">{AREA_LABEL[area.area]}</div>
            <div className="divide-border-dim divide-y">
              {area.rows.map((row) => (
                <OverriddenLine key={row.entry.path} row={row} area={area.area} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <SectionHeading>Sources</SectionHeading>
          <span className="text-text-dim text-[11px]">where the overrides above are defined</span>
        </div>
        {body && sources.length === 0 && <div className="text-text-dim text-[11px]">no overrides defined</div>}
        <div className="divide-border-dim divide-y">
          {sources.map((source) => (
            <div key={source.label} className="flex flex-wrap items-baseline gap-2 py-1 text-[11px]">
              <span className={source.kind === 'pin' ? 'text-status-warning font-mono' : 'text-accent font-mono'}>
                {source.label}
              </span>
              <span className="text-text-dim">
                {source.count} knob{source.count === 1 ? '' : 's'}
              </span>
              <span className="text-text-dim">
                ·{' '}
                {source.kind === 'pin'
                  ? 'an environment pin outranks the overlay, so the field is locked'
                  : (SOURCE_NOTE[source.label] ?? 'a definition site the module system reported')}
              </span>
            </div>
          ))}
        </div>
        {body && (
          <div className="text-text-dim text-[11px]">
            seed {body.seeded ? '✓ devenv eval succeeded' : '✗ devenv eval failed — values below are bare defaults'}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <SectionHeading>This browser</SectionHeading>
          <span className="text-text-dim text-[11px]">
            stored here, not in the stack — it never leaves this browser
          </span>
        </div>
        <ApiTokenCard />
      </div>
    </div>
  );
}

function OverriddenLine({ row, area }: { row: OverriddenRow; area: ConfigArea }) {
  const { entry, source } = row;
  return (
    <div className="flex flex-wrap items-baseline gap-2 py-1 text-[11px]">
      <span className="bg-accent h-3 w-0.5 shrink-0 self-center shadow-[0_0_4px_var(--color-accent-glow)]" />
      <span className="text-text-muted min-w-0 truncate" title={entry.description}>
        {entry.label}
      </span>
      <span className="text-text-label shrink-0 font-mono">{entry.path}</span>
      <span className="text-text-dim min-w-0 font-mono break-all">
        {entry.secret ? '***' : `${entry.default} → ${entry.value}`}
      </span>
      <span
        className={`ml-auto shrink-0 font-mono ${source.kind === 'pin' ? 'text-status-warning' : 'text-accent/80'}`}
        title={source.title}
      >
        {source.label}
      </span>
      {areaIsBuilt(area) ? (
        <Link to={row.route} hash={row.anchor} className="text-accent/80 hover:text-accent shrink-0">
          open →
        </Link>
      ) : (
        <span className="text-text-label shrink-0" title={`no editor owns ${row.entry.path} yet`}>
          not editable yet
        </span>
      )}
    </div>
  );
}
