import { useEffect, useRef, useState } from 'react';

import type { StackConfig } from '@/contract';
import { tsr } from '@/lib/api';
import { errorMessage, thrownBodyError } from '@/lib/errors';

export type Svc = 'hub' | 'spoke';
/** Null is the revert channel the contract declares: it drops the overlay key rather than writing the
 *  type's zero value, which for a bounded knob is a value the catalogue itself calls invalid. */
export type Vals = Record<string, string | null>;

type Identity = StackConfig['identity'];
type OsLayer = StackConfig['osLayerCache'];
type Lan = StackConfig['lan'];
type Telemetry = StackConfig['telemetry'];

export const SEED_RETRY_POLL_MS = 5000;
export const SEED_BLOCKED_MESSAGE =
  'not saved — the control center could not read the live stack config, so these fields are bare defaults and saving them would erase the overlay.';

/** Mirrors StackSlotSchema's bounds (the host-collision-free slot range). */
export const MAX_SLOT = 46;

export function useStackConfigForm() {
  const [pollSeed, setPollSeed] = useState(false);
  const cfg = tsr.getStackConfig.useQuery({
    queryKey: ['stack-config'],
    refetchInterval: pollSeed ? SEED_RETRY_POLL_MS : false,
  });

  const [hub, setHub] = useState<Vals>({});
  const [spoke, setSpoke] = useState<Vals>({});
  const [slot, setSlotState] = useState(0);
  const [identity, setIdentity] = useState<Identity>({
    pg: { user: 'brokkr', password: 'password', db: 'brokkr' },
    orgId: '00000000-0000-0000-0000-000000000000',
    redis: { password: 'password' },
    mailpit: { password: 'password' },
  });
  const [osLayer, setOsLayer] = useState<OsLayer>({ originHost: '', resolvers: '' });
  const [lan, setLan] = useState<Lan>({
    mode: 'loopback',
    bindAddress: '',
    publicHost: '',
    datastoreAuth: true,
    expose: false,
  });
  const [telemetry, setTelemetry] = useState<Telemetry>({ enable: false });
  const [portVals, setPortVals] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const adoptedSeededRef = useRef(false);
  /** The body the form was filled from. The save sends only the paths that differ from it, so an
   *  untouched path stays untouched rather than being rewritten with the value it already had. */
  const loadedRef = useRef<StackConfig | null>(null);

  useEffect(() => {
    if (cfg.data?.status !== 200) return;
    const body = cfg.data.body;
    setPollSeed(!body.seeded);
    // a form filled from an unseeded response holds bare defaults, so the first seeded response has to
    // overwrite it even mid-edit — saving those defaults back would erase the live overlay
    const adopt = body.seeded && !adoptedSeededRef.current;
    if (dirty && !adopt) return;
    // tracks whether what the form now shows came from a seeded body, so a later unseeded window re-arms the adopt
    adoptedSeededRef.current = body.seeded;
    loadedRef.current = body;
    setHub(body.values.hub);
    setSpoke(body.values.spoke);
    setSlotState(body.slot);
    setIdentity(body.identity);
    setOsLayer(body.osLayerCache);
    setLan(body.lan);
    setTelemetry(body.telemetry);
    setPortVals(Object.fromEntries(body.servicePorts.filter((p) => !p.readOnly).map((p) => [p.key, String(p.value)])));
    if (adopt) {
      setDirty(false);
      setSaveError(null);
    }
    // dirty is read but not a dep: the save-success flip to false must not rehydrate the pre-save body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.data]);

  const catalog = cfg.data?.status === 200 ? cfg.data.body : null;
  const seedFailed = catalog !== null && !catalog.seeded;
  // the fields are bare defaults while the seed has failed; submitting edits built on them wipes the overlay
  const saveBlocked = seedFailed && dirty;

  const setVal = (svc: Svc, env: string, v: string | null) => {
    (svc === 'hub' ? setHub : setSpoke)((m) => ({ ...m, [env]: v }));
    setDirty(true);
  };
  const setSlot = (n: number) => {
    setSlotState(Math.max(0, Math.min(MAX_SLOT, n)));
    setDirty(true);
  };
  const setPort = (key: string, v: string) => {
    setPortVals((m) => ({ ...m, [key]: v }));
    setDirty(true);
  };
  const updateIdentity = (fn: (s: Identity) => Identity) => {
    setIdentity(fn);
    setDirty(true);
  };
  const updateOsLayer = (fn: (s: OsLayer) => OsLayer) => {
    setOsLayer(fn);
    setDirty(true);
  };
  const updateLan = (fn: (s: Lan) => Lan) => {
    setLan(fn);
    setDirty(true);
  };
  const updateTelemetry = (fn: (s: Telemetry) => Telemetry) => {
    setTelemetry(fn);
    setDirty(true);
  };

  const dirtyEntries = (): Record<string, string | null> => {
    const was = loadedRef.current;
    const out: Record<string, string | null> = {};
    const put = (path: string, now: string | null, before: string | undefined) => {
      if (before === undefined || now !== before) out[path] = now;
    };
    for (const svc of ['hub', 'spoke'] as const) {
      const vals = svc === 'hub' ? hub : spoke;
      for (const [env, v] of Object.entries(vals)) put(`stackDefaults.${svc}.${env}`, v, was?.values[svc][env]);
    }
    const wasPort = (key: string): string | undefined => {
      const row = was?.servicePorts.find((sp) => sp.key === key);
      return row === undefined ? undefined : String(row.value);
    };
    for (const [key, v] of Object.entries(portVals)) put(`ports.${key}`, v, wasPort(key));
    put('identity.pg.user', identity.pg.user, was?.identity.pg.user);
    put('identity.pg.password', identity.pg.password, was?.identity.pg.password);
    put('identity.pg.db', identity.pg.db, was?.identity.pg.db);
    put('identity.orgId', identity.orgId, was?.identity.orgId);
    put('identity.redis.password', identity.redis.password, was?.identity.redis.password);
    put('identity.mailpit.password', identity.mailpit.password, was?.identity.mailpit.password);
    put('osLayerCache.originHost', osLayer.originHost, was?.osLayerCache.originHost);
    put('osLayerCache.resolvers', osLayer.resolvers, was?.osLayerCache.resolvers);
    put('lan.mode', lan.mode, was?.lan.mode);
    put('lan.bindAddress', lan.bindAddress, was?.lan.bindAddress);
    put('lan.publicHost', lan.publicHost, was?.lan.publicHost);
    put('lan.datastoreAuth', String(lan.datastoreAuth), was === null ? undefined : String(was.lan.datastoreAuth));
    put('lan.expose', String(lan.expose), was === null ? undefined : String(was.lan.expose));
    put('telemetry.enable', String(telemetry.enable), was === null ? undefined : String(was.telemetry.enable));
    return out;
  };

  return {
    catalog,
    error: errorMessage(cfg.error),
    seedFailed,
    saveBlocked,
    saveError,
    dirty,
    slot,
    identity,
    osLayer,
    lan,
    telemetry,
    portVals,
    valsOf: (svc: Svc) => (svc === 'hub' ? hub : spoke),
    setVal,
    setSlot,
    setPort,
    updateIdentity,
    updateOsLayer,
    updateLan,
    updateTelemetry,
    markSaved: () => {
      setSaveError(null);
      setDirty(false);
    },
    markSaveFailed: (err: unknown) =>
      setSaveError(thrownBodyError(err) ?? errorMessage(err) ?? 'saving the stack config failed'),
    markSaveRefused: () => setSaveError(SEED_BLOCKED_MESSAGE),
    saveBody: () => ({ entries: dirtyEntries(), slot }),
    refetch: cfg.refetch,
  };
}
