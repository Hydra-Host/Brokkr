import { useEffect, useRef, useState } from 'react';

import type { StackConfig } from '@/contract';
import { tsr } from '@/lib/api';
import { errorMessage, thrownBodyError } from '@/lib/errors';

export type Svc = 'hub' | 'spoke';
export type Vals = Record<string, string>;

type Counts = StackConfig['counts'];
type Identity = StackConfig['identity'];
type OsLayer = StackConfig['osLayerCache'];
type Lan = StackConfig['lan'];
type Telemetry = StackConfig['telemetry'];

export const SEED_RETRY_POLL_MS = 5000;
export const SEED_BLOCKED_MESSAGE =
  'not saved — the control center could not read the live stack config, so these fields are bare defaults and saving them would erase the overlay.';

/** Mirrors StackCountsSchema's response bounds; the write schema is unbounded and the server clamps. */
export const MAX_COUNTS: Record<Svc, number> = { hub: 1, spoke: 8 };
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
  const [counts, setCounts] = useState<Counts>({ hub: 1, spoke: 1 });
  const [slot, setSlotState] = useState(0);
  const [identity, setIdentity] = useState<Identity>({
    pg: { user: 'brokkr', password: 'password', db: 'brokkr' },
    orgId: '00000000-0000-0000-0000-000000000000',
  });
  const [osLayer, setOsLayer] = useState<OsLayer>({ originHost: '', resolvers: '' });
  const [lan, setLan] = useState<Lan>({ expose: false });
  const [telemetry, setTelemetry] = useState<Telemetry>({ enable: false });
  const [portVals, setPortVals] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const adoptedSeededRef = useRef(false);

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
    setHub(body.values.hub);
    setSpoke(body.values.spoke);
    setCounts(body.counts);
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

  const setVal = (svc: Svc, env: string, v: string) => {
    (svc === 'hub' ? setHub : setSpoke)((m) => ({ ...m, [env]: v }));
    setDirty(true);
  };
  const setCount = (svc: Svc, n: number) => {
    setCounts((c) => ({ ...c, [svc]: Math.max(1, Math.min(MAX_COUNTS[svc], n)) }));
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

  const portsBody = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(portVals)) {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) out[k] = n;
    }
    return out;
  };

  return {
    catalog,
    error: errorMessage(cfg.error),
    seedFailed,
    saveBlocked,
    saveError,
    dirty,
    counts,
    slot,
    identity,
    osLayer,
    lan,
    telemetry,
    portVals,
    valsOf: (svc: Svc) => (svc === 'hub' ? hub : spoke),
    setVal,
    setCount,
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
    saveBody: () => ({ hub, spoke, counts, slot, identity, osLayerCache: osLayer, ports: portsBody(), lan, telemetry }),
    refetch: cfg.refetch,
  };
}
