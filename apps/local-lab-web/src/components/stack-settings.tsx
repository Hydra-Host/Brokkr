import { useState } from 'react';

import { SectionHeading } from '@/components/console';
import { streamPaths, type RepoBranch, type StackKnob } from '@/contract';
import { tsr } from '@/lib/api';
import { errorMessage, thrownBodyError } from '@/lib/errors';
import { useToast } from '@/lib/toast';
import { useBranchCheckout } from '@/lib/use-branch-checkout';
import { useCcBuild } from '@/lib/use-cc-build';
import { useLogStream, usePaintedHtml } from '@/lib/use-log-stream';
import { useRunTracker } from '@/lib/use-run-tracker';
import { useServiceRoster } from '@/lib/use-service-roster';
import { MAX_COUNTS, MAX_SLOT, useStackConfigForm, type Svc, type Vals } from '@/lib/use-stack-config-form';

export function StackSettings() {
  const form = useStackConfigForm();
  const branch = useBranchCheckout();
  const { ccBuild } = useCcBuild();
  const roster = useServiceRoster();
  const put = tsr.putStackConfig.useMutation();
  const reloadSvc = tsr.reloadService.useMutation();
  const redeploy = tsr.redeployStack.useMutation();
  const stream = useLogStream();
  const reloadPaintRef = usePaintedHtml(stream.logRef, stream.logHtml || 'restarting…');
  const toast = useToast();

  const [reloadOf, setReloadOf] = useState<string | null>(null);
  const runTracker = useRunTracker({
    // detach path: the run passes before the API dies — hold busy for the wedge timeout / app reconnect.
    holdOnTerminal: stream.logText.includes('the control-center API is going down now'),
  });
  const runActive = runTracker.active;

  const catalog = form.catalog;

  // checkout must land before any restart. a failed checkout still runs `after` so the restart is not
  // stranded; a failed save deliberately does not — nothing was written, so there is nothing to restart.
  const persistAll = (after?: () => void) => {
    const pending = branch.pending();
    const fireBranches = () => {
      if (pending === undefined) {
        after?.();
        return;
      }
      branch.checkout(pending, after);
    };
    if (form.dirty) {
      if (form.saveBlocked) {
        form.markSaveRefused();
        return;
      }
      put.mutate(
        { body: form.saveBody() },
        {
          onSuccess: (res) => {
            form.markSaved();
            if (res.body.rejected.length > 0) {
              toast.info(`save dropped unsupported config keys: ${res.body.rejected.join(', ')}`);
            }
            void form.refetch();
            fireBranches();
          },
          // nothing was written, so the edits stay dirty and the restart/checkout chain must not run;
          // the refetch adopts the real values before a retry can save these over them
          onError: (err) => {
            form.markSaveFailed(err);
            void form.refetch();
          },
        },
      );
    } else {
      fireBranches();
    }
  };
  const save = () => persistAll();
  const reloadGroup = (svc: Svc) =>
    reloadSvc.mutate(
      { body: { group: svc } },
      {
        onSuccess: (res) => {
          setReloadOf(svc);
          runTracker.track(res.body.runId);
          stream.open(streamPaths.run(res.body.runId));
          void roster.refetch();
        },
        onError: (err) => toast.error(thrownBodyError(err) ?? errorMessage(err) ?? `failed to reload ${svc}`),
      },
    );
  const opBusy = () => put.isPending || branch.busy || reloadSvc.isPending || redeploy.isPending;
  const reload = (svc: Svc) => {
    if (opBusy() || runActive || form.saveBlocked) return;
    persistAll(() => reloadGroup(svc));
  };
  const doRedeploy = () => {
    if (opBusy() || runActive || form.saveBlocked) return;
    persistAll(() =>
      redeploy.mutate(
        { body: {} },
        {
          onSuccess: (res) => {
            setReloadOf('redeploy');
            runTracker.track(res.body.runId);
            stream.open(streamPaths.run(res.body.runId));
          },
          onError: (err) => toast.error(thrownBodyError(err) ?? errorMessage(err) ?? 'redeploy failed to start'),
        },
      ),
    );
  };

  if (!catalog) {
    if (form.error)
      return <div className="text-status-offline text-sm">failed to load stack config — {form.error}</div>;
    return <div className="text-text-dim text-xs">loading stack config…</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <SectionHeading>Stack</SectionHeading>
        <span className="text-text-dim text-[11px]">
          hub/spoke knobs — saved to <span className="font-mono">stack.local.nix</span> (gitignored devenv overlay);
          apply with Reload.
        </span>
        <button
          onClick={save}
          disabled={(!form.dirty && branch.pending() === undefined) || put.isPending || branch.busy || form.saveBlocked}
          className="bg-accent/20 text-accent hover:bg-accent/30 ml-auto rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {put.isPending || branch.busy
            ? 'saving…'
            : form.dirty || branch.pending() !== undefined
              ? 'Save config'
              : 'Saved'}
        </button>
      </div>

      {(form.saveError || form.seedFailed) && (
        <div className="border-status-offline/40 bg-status-offline/[0.06] text-status-offline/90 space-y-1 rounded-lg border p-3 text-[11px]">
          {form.saveError && <div className="font-mono break-words">{form.saveError}</div>}
          {form.seedFailed && (
            <div>
              <b>Saving is blocked</b> — the <span className="font-mono">devenv eval</span> seed failed, so every field
              below shows a bare default instead of the live <span className="font-mono">stack.local.nix</span>. Saving
              now would erase the fleet topology and every port override. Fix the devenv eval; this panel keeps retrying
              and reloads the real values on its own.
            </div>
          )}
        </div>
      )}

      {form.error && <div className="text-status-offline text-sm">stack config refresh failed — {form.error}</div>}
      {roster.error && <div className="text-status-offline text-sm">service status unavailable — {roster.error}</div>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ServiceCard
          svc="hub"
          knobs={catalog.knobs.hub}
          ports={catalog.ports.hub}
          vals={form.valsOf('hub')}
          branch={branch.effective()}
          branchInput={branch.inputValue()}
          state={roster.svcState('hub')}
          dirty={form.dirty || branch.pending() !== undefined}
          disabled={opBusy() || runActive || form.saveBlocked}
          onSet={(env, v) => form.setVal('hub', env, v)}
          onBranchInput={branch.setInput}
          branchRebuildRequired={branch.rebuildRequired && (ccBuild?.stale ?? true)}
          onReload={() => reload('hub')}
        />
        <ServiceCard
          svc="spoke"
          knobs={catalog.knobs.spoke}
          ports={catalog.ports.spoke}
          vals={form.valsOf('spoke')}
          state={roster.svcState('spoke')}
          dirty={form.dirty || branch.pending() !== undefined}
          disabled={opBusy() || runActive || form.saveBlocked}
          onSet={(env, v) => form.setVal('spoke', env, v)}
          onReload={() => reload('spoke')}
        />
      </div>

      <div className="border-border-dim bg-text-dim/[0.02] space-y-2 rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-text-muted text-[11px] tracking-wide uppercase">Topology</span>
          <Stepper
            label="Hubs"
            value={form.counts.hub}
            max={MAX_COUNTS.hub}
            stats={roster.kindStats('hub')}
            onChange={(n) => form.setCount('hub', n)}
          />
          <Stepper
            label="Spokes / zones"
            value={form.counts.spoke}
            max={MAX_COUNTS.spoke}
            stats={roster.kindStats('spoke')}
            onChange={(n) => form.setCount('spoke', n)}
          />
          <Stepper label="Stack slot" value={form.slot} min={0} max={MAX_SLOT} onChange={form.setSlot} />
          <button
            onClick={doRedeploy}
            disabled={opBusy() || runActive || form.saveBlocked}
            title="Stop, rebuild, and restart the whole hub/spoke roster (applies new counts)"
            className="bg-status-purple/20 text-status-purple hover:bg-status-purple/30 ml-auto rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
          >
            {redeploy.isPending || (runActive && reloadOf === 'redeploy') ? 'redeploying…' : 'Redeploy'}
          </button>
        </div>
        <p className="text-text-dim max-w-3xl text-[11px]">
          Extra spokes are <b>HA replicas of the same zone</b> — same zone, Redis prefix, and BullMQ queues, differing
          only by port (spoke <span className="font-mono">i</span> →{' '}
          <span className="font-mono">{catalog.ports.spoke[0]?.value}+i</span>, gRPC{' '}
          <span className="font-mono">{catalog.ports.spoke[1]?.value}+i</span>); leader election picks which runs
          crons/sync. (Multi-zone isn't a thing yet.) <b>Hub scaling is unavailable</b> — every hub replica probes
          readiness on the same base port (<span className="font-mono">{catalog.ports.hub[0]?.value}</span>), so a
          second hub would report the health of the first and never be independently supervised; the count stays fixed
          at 1 until per-replica probes land. Changing the spoke count needs a{' '}
          <span className="text-status-purple/80">Redeploy</span> (a per-service Reload only restarts that one
          instance).
        </p>
        <p className="text-text-dim max-w-3xl text-[11px]">
          The <b>stack slot</b> owns this stack's ports and subnets — every host-colliding resource derives from it, so
          two stacks can run side by side. Changing it{' '}
          <span className="text-status-purple/80">recreates the whole stack</span> and resets any fleet or port
          customizations to the new slot's defaults; the control center briefly drops and reconnects while the
          recreation runs.
        </p>
      </div>

      <div className="border-border-dim bg-text-dim/[0.02] space-y-3 rounded-lg border p-3">
        <div className="flex items-center gap-2">
          <SectionHeading>Identity &amp; infra</SectionHeading>
          <span className="text-text-dim text-[10px]">
            single source — derived into the pg URL, role, org id, and OS-layer cache
          </span>
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          <IdField
            label="Postgres user"
            value={form.identity.pg.user}
            onSet={(v) => form.updateIdentity((s) => ({ ...s, pg: { ...s.pg, user: v } }))}
          />
          <IdField
            label="Postgres password"
            type="password"
            value={form.identity.pg.password}
            onSet={(v) => form.updateIdentity((s) => ({ ...s, pg: { ...s.pg, password: v } }))}
          />
          <IdField
            label="Postgres db"
            value={form.identity.pg.db}
            onSet={(v) => form.updateIdentity((s) => ({ ...s, pg: { ...s.pg, db: v } }))}
          />
          <IdField
            label="Org UUID"
            value={form.identity.orgId}
            onSet={(v) => form.updateIdentity((s) => ({ ...s, orgId: v }))}
          />
          <IdField
            label="OS-layer CDN origin"
            value={form.osLayer.originHost}
            onSet={(v) => form.updateOsLayer((s) => ({ ...s, originHost: v }))}
          />
          <IdField
            label="OS-layer DNS resolvers"
            value={form.osLayer.resolvers}
            onSet={(v) => form.updateOsLayer((s) => ({ ...s, resolvers: v }))}
          />
        </div>
        <div className="border-border-dim/60 flex flex-col gap-1 border-t pt-2">
          <span className="text-text-dim flex items-center gap-1 text-[11px]">
            LAN access <span className="text-text-dim/60 font-mono">lan.expose</span>
            <InfoBubble
              danger
              text="Binds the sim's loopback-only services (Postgres/Redis/Thanos/Mailpit) and the hub-web/commerce-web Vite servers + the lab API/web to 0.0.0.0, and relaxes Vite's host-header allowlist — so the sim is reachable from other hosts on the LAN/Tailscale (incl. by hostname). OFF = loopback only. The exposed lab control API stays gated by LabAuthGuard (loopback trusted; off-loopback needs LAB_API_TOKEN). nginx, the hub API, and the spoke always bind all interfaces (the simulated VMs need them). Applying this REBUILDS the stack (task down && task up) — these binds are baked into the devenv process defs at bring-up, so Redeploy restarts the whole stack and this control center briefly drops before reconnecting. Exposes auth-less dev datastores to the network — only enable on a trusted network."
            />
          </span>
          <button
            onClick={() => form.updateLan((s) => ({ expose: !s.expose }))}
            className={`w-fit rounded-md border px-2 py-1 font-mono text-xs ${
              form.lan.expose
                ? 'border-status-warning/60 text-status-warning/90 bg-status-warning/10'
                : 'border-border-dim text-text-dim'
            }`}
          >
            {form.lan.expose ? 'exposed (0.0.0.0)' : 'loopback only'}
          </button>
        </div>
        <div className="border-border-dim/60 flex flex-col gap-1 border-t pt-2">
          <span className="text-text-dim flex items-center gap-1 text-[11px]">
            Observability <span className="text-text-dim/60 font-mono">telemetry.enable</span>
            <InfoBubble text="Bring up the local OpenTelemetry sink (OTel collector → Tempo traces + span-metrics → the existing Thanos, Grafana UI with the repo dashboards) and point the hub's OTLP exporter at it. OFF = the hermetic stack pays nothing. Loopback-only — never faces the LAN. Applies on Save (no rebuild): the observability processes start/stop and hub-api reloads to pick up (or drop) OTEL_EXPORTER_OTLP_ENDPOINT." />
          </span>
          <button
            onClick={() => form.updateTelemetry((s) => ({ enable: !s.enable }))}
            className={`w-fit rounded-md border px-2 py-1 font-mono text-xs ${
              form.telemetry.enable ? 'border-accent/60 text-accent bg-accent/10' : 'border-border-dim text-text-dim'
            }`}
          >
            {form.telemetry.enable ? 'sink enabled' : 'disabled'}
          </button>
          <span className="text-text-dim/70 text-[10px]">
            When enabled, Grafana appears under <span className="font-mono">/APPS/</span> in the sidebar.
          </span>
        </div>
        <p className="text-status-warning/60 text-[10px]">
          Changing the Postgres user/password/db only applies on a fresh datastore (the role is created once); the org
          id needs a Seed DB / fleet rebuild to propagate. <b>LAN access</b> (and datastore port changes) rebuild the
          whole stack on Redeploy — this control center briefly drops and reconnects. Save writes{' '}
          <span className="font-mono">stack.local.nix</span>; apply with Redeploy.
        </p>
      </div>

      <div className="border-border-dim bg-text-dim/[0.02] space-y-3 rounded-lg border p-3">
        <div className="flex items-center gap-2">
          <SectionHeading>Service ports</SectionHeading>
          <span className="text-text-dim text-[10px]">
            datastore + sim ports (config.ports) — the hub/spoke replica ports above and the observability sink ports
            below stay 🔒 read-only
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          {catalog.servicePorts.map((p) => (
            <PortField
              key={p.key}
              label={p.label}
              info={p.info}
              value={form.portVals[p.key] ?? String(p.value)}
              onSet={(v) => form.setPort(p.key, v)}
              readOnly={p.readOnly}
            />
          ))}
        </div>
        <p className="text-status-warning/60 text-[10px]">
          A blank or out-of-range field reverts to the default. Save writes{' '}
          <span className="font-mono">stack.local.nix</span>; apply with Redeploy (datastores restart). vBMC/Redfish are
          read by the sim BMC daemons at startup — those apply on the next fleet rebuild.
        </p>
      </div>

      {reloadOf && (
        <div className="space-y-1.5">
          <SectionHeading>{reloadOf === 'redeploy' ? 'redeploy' : `${reloadOf} reload`}</SectionHeading>
          <pre
            ref={reloadPaintRef}
            className="border-border-dim bg-bg-secondary text-text-primary max-h-64 overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre"
          />
          {(stream.degraded || stream.disconnected) && (
            <p className="text-status-warning/70 text-[10px]">
              {stream.disconnected
                ? 'log stream disconnected — the run record may have been lost to an API restart'
                : 'log stream dropped — reconnecting…'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function IdField({
  label,
  value,
  onSet,
  type,
}: {
  label: string;
  value: string;
  onSet: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-text-muted text-[11px]">{label}</span>
      <input
        type={type ?? 'text'}
        value={value}
        onChange={(e) => onSet(e.target.value)}
        className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 rounded border px-1.5 py-1 font-mono text-[11px] outline-none"
      />
    </label>
  );
}

function PortField({
  label,
  value,
  info,
  onSet,
  readOnly,
}: {
  label: string;
  value: string;
  info?: string;
  onSet: (v: string) => void;
  readOnly?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-text-muted flex items-center gap-1 text-[11px]">
        {label}
        {readOnly && <span title="read-only — loopback-only observability sink port">🔒</span>}
        {info && <InfoBubble text={info} />}
      </span>
      <input
        type="number"
        min={1}
        max={65535}
        value={value}
        disabled={readOnly}
        onChange={(e) => onSet(e.target.value)}
        className={`border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 rounded border px-1.5 py-1 font-mono text-[11px] outline-none ${
          readOnly ? 'cursor-not-allowed opacity-50' : ''
        }`}
      />
    </label>
  );
}

function Stepper({
  label,
  value,
  max,
  min = 1,
  stats,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  min?: number;
  stats?: { total: number; ready: number; running: number };
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-text-muted text-xs">{label}</span>
      <div className="border-border-dim flex items-center overflow-hidden rounded-md border">
        <button
          onClick={() => onChange(value - 1)}
          disabled={value <= min}
          className="text-text-muted hover:bg-hover-bg px-2 py-0.5 disabled:opacity-30"
        >
          −
        </button>
        <span className="text-text-primary px-2.5 py-0.5 font-mono text-sm tabular-nums">{value}</span>
        <button
          onClick={() => onChange(value + 1)}
          disabled={value >= max}
          className="text-text-muted hover:bg-hover-bg px-2 py-0.5 disabled:opacity-30"
        >
          +
        </button>
      </div>
      {stats && (
        <span className="text-text-dim font-mono text-[10px]" title="ready / running / configured live instances">
          {stats.ready}✓ {stats.running}▶ /{stats.total}
        </span>
      )}
    </div>
  );
}

function InfoBubble({ text, danger }: { text: string; danger?: boolean }) {
  return (
    <span className="group/info relative inline-flex">
      <span
        title={text}
        className={[
          'inline-flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full border text-[9px] font-semibold select-none',
          danger ? 'border-status-offline/60 text-status-offline' : 'border-border-dim text-text-muted',
        ].join(' ')}
      >
        i
      </span>
      <span
        role="tooltip"
        className={[
          'bg-bg-secondary pointer-events-none absolute top-5 left-0 z-50 hidden w-64 rounded-md border px-2.5 py-1.5',
          'text-[11px] leading-snug font-normal normal-case shadow-lg group-hover/info:block',
          danger ? 'border-status-offline/40 text-status-offline/90' : 'border-border-dim text-text-primary',
        ].join(' ')}
      >
        {text}
      </span>
    </span>
  );
}

function KnobField({ knob, value, onSet }: { knob: StackKnob; value?: string; onSet: (v: string) => void }) {
  const overridden = value != null && value !== '' && value !== knob.default;
  const shown = value == null || value === '' ? knob.default : value;
  const danger = !!knob.danger;
  const tint = danger
    ? 'border-status-offline/50 text-status-offline/90'
    : overridden
      ? 'border-accent/40 text-accent/90'
      : 'border-border-dim text-text-primary';
  const labelEl = (
    <span
      className={`mb-0.5 flex items-center gap-1 text-[11px] ${danger ? 'text-status-offline' : 'text-text-muted'}`}
    >
      <span>
        {knob.label} <span className="text-text-label font-mono">{knob.env}</span>
      </span>
      {knob.info && <InfoBubble text={knob.info} danger={danger} />}
    </span>
  );

  if (knob.kind === 'bool') {
    const on = shown === 'true';
    const boolColor = danger
      ? on
        ? 'border-status-offline/50 text-status-offline/90'
        : 'border-status-offline/70 text-status-offline bg-status-offline/10'
      : on
        ? 'border-status-online/40 text-status-online/80'
        : 'border-border-dim text-text-dim';
    return (
      <div>
        {labelEl}
        <button
          onClick={() => onSet(on ? 'false' : 'true')}
          className={`rounded-md border px-2 py-1 font-mono text-xs ${boolColor} ${overridden && !danger ? 'ring-accent/40 ring-1' : ''}`}
        >
          {shown}
        </button>
      </div>
    );
  }
  return (
    <label className="block">
      {labelEl}
      {knob.kind === 'select' ? (
        <select
          value={shown}
          onChange={(e) => onSet(e.target.value)}
          className={`bg-bg-primary focus:border-accent/50 w-full rounded border px-2 py-1 text-sm outline-none ${tint}`}
        >
          {(knob.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={knob.kind === 'number' ? 'number' : 'text'}
          value={shown}
          onChange={(e) => onSet(e.target.value)}
          className={`bg-bg-primary focus:border-accent/50 w-full rounded border px-2 py-1 font-mono text-xs outline-none ${tint}`}
        />
      )}
    </label>
  );
}

function BranchField({
  branch,
  value,
  onChange,
  rebuildRequired,
}: {
  branch: RepoBranch | null;
  value: string;
  onChange: (v: string) => void;
  rebuildRequired?: boolean;
}) {
  const dirty = branch?.branch != null && value.trim() !== '' && value.trim() !== branch.branch;
  const errored = !!branch?.error;
  const tint = errored
    ? 'border-status-offline/50 text-status-offline/90'
    : dirty
      ? 'border-accent/40 text-accent/90'
      : 'border-border-dim text-text-primary';
  return (
    <label className="block">
      <span className="text-text-muted mb-0.5 flex items-center gap-1 text-[11px]">
        <span>
          Branch <span className="text-text-label font-mono">git rev-parse</span>
        </span>
        <InfoBubble text="Hub and spoke run from one checkout, so this single branch drives both. Reads the current branch on load. Editing + Save Config does an idempotent checkout: existing local → checkout; remote-only → checkout -b X origin/X (tracks); neither → checkout -b X (from HEAD). A dirty working tree blocks the checkout — the error surfaces here." />
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={branch?.error ?? (branch == null ? 'loading…' : 'branch name')}
        className={`bg-bg-primary focus:border-accent/50 w-full rounded border px-2 py-1 font-mono text-xs outline-none ${tint}`}
      />
      {branch?.error && <div className="text-status-offline/80 mt-0.5 font-mono text-[11px]">{branch.error}</div>}
      {rebuildRequired && (
        <span className="text-status-warning text-[11px]">
          checkout moved past the running control-center build — rebuild + restart the lab API (task up) before
          destructive ops
        </span>
      )}
    </label>
  );
}

function ServiceCard({
  svc,
  knobs,
  ports,
  vals,
  branch,
  branchInput,
  branchRebuildRequired,
  state,
  dirty,
  disabled,
  onSet,
  onBranchInput,
  onReload,
}: {
  svc: Svc;
  knobs: StackKnob[];
  ports: { label: string; value: string; note?: string }[];
  vals: Vals;
  branch?: RepoBranch | null;
  branchInput?: string;
  branchRebuildRequired?: boolean;
  state?: { running: boolean; ready: boolean };
  dirty: boolean;
  disabled?: boolean;
  onSet: (env: string, v: string) => void;
  onBranchInput?: (v: string) => void;
  onReload: () => void;
}) {
  const status = state?.ready ? 'ready' : state?.running ? 'running' : 'down';
  const dot = state?.ready ? 'bg-status-online' : state?.running ? 'bg-status-warning' : 'bg-text-dim';
  const groups = [...new Set(knobs.map((k) => k.group))];
  return (
    <div className="border-border-dim bg-text-dim/[0.02] space-y-3 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <span className="text-text-primary text-sm capitalize">{svc}</span>
        <span className="text-text-dim text-[11px]">{status}</span>
        <button
          onClick={onReload}
          disabled={disabled}
          title={dirty ? `save changes + restart ${svc}` : `restart ${svc} with current config`}
          className="bg-status-warning/15 text-status-warning hover:bg-status-warning/25 ml-auto rounded-md px-2.5 py-1 text-xs disabled:opacity-40"
        >
          {dirty ? `Save + reload ${svc}` : `Reload ${svc}`}
        </button>
      </div>

      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group} className="space-y-1.5">
            <div className="text-text-dim text-[10px] tracking-wide uppercase">{group}</div>
            {knobs
              .filter((k) => k.group === group)
              .map((k) => (
                <KnobField key={k.env} knob={k} value={vals[k.env]} onSet={(v) => onSet(k.env, v)} />
              ))}
            {group === 'Location' && onBranchInput && (
              <BranchField
                branch={branch ?? null}
                value={branchInput ?? ''}
                onChange={onBranchInput}
                rebuildRequired={branchRebuildRequired}
              />
            )}
          </div>
        ))}
      </div>

      <div className="space-y-1">
        <span className="text-text-muted text-[11px] tracking-wide uppercase">Ports</span>
        <div className="flex flex-wrap gap-1.5">
          {ports.map((p) => (
            <span
              key={p.label}
              title={p.note ?? 'read-only replica port (datastore/sim ports are editable below)'}
              className="border-border-dim text-text-dim rounded border px-1.5 py-0.5 font-mono text-[10px]"
            >
              {p.label}:{p.value}
              {p.note ? ' 🔒' : ''}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
