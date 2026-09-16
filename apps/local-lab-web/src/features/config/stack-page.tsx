import { useState } from 'react';

import { ApplyBar } from '@/components/config/apply-bar';
import { ChangedOnlyContext, ConfigField } from '@/components/config/config-field';
import { ConfigSearch } from '@/components/config/config-search';
import { KnobControl } from '@/components/config/knob-control';
import { RejectedWrites } from '@/components/config/rejected-writes';
import { scrollToSection, SectionRail } from '@/components/config/section-rail';
import { Stepper } from '@/components/config/stepper';
import { UnsavedNavGate } from '@/components/config/unsaved-nav-gate';
import { SectionHeading } from '@/components/console';
import {
  APPLY_CLASS_RANK,
  applyClassFor,
  LanModeSchema,
  strongestApplyClass,
  type ApplyClass,
  type LanMode,
  type RejectedEntry,
  type StackConfig,
  type StackKnob,
} from '@/contract';
import { applyCosts } from '@/features/config/apply-model';
import { changedBySection } from '@/features/config/config-model';
import { AREA_SECTIONS, knobAnchor } from '@/features/config/knob-location';
import { tsr } from '@/lib/api';
import { useReportDirty } from '@/lib/config-dirty';
import { useBranchCheckout } from '@/lib/use-branch-checkout';
import { useConfigModel } from '@/lib/use-config-model';
import { MAX_SLOT, useStackConfigForm, type Svc } from '@/lib/use-stack-config-form';

const SECTIONS = AREA_SECTIONS.stack;
const SVC_OF: Partial<Record<string, Svc>> = { HUB: 'hub', SPOKE: 'spoke' };

export function ConfigStackPage() {
  const form = useStackConfigForm();
  const model = useConfigModel();
  const branch = useBranchCheckout();
  const put = tsr.putStackConfig.useMutation();
  const [rejected, setRejected] = useState<RejectedEntry[]>([]);
  const [active, setActive] = useState<string>();
  const [changedOnly, setChangedOnly] = useState(false);
  useReportDirty('stack', form.dirty);

  const catalog = form.catalog;
  const counts = changedBySection(model.entries, 'stack');
  // the pre-save cost, which the apply panel cannot answer: it reports what is already written.
  const dirtyPaths = form.dirty ? Object.keys(form.saveBody().entries) : [];
  const dirtyClasses = [...new Set(dirtyPaths.map(applyClassFor).filter((c): c is ApplyClass => c !== null))];
  const strongestDirty = strongestApplyClass(dirtyClasses);
  const needsRedeploy = strongestDirty !== null && APPLY_CLASS_RANK[strongestDirty] >= APPLY_CLASS_RANK.redeploy;
  const rail = SECTIONS.map((id) => ({
    id,
    label: id,
    changed: counts.find((c) => c.section === id)?.changed ?? 0,
  }));

  const select = (id: string) => {
    setActive(id);
    scrollToSection(id);
  };

  // `after` runs only on a successful write — there is nothing to restart when nothing was written.
  const persist = (after?: () => void) => {
    if (!form.dirty) {
      after?.();
      return;
    }
    if (form.saveBlocked) {
      form.markSaveRefused();
      return;
    }
    put.mutate(
      { body: form.saveBody() },
      {
        onSuccess: (res) => {
          form.markSaved();
          setRejected(res.body.rejected);
          void form.refetch();
          after?.();
        },
        onError: (err) => {
          form.markSaveFailed(err);
          void form.refetch();
        },
      },
    );
  };

  const withBranch = (after?: () => void) => () => {
    const pending = branch.pending();
    if (pending === undefined) {
      after?.();
      return;
    }
    branch.checkout(pending, after);
  };
  const save = () => persist(withBranch());

  return (
    <div className="grid grid-cols-1 gap-6 lg:h-full lg:grid-cols-[260px_1fr]">
      <UnsavedNavGate dirty={form.dirty} what="stack config" />
      <SectionRail
        items={rail}
        activeId={active}
        onSelect={select}
        footer={
          <button
            onClick={() => setChangedOnly((v) => !v)}
            aria-pressed={changedOnly}
            className={[
              'w-full rounded border px-2 py-1 text-[10px] tracking-wide uppercase transition',
              changedOnly
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-border-dim text-text-muted hover:bg-hover-bg',
            ].join(' ')}
            title="Hide every knob still sitting on the value Nix declares"
          >
            changed only
          </button>
        }
        header={
          <ConfigSearch
            entries={model.entries}
            onPick={(hit) => {
              setActive(hit.section);
              scrollToSection(hit.anchor);
            }}
          />
        }
      />

      <div className="flex min-h-0 flex-col gap-4 lg:overflow-auto">
        <ApplyBar
          model={{
            seeded: form.seedFailed ? false : true,
            overridden: counts.reduce((n, c) => n + c.changed, 0),
            total: model.entries.length,
            unsaved: dirtyPaths.length,
            cost: applyCosts(dirtyClasses).join(' · ') || undefined,
          }}
          actions={
            <button
              onClick={save}
              disabled={!form.dirty || put.isPending}
              title={needsRedeploy ? 'saving alone does not apply this — the panel above offers the run' : undefined}
              className="bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1 text-[11px] disabled:opacity-40"
            >
              {put.isPending ? 'saving…' : form.dirty ? 'Save config' : 'Saved'}
            </button>
          }
        />

        {form.error && (
          <div className="text-status-offline text-sm">failed to load the stack config — {form.error}</div>
        )}
        {form.saveError && <div className="text-status-offline font-mono text-[11px]">{form.saveError}</div>}
        {model.error && (
          <div className="text-status-warning text-sm">
            provenance could not be read — {model.error}. Every source chip below reads as unknown, which is not the
            same as sitting on its default.
          </div>
        )}
        <RejectedWrites
          rejected={rejected}
          note="The rest of the overlay saved. A key an environment pin holds outranks the overlay, and a key the catalog does not declare has nowhere to go."
        />
        {!catalog && !form.error && <div className="text-text-dim text-xs">loading…</div>}

        <ChangedOnlyContext.Provider value={changedOnly}>
          {catalog &&
            SECTIONS.map((section) => (
              <Section
                key={section}
                id={section}
                form={form}
                model={model}
                catalog={catalog}
                branch={branch}
                changedOnly={changedOnly}
              />
            ))}
        </ChangedOnlyContext.Provider>
      </div>
    </div>
  );
}

type Form = ReturnType<typeof useStackConfigForm>;
type Model = ReturnType<typeof useConfigModel>;
type Catalog = NonNullable<Form['catalog']>;

type Branch = ReturnType<typeof useBranchCheckout>;

function Section({
  id,
  form,
  model,
  catalog,
  branch,
  changedOnly,
}: {
  id: string;
  form: Form;
  model: Model;
  catalog: Catalog;
  branch: Branch;
  changedOnly: boolean;
}) {
  const svc = SVC_OF[id];
  return (
    <div id={id} className="scroll-mt-2 space-y-3">
      <SectionHeading>{id}</SectionHeading>
      <div className="border-border-dim bg-text-dim/[0.02] space-y-3 rounded-lg border p-3">
        {svc && (
          <ServiceKnobs
            svc={svc}
            knobs={catalog.knobs[svc]}
            form={form}
            model={model}
            branch={id === 'HUB' ? branch : undefined}
            changedOnly={changedOnly}
          />
        )}
        {id === 'IDENTITY' && <IdentityFields form={form} model={model} />}
        {id === 'PORTS' && <PortFields form={form} model={model} catalog={catalog} />}
        {id === 'TOPOLOGY' && <TopologyFields form={form} model={model} catalog={catalog} />}
        {id === 'STACK' && <StackFields form={form} model={model} />}
      </div>
    </div>
  );
}

function ServiceKnobs({
  svc,
  knobs,
  form,
  model,
  branch,
  changedOnly,
}: {
  svc: Svc;
  knobs: StackKnob[];
  form: Form;
  model: Model;
  branch?: Branch;
  changedOnly: boolean;
}) {
  const vals = form.valsOf(svc);
  const shown = changedOnly ? knobs.filter((k) => model.provenanceOf(k.path)?.overridden === true) : knobs;
  const groups = [...new Set(shown.map((k) => k.group))];
  if (shown.length === 0) {
    return <div className="text-text-dim text-[11px]">every {svc} knob is on the value Nix declares</div>;
  }
  return (
    <>
      {groups.map((group) => (
        <div key={group} className="space-y-2">
          <div className="text-text-dim text-[10px] tracking-wide uppercase">{group}</div>
          {shown
            .filter((k) => k.group === group)
            .map((knob) => {
              const path = knob.path;
              return (
                <ConfigField
                  key={knob.env}
                  prov={model.provenanceOf(path)}
                  path={path}
                  label={knob.label}
                  tag={knob.env}
                  description={knob.info}
                  danger={knob.danger}
                  anchor={knobAnchor(path)}
                  dirty={vals[knob.env] != null && vals[knob.env] !== '' && vals[knob.env] !== knob.default}
                  onRevert={() => form.setVal(svc, knob.env, null)}
                >
                  {({ disabled, id }) => (
                    <KnobControl
                      knob={knob}
                      value={vals[knob.env] ?? ''}
                      disabled={disabled}
                      id={id}
                      onSet={(v) => form.setVal(svc, knob.env, v)}
                    />
                  )}
                </ConfigField>
              );
            })}
          {group === 'Location' && branch && <BranchField branch={branch} />}
        </div>
      ))}
    </>
  );
}

/** Not a knob: nothing in the overlay records it, so it carries no provenance. */
function BranchField({ branch }: { branch: Branch }) {
  const dirty = branch.pending() !== undefined;
  const effective = branch.effective();
  return (
    <div className="flex gap-2">
      <span aria-hidden className={`w-0.5 shrink-0 self-stretch ${dirty ? 'bg-accent' : 'bg-transparent'}`} />
      <label className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[11px]">
          <span className="text-text-muted">Branch</span>
          <span className="text-text-label font-mono">git rev-parse</span>
          {branch.rebuildRequired && (
            <span className="text-status-warning/80 text-[10px]">checked out — rebuild to run it</span>
          )}
        </span>
        <input
          value={branch.inputValue()}
          onChange={(e) => branch.setInput(e.target.value)}
          disabled={branch.busy}
          placeholder={effective?.branch ?? 'detached'}
          className={`border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-full rounded border px-2 py-1 font-mono text-xs outline-none disabled:opacity-50 ${dirty ? 'border-accent/40 text-accent/90' : ''}`}
        />
        {effective?.error && <span className="text-status-offline text-[10px]">{effective.error}</span>}
      </label>
    </div>
  );
}

const TEXT_INPUT =
  'border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-full rounded border px-2 py-1 font-mono text-xs outline-none disabled:cursor-not-allowed disabled:opacity-50';

const LAN_MODE_HELP: Record<LanMode, string> = {
  loopback:
    'Binds 127.0.0.1 only. A loopback caller is trusted with no token; nothing off this box can reach the stack.',
  direct:
    'Binds the LAN — the bind address, else every interface — in cleartext, with no TLS anywhere. Loopback stays trusted; every off-loopback caller must present a token.',
  fronted:
    'Binds nothing outward, for a terminator you run yourself (tailscale serve, ssh -L, caddy). It turns the loopback grant OFF: the terminator dials 127.0.0.1, so every caller it serves arrives as a loopback peer, and EVERY caller — loopback included — must then present a token.',
};

function PlainField({
  path,
  label,
  model,
  value,
  onSet,
  secret,
  description,
}: {
  path: string;
  label: string;
  model: Model;
  value: string;
  onSet: (v: string) => void;
  secret?: boolean;
  description?: string;
}) {
  const prov = model.provenanceOf(path);
  return (
    <ConfigField prov={prov} path={path} label={label} tag={path} description={description} anchor={knobAnchor(path)}>
      {({ disabled, id }) => (
        <input
          id={id}
          type={secret ? 'password' : 'text'}
          disabled={disabled}
          value={value}
          onChange={(e) => onSet(e.target.value)}
          className={TEXT_INPUT}
        />
      )}
    </ConfigField>
  );
}

function IdentityFields({ form, model }: { form: Form; model: Model }) {
  const { pg } = form.identity;
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      <PlainField
        path="identity.pg.user"
        label="Postgres user"
        model={model}
        value={pg.user}
        onSet={(v) => form.updateIdentity((s) => ({ ...s, pg: { ...s.pg, user: v } }))}
      />
      <PlainField
        path="identity.pg.db"
        label="Postgres database"
        model={model}
        value={pg.db}
        onSet={(v) => form.updateIdentity((s) => ({ ...s, pg: { ...s.pg, db: v } }))}
      />
      <PlainField
        path="identity.pg.password"
        label="Postgres password"
        model={model}
        secret
        value={pg.password}
        onSet={(v) => form.updateIdentity((s) => ({ ...s, pg: { ...s.pg, password: v } }))}
      />
      <PlainField
        path="identity.orgId"
        label="Org UUID"
        model={model}
        value={form.identity.orgId}
        onSet={(v) => form.updateIdentity((s) => ({ ...s, orgId: v }))}
      />
      <PlainField
        path="identity.redis.password"
        label="Redis password"
        model={model}
        secret
        description="requirepass on the Redis default user, and the userinfo in every derived REDIS_URL. Keep it URL-safe. Only used under the direct mode with datastore credentials on."
        value={form.identity.redis.password}
        onSet={(v) => form.updateIdentity((s) => ({ ...s, redis: { password: v } }))}
      />
      <PlainField
        path="identity.mailpit.password"
        label="Mailpit UI password"
        model={model}
        secret
        description="HTTP basic auth for the Mailpit UI and API, user `brokkr`. The catcher holds real password-reset mail and its API returns message bodies. Only used under the direct mode with datastore credentials on."
        value={form.identity.mailpit.password}
        onSet={(v) => form.updateIdentity((s) => ({ ...s, mailpit: { password: v } }))}
      />
    </div>
  );
}

function PortFields({ form, model, catalog }: { form: Form; model: Model; catalog: Catalog }) {
  const [showDerived, setShowDerived] = useState(false);
  const editable = catalog.servicePorts.filter((p) => !p.readOnly);
  const derived = catalog.servicePorts.filter((p) => p.readOnly);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {editable.map((port) => {
          const path = `ports.${port.key}`;
          return (
            <ConfigField
              key={port.key}
              prov={model.provenanceOf(path)}
              path={path}
              label={port.label}
              tag={path}
              description={port.info}
              anchor={knobAnchor(path)}
            >
              {({ disabled, id }) => (
                <input
                  id={id}
                  type="number"
                  min={1}
                  max={65535}
                  disabled={disabled}
                  value={form.portVals[port.key] ?? String(port.value)}
                  onChange={(e) => form.setPort(port.key, e.target.value)}
                  className={TEXT_INPUT}
                />
              )}
            </ConfigField>
          );
        })}
      </div>
      {derived.length > 0 && (
        <div className="space-y-2">
          <button
            onClick={() => setShowDerived((v) => !v)}
            className="text-text-dim hover:text-text-muted text-[10px] tracking-wide uppercase"
          >
            {showDerived ? '▾' : '▸'} derived ports ({derived.length})
          </button>
          {showDerived && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {derived.map((port) => (
                <div key={port.key} className="text-[11px]" title={port.info}>
                  <div className="text-text-dim truncate">{port.label}</div>
                  <div className="text-text-muted font-mono">{port.value} 🔒</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StackFields({ form, model }: { form: Form; model: Model }) {
  return (
    <div className="space-y-3">
      <PlainField
        path="osLayerCache.originHost"
        label="OS-layer CDN origin"
        model={model}
        value={form.osLayer.originHost}
        onSet={(v) => form.updateOsLayer((s) => ({ ...s, originHost: v }))}
      />
      <PlainField
        path="osLayerCache.resolvers"
        label="OS-layer DNS resolvers"
        model={model}
        value={form.osLayer.resolvers}
        onSet={(v) => form.updateOsLayer((s) => ({ ...s, resolvers: v }))}
      />
      <ConfigField
        prov={model.provenanceOf('lan.mode')}
        path="lan.mode"
        label="Network mode"
        tag="lan.mode"
        description={LAN_MODE_HELP[form.lan.mode]}
        danger
        anchor={knobAnchor('lan.mode')}
      >
        {({ disabled, id }) => (
          <select
            id={id}
            disabled={disabled}
            value={form.lan.mode}
            onChange={(e) => {
              const parsed = LanModeSchema.safeParse(e.target.value);
              if (parsed.success) form.updateLan((s) => ({ ...s, mode: parsed.data }));
            }}
            className={`${TEXT_INPUT} w-40`}
          >
            {LanModeSchema.options.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        )}
      </ConfigField>
      <PlainField
        path="lan.bindAddress"
        label="Bind address"
        model={model}
        description="direct: the single address the listeners bind instead of every interface; empty means 0.0.0.0. An IP literal only, because it reaches a socket — put a name in Public host. Nothing binds outward under fronted or loopback."
        value={form.lan.bindAddress}
        onSet={(v) => form.updateLan((s) => ({ ...s, bindAddress: v }))}
      />
      <PlainField
        path="lan.publicHost"
        label="Public host"
        model={model}
        description="The host a browser reaches this stack at under direct or fronted. It never reaches a socket, so unlike the bind address it takes a name: the one your front door serves, or the one a LAN client types. Empty falls back to the bind address, then to localhost."
        value={form.lan.publicHost}
        onSet={(v) => form.updateLan((s) => ({ ...s, publicHost: v }))}
      />
      <ConfigField
        prov={model.provenanceOf('lan.datastoreAuth')}
        path="lan.datastoreAuth"
        label="Datastore credentials"
        tag="lan.datastoreAuth"
        description="Under direct, make off-loopback datastore clients present one: Postgres scram-sha-256, a Redis requirepass, Mailpit basic auth, and Thanos receive pinned back to loopback. Only Postgres keeps loopback trust, because pg_hba is per-source; a Redis requirepass is connection-global, so loopback tooling must present the password too."
        anchor={knobAnchor('lan.datastoreAuth')}
      >
        {({ disabled, id }) => (
          <button
            id={id}
            type="button"
            disabled={disabled}
            onClick={() => form.updateLan((s) => ({ ...s, datastoreAuth: !s.datastoreAuth }))}
            className={`w-fit rounded border px-2 py-1 font-mono text-xs disabled:opacity-50 ${
              form.lan.datastoreAuth
                ? 'border-accent/60 text-accent bg-accent/10'
                : 'border-status-warning/60 text-status-warning/90 bg-status-warning/10'
            }`}
          >
            {form.lan.datastoreAuth ? 'required off loopback' : 'no credential'}
          </button>
        )}
      </ConfigField>
      <ConfigField
        prov={model.provenanceOf('lan.expose')}
        path="lan.expose"
        label="LAN access (deprecated)"
        tag="lan.expose"
        description="Kept so an overlay written before the mode existed still evaluates: true implies the direct mode. Set the mode instead — it also reaches fronted, which this boolean cannot express."
        danger
        anchor={knobAnchor('lan.expose')}
      >
        {({ disabled, id }) => (
          <button
            id={id}
            type="button"
            disabled={disabled}
            onClick={() => form.updateLan((s) => ({ ...s, expose: !s.expose }))}
            className={`w-fit rounded border px-2 py-1 font-mono text-xs disabled:opacity-50 ${
              form.lan.expose
                ? 'border-status-warning/60 text-status-warning/90 bg-status-warning/10'
                : 'border-border-dim text-text-dim'
            }`}
          >
            {form.lan.expose ? 'implies direct' : 'off'}
          </button>
        )}
      </ConfigField>
      <ConfigField
        prov={model.provenanceOf('telemetry.enable')}
        path="telemetry.enable"
        label="Observability sink"
        tag="telemetry.enable"
        anchor={knobAnchor('telemetry.enable')}
      >
        {({ disabled, id }) => (
          <button
            id={id}
            type="button"
            disabled={disabled}
            onClick={() => form.updateTelemetry((s) => ({ enable: !s.enable }))}
            className={`w-fit rounded border px-2 py-1 font-mono text-xs disabled:opacity-50 ${
              form.telemetry.enable ? 'border-accent/60 text-accent bg-accent/10' : 'border-border-dim text-text-dim'
            }`}
          >
            {form.telemetry.enable ? 'sink enabled' : 'disabled'}
          </button>
        )}
      </ConfigField>
    </div>
  );
}

/** Measured, not requested. stackCounts was an editable stepper nothing read; the number that decides
 *  spoke count is fleet.zones.<z>.bridges, which /config/fleet owns. */
function Measured({ label, tag, value }: { label: string; tag: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-[11px]">
        <span className="text-text-muted">{label}</span>
        <span className="text-text-label font-mono">{tag}</span>
      </span>
      <span className="text-text-primary font-mono text-xs">{value}</span>
    </div>
  );
}

function TopologyFields({ form, model, catalog }: { form: Form; model: Model; catalog: StackConfig }) {
  const slotProv = model.provenanceOf('stack.slot');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-4">
        <Stepper
          label="Stack slot"
          tag="stack.slot"
          value={form.slot}
          min={0}
          max={MAX_SLOT}
          locked={slotProv?.locked ? (slotProv.lockReason ?? undefined) : undefined}
          onChange={form.setSlot}
        />
        <Measured label="Zones" tag="fleet.zones" value={catalog.topology.zones} />
        <Measured label="Bridges" tag="labBridges" value={catalog.topology.bridges} />
      </div>
      <p className="text-text-dim max-w-3xl text-[10px] leading-snug">
        A slot move re-derives every port, subnet and state path, and drops the fleet and port overrides back to that
        slot&apos;s defaults. It needs a full stack recreation, not a reload.
      </p>
      {slotProv?.locked && <span className="text-status-warning/70 text-[10px]">{slotProv.lockReason}</span>}
    </div>
  );
}
