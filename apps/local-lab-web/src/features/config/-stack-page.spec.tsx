// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rejectionLine } from '@/components/config/rejected-writes';
import type { ConfigTreeEntry, RejectedEntry, StackConfig } from '@/contract';

const { lab } = vi.hoisted(() => ({
  lab: {
    cfg: undefined as { status: number; body: unknown } | undefined,
    tree: undefined as { status: number; body: unknown } | undefined,
    treeErr: undefined as unknown,
    putBody: undefined as unknown,
    putOptions: undefined as { onSuccess?: (r: { body: unknown }) => void; onError?: (e: unknown) => void } | undefined,
    branchPending: undefined as string | undefined,
    reloadFails: undefined as unknown,
    reloadCalls: 0,
    redeployCalls: 0,
  },
}));

vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle', proceed: () => {}, reset: () => {} }),
}));
vi.mock('@/lib/api', () => ({
  tsr: {
    getStackConfig: { useQuery: () => ({ data: lab.cfg, refetch: () => Promise.resolve() }) },
    getConfigTree: { useQuery: () => ({ data: lab.tree, error: lab.treeErr }) },
    putStackConfig: {
      useMutation: () => ({
        isPending: false,
        mutate: (vars: { body: unknown }, opts: typeof lab.putOptions) => {
          lab.putBody = vars.body;
          lab.putOptions = opts;
        },
      }),
    },
    reloadService: {
      useMutation: () => ({
        isPending: false,
        mutate: (
          _v: unknown,
          opts?: { onSuccess?: (r: { body: { runId: string } }) => void; onError?: (e: unknown) => void },
        ) => {
          lab.reloadCalls += 1;
          if (lab.reloadFails) opts?.onError?.(lab.reloadFails);
          else opts?.onSuccess?.({ body: { runId: 'run-reload' } });
        },
      }),
    },
    redeployStack: {
      useMutation: () => ({
        isPending: false,
        mutate: (_v: unknown, opts?: { onSuccess?: (r: { body: { runId: string } }) => void }) => {
          lab.redeployCalls += 1;
          opts?.onSuccess?.({ body: { runId: 'run-redeploy' } });
        },
      }),
    },
    getRun: { useQuery: () => ({ data: undefined }) },
  },
}));
vi.mock('@/lib/use-branch-checkout', () => ({
  useBranchCheckout: () => ({
    effective: () => ({ branch: 'master', error: null }),
    inputValue: () => 'master',
    setInput: () => {},
    pending: () => lab.branchPending,
    checkout: () => {},
    busy: false,
    rebuildRequired: false,
  }),
}));
vi.mock('@/lib/use-log-stream', () => ({
  useLogStream: () => ({ logRef: { current: null }, logHtml: '', logText: '', open: () => {} }),
  usePaintedHtml: () => ({ current: null }),
}));

import { ConfigStackPage } from './stack-page';

const knob = (over: Partial<StackConfig['knobs']['hub'][number]> = {}) => ({
  env: 'LOG_LEVEL',
  label: 'Log level',
  group: 'Logging',
  kind: 'select' as const,
  default: 'debug',
  options: ['debug', 'info', 'warn'],
  path: 'stackDefaults.hub.LOG_LEVEL',
  writable: true,
  ...over,
});

const stackConfig = (over: Partial<StackConfig> = {}): StackConfig => ({
  seeded: true,
  slot: 0,
  knobs: { hub: [knob()], spoke: [] },
  ports: { hub: [], spoke: [] },
  servicePorts: [{ key: 'postgres', path: 'ports.postgres', group: 'Datastores', label: 'Postgres', value: 5432 }],
  values: { hub: {}, spoke: {} },
  topology: { zones: 1, bridges: 1 },
  identity: {
    pg: { user: 'brokkr', password: 'password', db: 'brokkr' },
    orgId: 'org',
    redis: { password: 'password' },
    mailpit: { password: 'password' },
  },
  osLayerCache: { originHost: 'assets.example.com', resolvers: '1.1.1.1' },
  lan: { mode: 'loopback', bindAddress: '', publicHost: '', datastoreAuth: true, expose: false },
  telemetry: { enable: false },
  ...over,
});

const entry = (over: Partial<ConfigTreeEntry> & { path: string }): ConfigTreeEntry => {
  const base: ConfigTreeEntry = {
    label: 'Label',
    group: 'Group',
    description: 'Why this knob exists.',
    value: 'same',
    default: 'same',
    definedIn: [],
    secret: false,
    overridden: false,
    writable: true,
    kind: 'text',
    choices: [],
    danger: false,
    applyClass: 'reload-hub',
    ...over,
  };
  return { ...base, overridden: over.overridden ?? base.value !== base.default };
};

afterEach(cleanup);

beforeEach(() => {
  lab.cfg = { status: 200, body: stackConfig() };
  lab.tree = { status: 200, body: { seeded: true, entries: [] } };
  lab.putBody = undefined;
  lab.putOptions = undefined;
  lab.branchPending = undefined;
});

describe('ConfigStackPage', () => {
  beforeEach(() => {
    lab.putOptions = undefined;
    lab.treeErr = undefined;
  });

  it('refuses to save bare defaults back over the overlay when the seed failed', () => {
    lab.cfg = { status: 200, body: stackConfig({ seeded: false }) };
    render(<ConfigStackPage />);

    fireEvent.change(screen.getByLabelText('Log level'), { target: { value: 'warn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));

    expect(lab.putBody).toBeUndefined();
    expect(screen.getByText(/would erase the overlay/)).toBeTruthy();
  });

  it('keeps a dropped key on screen instead of a toast that fades', () => {
    render(<ConfigStackPage />);
    fireEvent.change(screen.getByLabelText('Log level'), { target: { value: 'warn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));
    act(() => {
      lab.putOptions?.onSuccess?.({
        body: {
          ok: true,
          applied: [],
          rejected: [{ path: 'stackDefaults.hub.LOG_LEVEL', reason: 'pinned', detail: 'BROKKR_HUB_LOG_LEVEL' }],
        },
      });
    });

    expect(screen.getByText(/stackDefaults\.hub\.LOG_LEVEL — pinned \(BROKKR_HUB_LOG_LEVEL\)/)).toBeTruthy();
    expect(screen.getByText('Not written:')).toBeTruthy();
  });

  it('renders every refused path through the shared component, one line each', () => {
    const refused: RejectedEntry[] = [
      { path: 'stackDefaults.hub.LOG_LEVEL', reason: 'pinned', detail: 'BROKKR_HUB_LOG_LEVEL' },
      { path: 'stackDefaults.spoke.SNMP_PORT', reason: 'not-coercible', detail: 'port' },
      { path: 'ports.postgres', reason: 'no-writer' },
    ];
    render(<ConfigStackPage />);
    fireEvent.change(screen.getByLabelText('Log level'), { target: { value: 'warn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));
    act(() => {
      lab.putOptions?.onSuccess?.({ body: { ok: true, applied: [], rejected: refused } });
    });

    for (const entry of refused) {
      expect(screen.getByText(rejectionLine(entry)).textContent).toBe(rejectionLine(entry));
    }
  });

  it('disables a knob an environment pin holds and names the variable', () => {
    lab.tree = {
      status: 200,
      body: {
        seeded: true,
        entries: [
          entry({ path: 'stackDefaults.hub.LOG_LEVEL', value: 'warn', default: 'debug', pinnedBy: 'BROKKR_LOG' }),
        ],
      },
    };
    render(<ConfigStackPage />);

    expect(screen.getByLabelText('Log level')).toHaveProperty('disabled', true);
    expect(screen.getByText('unset BROKKR_LOG to edit this here')).toBeTruthy();
  });

  it('sends an edited port under its canonical path', () => {
    render(<ConfigStackPage />);
    fireEvent.change(screen.getByLabelText('Postgres'), { target: { value: '5442' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));

    expect(lab.putBody).toMatchObject({ entries: { 'ports.postgres': '5442' } });
  });

  it('sends a value the server will refuse rather than dropping it silently', () => {
    render(<ConfigStackPage />);
    fireEvent.change(screen.getByLabelText('Postgres'), { target: { value: '70000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));

    expect(lab.putBody).toMatchObject({ entries: { 'ports.postgres': '70000' } });
  });

  it('sends no entry for a port it did not touch', () => {
    render(<ConfigStackPage />);
    fireEvent.change(screen.getByLabelText('Log level'), { target: { value: 'warn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));

    expect(lab.putBody).toMatchObject({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'warn' } });
    expect((lab.putBody as { entries: Record<string, string> }).entries['ports.postgres']).toBeUndefined();
  });

  it('floors the stack slot at zero', () => {
    render(<ConfigStackPage />);
    const minus = screen.getAllByRole('button', { name: '−' })[0];

    expect(minus).toHaveProperty('disabled', true);
  });

  it('marks a changed knob in the rail so a section with edits is findable', () => {
    lab.tree = {
      status: 200,
      body: {
        seeded: true,
        entries: [entry({ path: 'stackDefaults.hub.LOG_LEVEL', value: 'warn', default: 'debug' })],
      },
    };
    render(<ConfigStackPage />);

    expect(screen.getByTitle('1 changed')).toBeTruthy();
  });
});

describe('ConfigStackPage — a refused save', () => {
  it("surfaces the server's own message instead of a generic one", () => {
    render(<ConfigStackPage />);
    fireEvent.change(screen.getByLabelText('Log level'), { target: { value: 'warn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));
    act(() => {
      lab.putOptions?.onError?.({ body: { error: 'slot 3 already claimed by /other/wt' } });
    });

    expect(screen.getByText(/slot 3 already claimed by \/other\/wt/)).toBeTruthy();
  });

  it('leaves the form dirty with the save still offered', () => {
    render(<ConfigStackPage />);
    fireEvent.change(screen.getByLabelText('Log level'), { target: { value: 'warn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));
    act(() => {
      lab.putOptions?.onError?.({ body: { error: 'nope' } });
    });

    expect(screen.getByRole('button', { name: 'Save config' })).toBeTruthy();
  });

  it('does not clear the edit the operator made', () => {
    render(<ConfigStackPage />);
    fireEvent.change(screen.getByLabelText('Log level'), { target: { value: 'warn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));
    act(() => {
      lab.putOptions?.onError?.({ body: { error: 'nope' } });
    });

    expect(screen.getByLabelText('Log level')).toHaveProperty('value', 'warn');
  });
});

describe('ConfigStackPage — a branch checkout while the seed has failed', () => {
  beforeEach(() => {
    lab.branchPending = 'other-branch';
    lab.cfg = {
      status: 200,
      body: stackConfig({ seeded: false, knobs: { hub: [knob({ group: 'Location' })], spoke: [] } }),
    };
  });

  it('stays editable, because a checkout never writes the overlay', () => {
    render(<ConfigStackPage />);

    expect(screen.getByPlaceholderText('master')).toHaveProperty('disabled', false);
  });

  it('still blocks the save when a knob was edited too', () => {
    render(<ConfigStackPage />);
    fireEvent.change(screen.getByLabelText('Log level'), { target: { value: 'warn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));

    expect(lab.putBody).toBeUndefined();
  });
});

describe('ConfigStackPage — the changed-only filter', () => {
  it('hides a knob still sitting on the value nix declares', () => {
    render(<ConfigStackPage />);

    fireEvent.click(screen.getByRole('button', { name: 'changed only' }));

    expect(screen.queryByLabelText('Log level')).toBeNull();
  });

  it('keeps a knob whose value differs from its default', () => {
    lab.tree = {
      status: 200,
      body: {
        seeded: true,
        entries: [entry({ path: 'stackDefaults.hub.LOG_LEVEL', value: 'warn', default: 'debug' })],
      },
    };
    render(<ConfigStackPage />);

    fireEvent.click(screen.getByRole('button', { name: 'changed only' }));

    expect(screen.getByLabelText('Log level')).toBeTruthy();
  });

  it('leaves every knob on screen once the filter is off again', () => {
    render(<ConfigStackPage />);
    const toggle = screen.getByRole('button', { name: 'changed only' });

    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(screen.getByLabelText('Log level')).toBeTruthy();
  });
});

describe('ConfigStackPage — an environment pin', () => {
  it('leaves the knobs no pin holds editable', () => {
    lab.cfg = {
      status: 200,
      body: stackConfig({
        knobs: {
          hub: [
            knob({ pinnedBy: 'BROKKR_HUB_LOG_LEVEL' }),
            knob({ env: 'OTHER', label: 'Other', pinnedBy: undefined }),
          ],
          spoke: [],
        },
      }),
    };
    render(<ConfigStackPage />);

    expect(screen.getByLabelText('Other')).toHaveProperty('disabled', false);
  });
});

describe('ConfigStackPage — the bar states what the edit will cost, before the save', () => {
  it('states no cost on a clean form', () => {
    render(<ConfigStackPage />);

    expect(screen.queryByText(/needs a hub reload/)).toBeNull();
    expect(screen.queryByText(/a reload cannot pick it up/)).toBeNull();
  });

  it('names a hub reload as soon as a hub knob changes', () => {
    render(<ConfigStackPage />);

    fireEvent.change(screen.getByLabelText('Log level'), { target: { value: 'warn' } });

    expect(screen.getByText(/needs a hub reload/)).toBeTruthy();
  });

  it('names the recreation a port needs, rather than the reload it outranks', () => {
    render(<ConfigStackPage />);

    fireEvent.change(screen.getByLabelText('Postgres'), { target: { value: '5442' } });

    expect(screen.getByText(/a reload cannot pick it up/)).toBeTruthy();
    expect(screen.queryByText(/needs a hub reload/)).toBeNull();
  });

  it('carries no apply control of its own, since the panel above owns every one', () => {
    render(<ConfigStackPage />);

    fireEvent.change(screen.getByLabelText('Log level'), { target: { value: 'warn' } });

    expect(screen.queryByRole('button', { name: 'reload hub' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'reload spoke' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'redeploy' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save config' })).toBeTruthy();
  });
});

describe('ConfigStackPage — the provenance read failed', () => {
  beforeEach(() => {
    lab.cfg = { status: 200, body: stackConfig() };
    lab.tree = { status: 200, body: { seeded: true, entries: [] } };
    lab.treeErr = undefined;
  });

  it('says provenance could not be read rather than leaving every chip unexplained', () => {
    lab.treeErr = new Error('tree endpoint answered 500');

    render(<ConfigStackPage />);

    expect(screen.getByText(/provenance could not be read/)).toBeTruthy();
    expect(screen.getByText(/tree endpoint answered 500/)).toBeTruthy();
  });

  it('says nothing about provenance when the read succeeded', () => {
    render(<ConfigStackPage />);

    expect(screen.queryByText(/provenance could not be read/)).toBeNull();
  });
});

describe('ConfigStackPage — changed only reaches every field family', () => {
  beforeEach(() => {
    lab.cfg = { status: 200, body: stackConfig() };
    lab.tree = {
      status: 200,
      body: {
        seeded: true,
        entries: [
          entry({ path: 'ports.postgres', value: '5442', default: '5432' }),
          entry({ path: 'identity.pg.user', value: 'brokkr', default: 'brokkr' }),
        ],
      },
    };
    lab.treeErr = undefined;
  });

  it('shows a port and an identity field while the toggle is off', () => {
    render(<ConfigStackPage />);

    expect(screen.queryByLabelText('Postgres')).not.toBeNull();
    expect(screen.queryByLabelText('Postgres user')).not.toBeNull();
  });

  it('hides the identity field that is on its declared value and keeps the changed port', () => {
    render(<ConfigStackPage />);

    fireEvent.click(screen.getByRole('button', { name: /changed only/i }));

    expect(screen.queryByLabelText('Postgres')).not.toBeNull();
    expect(screen.queryByLabelText('Postgres user')).toBeNull();
  });
});

describe('ConfigStackPage — revert', () => {
  beforeEach(() => {
    lab.cfg = {
      status: 200,
      body: stackConfig({ values: { hub: { LOG_LEVEL: 'warn' }, spoke: {} } }),
    };
    lab.tree = {
      status: 200,
      body: {
        seeded: true,
        entries: [entry({ path: 'stackDefaults.hub.LOG_LEVEL', value: 'warn', default: 'debug' })],
      },
    };
    lab.treeErr = undefined;
  });

  it('sends null so the overlay key is dropped rather than set to the empty string', () => {
    render(<ConfigStackPage />);

    fireEvent.click(screen.getByRole('button', { name: 'revert' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));

    expect(lab.putBody).toMatchObject({ entries: { 'stackDefaults.hub.LOG_LEVEL': null } });
  });

  it('never sends the empty string for a reverted knob', () => {
    render(<ConfigStackPage />);

    fireEvent.click(screen.getByRole('button', { name: 'revert' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));

    const entries = (lab.putBody as { entries: Record<string, string | null> }).entries;
    expect(Object.values(entries)).not.toContain('');
  });
});

describe('ConfigStackPage — the apply bar header', () => {
  const editThree = () => {
    fireEvent.change(screen.getByLabelText('Log level'), { target: { value: 'warn' } });
    fireEvent.change(screen.getByLabelText('Other level'), { target: { value: 'info' } });
    fireEvent.change(screen.getByLabelText('Spoke log level'), { target: { value: 'warn' } });
  };

  beforeEach(() => {
    lab.cfg = {
      status: 200,
      body: stackConfig({
        knobs: {
          hub: [knob(), knob({ env: 'OTHER_LEVEL', label: 'Other level', path: 'stackDefaults.hub.OTHER_LEVEL' })],
          spoke: [knob({ label: 'Spoke log level', path: 'stackDefaults.spoke.LOG_LEVEL' })],
        },
      }),
    };
    lab.tree = { status: 200, body: { seeded: true, entries: [] } };
    lab.treeErr = undefined;
  });

  it('counts every dirty entry rather than reporting the dirty flag as one', () => {
    render(<ConfigStackPage />);

    editThree();

    expect(screen.getByText(/3 unsaved/)).toBeTruthy();
    expect(screen.queryByText(/1 unsaved/)).toBeNull();
  });

  it('names both pending reload classes, since neither tied class dominates the other', () => {
    render(<ConfigStackPage />);

    editThree();

    expect(screen.getByText(/needs a hub reload/)).toBeTruthy();
    expect(screen.getByText(/needs a spoke reload/)).toBeTruthy();
  });

  it('reports one class while only one is pending', () => {
    render(<ConfigStackPage />);

    fireEvent.change(screen.getByLabelText('Spoke log level'), { target: { value: 'warn' } });

    expect(screen.getByText(/1 unsaved/)).toBeTruthy();
    expect(screen.queryByText(/needs a hub reload/)).toBeNull();
    expect(screen.getByText(/needs a spoke reload/)).toBeTruthy();
  });
});
