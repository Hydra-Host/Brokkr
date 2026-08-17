import { describe, expect, it } from 'vitest';

import {
  editablePortsFrom,
  emptyStackDefaults,
  knobEnvKeys,
  knobNixDefault,
  OBSERVABILITY_PORT_KEYS,
  observabilityPortsFrom,
  resolvedKnobs,
  servicePortRows,
  STACK_KNOBS,
  type StackDefaults,
  type StackGroup,
} from '../stack-knobs';

const EVAL_STACK_DEFAULTS: StackDefaults = {
  hub: {
    BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://brokkr:password@127.0.0.1:5432/brokkr',
    LOCAL_SIMULATION_ENABLED: 'false',
    LOG_LEVEL: 'debug',
    REDIS_URL: 'redis://127.0.0.1:6379',
    VITE_LOCAL_SIMULATION_ENABLED: 'true',
  },
  spoke: {
    AGENT_SSH_FORCE_REDEPLOY: 'true',
    ANALYTICS_ENABLED: 'false',
    BRIDGE_SYNC_ENABLED: 'true',
    BROKKR_LIVE_VERSION: '1.1.8',
    COLLECTION_WORKER_CONCURRENCY: '1',
    DISCOVERY_BASE_URL: 'https://brokkr.assets.hydra.host/brokkr-live-light',
    HTTPS_DOWNLOAD_TIMEOUT: '3600',
    HTTPS_RETRY_ATTEMPTS: '3',
    HTTPS_RETRY_DELAY: '5',
    HTTPS_VERIFY_SSL: 'true',
    LIFECYCLE_WORKER_CONCURRENCY: '7',
    LOG_FORMAT: 'console',
    LOG_LEVEL: 'debug',
    MONITORING_LOGS_ENABLED: 'false',
    OS_LAYER_URL: 'http://192.168.200.1:8888/assets',
    TELEGRAF_ENABLED: 'true',
  },
  hubKnobEnv: { AUTH_BYPASS_ENABLED: ['LOCAL_SIMULATION_ENABLED', 'VITE_LOCAL_SIMULATION_ENABLED'] },
};

const GROUPS: StackGroup[] = ['hub', 'spoke'];
const knobDefault = (group: StackGroup, env: string, defaults: StackDefaults): string | undefined =>
  resolvedKnobs(group, defaults).find((k) => k.env === env)?.default;

describe('STACK_KNOBS — every knob declares where its default comes from', () => {
  it.each(GROUPS)('%s knobs resolve in stackDefaults unless they declare no Nix source', (group) => {
    const unsourced = STACK_KNOBS[group]
      .filter((knob) => knob.nixDefault !== 'lab')
      .filter((knob) => knobNixDefault(knob, group, EVAL_STACK_DEFAULTS) === undefined)
      .map((knob) => knob.env);

    expect(unsourced).toEqual([]);
  });

  it.each(GROUPS)('%s knobs that declare no Nix source are never looked up', (group) => {
    const lab = STACK_KNOBS[group].filter((knob) => knob.nixDefault === 'lab');

    for (const knob of lab) {
      expect(knobNixDefault(knob, group, EVAL_STACK_DEFAULTS)).toBeUndefined();
    }
    expect(lab.map((k) => k.env)).toEqual(group === 'hub' ? ['HUB_REPO_PATH'] : []);
  });

  it('resolves AUTH_BYPASS_ENABLED through hubKnobEnv, preferring the first remapped key', () => {
    expect(knobEnvKeys('AUTH_BYPASS_ENABLED', EVAL_STACK_DEFAULTS.hubKnobEnv)).toEqual([
      'LOCAL_SIMULATION_ENABLED',
      'VITE_LOCAL_SIMULATION_ENABLED',
    ]);
    expect(knobDefault('hub', 'AUTH_BYPASS_ENABLED', EVAL_STACK_DEFAULTS)).toBe('false');
  });

  it('falls through to the later remap key when the first is absent', () => {
    const hub: Record<string, string> = { ...EVAL_STACK_DEFAULTS.hub, VITE_LOCAL_SIMULATION_ENABLED: 'false' };
    delete hub.LOCAL_SIMULATION_ENABLED;
    const defaults: StackDefaults = { ...EVAL_STACK_DEFAULTS, hub };

    expect(knobDefault('hub', 'AUTH_BYPASS_ENABLED', defaults)).toBe('false');
  });

  it('resolves the spoke lifecycle concurrency from stackDefaults over the declared literal', () => {
    expect(knobDefault('spoke', 'LIFECYCLE_WORKER_CONCURRENCY', EVAL_STACK_DEFAULTS)).toBe('7');
  });

  it('ships 10 as the declared spoke lifecycle concurrency, not the old hardcoded 3', () => {
    expect(STACK_KNOBS.spoke.find((k) => k.env === 'LIFECYCLE_WORKER_CONCURRENCY')?.default).toBe('10');
  });

  it('keeps the declared literal when the group map has no entry for the knob', () => {
    const declared = new Map(STACK_KNOBS.spoke.map((k) => [k.env, k.default]));

    for (const knob of resolvedKnobs('spoke', emptyStackDefaults())) {
      expect(knob.default).toBe(declared.get(knob.env));
    }
  });

  it('never leaks the nixDefault marker into the contract shape', () => {
    for (const knob of resolvedKnobs('hub', EVAL_STACK_DEFAULTS)) {
      expect(Object.keys(knob)).not.toContain('nixDefault');
    }
  });
});

describe('editablePortsFrom — keyed by portGroups.editable', () => {
  it('takes only the declared keys and coerces the eval strings', () => {
    const out = editablePortsFrom({ postgres: 5432, redis: 6379, grafana: 4300 }, ['postgres', 'redis']);

    expect(out).toEqual({ postgres: 5432, redis: 6379 });
  });

  it('falls back to the supplied map for a missing or out-of-range key', () => {
    const out = editablePortsFrom({ postgres: 99999 }, ['postgres', 'redis'], { postgres: 5432, redis: 6379 });

    expect(out).toEqual({ postgres: 5432, redis: 6379 });
  });

  it('omits a key with neither a usable value nor a fallback', () => {
    expect(editablePortsFrom({}, ['postgres'])).toEqual({});
  });
});

describe('servicePortRows — labels are ours, keys and values are Nix', () => {
  it('renders the mailpit ports the previous hardcoded list omitted', () => {
    const rows = servicePortRows(['mailpitSmtp', 'mailpitWeb'], { mailpitSmtp: 1025, mailpitWeb: 8025 }, false);

    expect(rows.map((r) => [r.key, r.label, r.value])).toEqual([
      ['mailpitSmtp', 'Mailpit SMTP', 1025],
      ['mailpitWeb', 'Mailpit web UI', 8025],
    ]);
  });

  it('renders an unlabelled key under the key itself rather than dropping it', () => {
    expect(servicePortRows(['brandNewSink'], { brandNewSink: 4444 }, false)).toEqual([
      { key: 'brandNewSink', label: 'brandNewSink', value: 4444, info: undefined },
    ]);
  });

  it('marks the read-only rows and skips a key the eval did not report', () => {
    const rows = servicePortRows(['grafana', 'tempoHttp'], { grafana: 4300 }, true);

    expect(rows).toEqual([{ key: 'grafana', label: 'Grafana UI', value: 4300, info: undefined, readOnly: true }]);
  });
});

describe('observabilityPortsFrom — a curated slice of portGroups.readOnly', () => {
  it('keeps the curated keys and ignores the rest of the read-only group', () => {
    const out = observabilityPortsFrom(
      { grafana: 4300, otlpHttp: 4318, otlpGrpc: 4317, tempoHttp: 3200, lokiHttp: 3100 },
      [...OBSERVABILITY_PORT_KEYS, 'lokiHttp'],
    );

    expect(out).toEqual({ grafana: 4300, otlpHttp: 4318, otlpGrpc: 4317, tempoHttp: 3200 });
  });

  it('omits a curated key the eval has no port for', () => {
    expect(observabilityPortsFrom({ grafana: 4300 }, [...OBSERVABILITY_PORT_KEYS])).toEqual({ grafana: 4300 });
  });
});
