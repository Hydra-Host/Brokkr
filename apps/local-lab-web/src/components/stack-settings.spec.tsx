// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StackConfig } from '@/contract';

const { lab } = vi.hoisted(() => ({
  lab: {
    cfg: undefined as { status: number; body: unknown } | undefined,
    putOptions: undefined as { onSuccess?: (res: unknown) => void; onError?: (err: unknown) => void } | undefined,
    putBody: undefined as { ports?: Record<string, number>; slot?: number } | undefined,
    putCalls: 0,
    branchCalls: 0,
    branchOptions: undefined as { onSuccess?: (res: unknown) => void } | undefined,
    refetches: 0,
    ccBuild: { sha: 'aaa', builtAt: 1, headSha: 'aaa', stale: false } as {
      sha: string | null;
      builtAt: number | null;
      headSha: string | null;
      stale: boolean;
    } | null,
  },
}));

vi.mock('@/lib/api', () => ({
  tsr: {
    getStackConfig: {
      useQuery: () => ({
        data: lab.cfg,
        refetch: () => {
          lab.refetches += 1;
          return Promise.resolve();
        },
      }),
    },
    listServices: { useQuery: () => ({ data: { status: 200, body: [] } }) },
    getStackBranches: {
      useQuery: () => ({
        data: { status: 200, body: { branch: 'master', error: null } },
        refetch: () => Promise.resolve(),
      }),
    },
    getRun: { useQuery: () => ({ data: undefined }) },
    getHost: {
      useQuery: () => ({ data: { status: 200, body: { ccBuild: lab.ccBuild } } }),
    },
    putStackConfig: {
      useMutation: () => ({
        isPending: false,
        mutate: (
          req: { body: { ports?: Record<string, number>; slot?: number } },
          options: { onSuccess?: (res: unknown) => void; onError?: (err: unknown) => void },
        ) => {
          lab.putCalls += 1;
          lab.putBody = req.body;
          lab.putOptions = options;
        },
      }),
    },
    putStackBranches: {
      useMutation: () => ({
        isPending: false,
        mutate: (_req: { body: { branch: string } }, options: { onSuccess?: (res: unknown) => void }) => {
          lab.branchCalls += 1;
          lab.branchOptions = options;
        },
      }),
    },
    reloadService: { useMutation: () => ({ isPending: false, mutate: () => {} }) },
    redeployStack: { useMutation: () => ({ isPending: false, mutate: () => {} }) },
  },
}));

vi.mock('@/lib/toast', () => ({
  useToast: () => ({ ok: () => {}, error: () => {}, info: () => {} }),
}));

vi.mock('@/lib/use-log-stream', () => ({
  useLogStream: () => ({
    open: () => {},
    logRef: { current: null },
    logHtml: '',
    logText: '',
    degraded: false,
    disconnected: false,
  }),
  usePaintedHtml: () => ({ current: null }),
}));

import { StackSettings } from './stack-settings';

const REFUSAL =
  'stack overlay state is unknown — the devenv eval seed failed, and saving now would wipe the fleet topology and port overrides in stack.local.nix. Fix the devenv eval and retry.';

function stackConfig(seeded: boolean, values: StackConfig['values']): StackConfig {
  return {
    seeded,
    knobs: {
      hub: [
        { env: 'HUB_REPO_PATH', label: 'Hub repo path', default: '/repo/hub', kind: 'text', group: 'Location' },
        { env: 'LOG_LEVEL', label: 'Log level', default: 'info', kind: 'text', group: 'Logging' },
      ],
      spoke: [
        { env: 'LIFECYCLE_WORKER_CONCURRENCY', label: 'Workers', default: '3', kind: 'number', group: 'Workers' },
      ],
    },
    ports: { hub: [{ label: 'api', value: '3000' }], spoke: [{ label: 'http', value: '8000' }] },
    servicePorts: [{ key: 'postgres', label: 'Postgres', value: 5433 }],
    values,
    counts: { hub: 1, spoke: 1 },
    slot: 0,
    identity: { pg: { user: 'pguser', password: 'pgpass', db: 'pgdb' }, orgId: 'org-1' },
    osLayerCache: { originHost: 'assets.example.test', resolvers: '9.9.9.9' },
    lan: { expose: false },
    telemetry: { enable: false },
  };
}

const LIVE_VALUES = { hub: { LOG_LEVEL: 'debug' }, spoke: { LIFECYCLE_WORKER_CONCURRENCY: '7' } };

beforeEach(() => {
  lab.cfg = undefined;
  lab.putOptions = undefined;
  lab.putBody = undefined;
  lab.putCalls = 0;
  lab.branchCalls = 0;
  lab.branchOptions = undefined;
  lab.refetches = 0;
  lab.ccBuild = { sha: 'aaa', builtAt: 1, headSha: 'aaa', stale: false };
});

afterEach(cleanup);

describe('StackSettings — a refused stack-config save', () => {
  function renderSeededAndEdit() {
    lab.cfg = { status: 200, body: stackConfig(true, LIVE_VALUES) };
    render(<StackSettings />);
    fireEvent.change(screen.getByDisplayValue('debug'), { target: { value: 'warn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));
    expect(lab.putCalls).toBe(1);
  }

  function refuse() {
    act(() => {
      lab.putOptions?.onError?.({ status: 503, body: { error: REFUSAL } });
    });
  }

  it("surfaces the server's message", () => {
    renderSeededAndEdit();

    refuse();

    expect(screen.getAllByText(REFUSAL).length).toBeGreaterThan(0);
  });

  it('leaves the form dirty with the save still offered', () => {
    renderSeededAndEdit();

    refuse();

    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save config' });
    expect(save.disabled).toBe(false);
  });

  it('does not clear the hub/spoke override or port fields', () => {
    renderSeededAndEdit();

    refuse();

    expect(screen.getByDisplayValue('warn')).toBeTruthy();
    expect(screen.getByDisplayValue('7')).toBeTruthy();
    expect(screen.getByDisplayValue('5433')).toBeTruthy();
  });

  it('refetches the config so a retry cannot resubmit the stale form', () => {
    renderSeededAndEdit();

    refuse();

    expect(lab.refetches).toBe(1);
  });
});

describe('StackSettings — a service-port field the operator clears', () => {
  function renderAndSetPort(value: string) {
    lab.cfg = { status: 200, body: stackConfig(true, LIVE_VALUES) };
    render(<StackSettings />);
    fireEvent.change(screen.getByDisplayValue('5433'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));
  }

  it('omits the blanked key from the saved ports body', () => {
    renderAndSetPort('');

    expect(lab.putBody?.ports).toEqual({});
  });

  it('omits an out-of-range key from the saved ports body', () => {
    renderAndSetPort('99999');

    expect(lab.putBody?.ports).toEqual({});
  });

  it('keeps an in-range edit in the saved ports body', () => {
    renderAndSetPort('5434');

    expect(lab.putBody?.ports).toEqual({ postgres: 5434 });
  });
});

describe('StackSettings — an unseeded stack config', () => {
  it('warns and disables the save instead of letting bare defaults be written', () => {
    lab.cfg = { status: 200, body: stackConfig(false, { hub: {}, spoke: {} }) };
    render(<StackSettings />);

    fireEvent.change(screen.getByDisplayValue('info'), { target: { value: 'warn' } });

    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save config' });
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(lab.putCalls).toBe(0);
    expect(screen.getByText('Saving is blocked')).toBeTruthy();
  });

  it('adopts the real values over a pending edit once the seed succeeds', () => {
    lab.cfg = { status: 200, body: stackConfig(false, { hub: {}, spoke: {} }) };
    const view = render(<StackSettings />);

    fireEvent.change(screen.getByDisplayValue('info'), { target: { value: 'warn' } });
    lab.cfg = { status: 200, body: stackConfig(true, LIVE_VALUES) };
    view.rerender(<StackSettings />);

    expect(screen.getByDisplayValue('debug')).toBeTruthy();
    expect(screen.queryByText('Saving is blocked')).toBeNull();
  });

  it('re-arms the adopt-over-dirty protection for a second unseeded window in one mount', () => {
    lab.cfg = { status: 200, body: stackConfig(true, LIVE_VALUES) };
    const view = render(<StackSettings />);

    lab.cfg = { status: 200, body: stackConfig(false, { hub: {}, spoke: {} }) };
    view.rerender(<StackSettings />);
    fireEvent.change(screen.getByDisplayValue('info'), { target: { value: 'warn' } });
    lab.cfg = { status: 200, body: stackConfig(true, LIVE_VALUES) };
    view.rerender(<StackSettings />);

    expect(screen.getByDisplayValue('debug')).toBeTruthy();
    expect(screen.queryByDisplayValue('warn')).toBeNull();
  });
});

describe('StackSettings — a stack slot change', () => {
  function slotStepper() {
    const stepper = screen.getByText('Stack slot').parentElement;
    if (!stepper) throw new Error('stack slot stepper not rendered');
    return within(stepper);
  }

  function renderAndBumpSlot(times: number) {
    lab.cfg = { status: 200, body: stackConfig(true, LIVE_VALUES) };
    render(<StackSettings />);
    const plus = slotStepper().getByRole('button', { name: '+' });
    for (let i = 0; i < times; i += 1) fireEvent.click(plus);
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));
    expect(lab.putCalls).toBe(1);
  }

  it('collects the bumped slot into the save body', () => {
    renderAndBumpSlot(3);

    expect(lab.putBody?.slot).toBe(3);
  });

  it('floors the slot at 0', () => {
    lab.cfg = { status: 200, body: stackConfig(true, LIVE_VALUES) };
    render(<StackSettings />);

    expect(slotStepper().getByRole('button', { name: '−' })).toHaveProperty('disabled', true);
  });

  it('surfaces the 409 conflict body when a live sibling owns the slot', () => {
    renderAndBumpSlot(3);

    act(() => {
      lab.putOptions?.onError?.({ status: 409, body: { error: 'slot 3 already claimed by /other/wt' } });
    });

    expect(screen.getAllByText('slot 3 already claimed by /other/wt').length).toBeGreaterThan(0);
  });
});

describe('StackSettings — a branch checkout while the seed has failed', () => {
  it('stays available because a checkout never writes the overlay', () => {
    lab.cfg = { status: 200, body: stackConfig(false, { hub: {}, spoke: {} }) };
    render(<StackSettings />);

    fireEvent.change(screen.getByDisplayValue('master'), { target: { value: 'feat/x' } });

    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save config' });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(lab.branchCalls).toBe(1);
    expect(lab.putCalls).toBe(0);
  });

  it('still blocks the save when a knob was edited too', () => {
    lab.cfg = { status: 200, body: stackConfig(false, { hub: {}, spoke: {} }) };
    render(<StackSettings />);

    fireEvent.change(screen.getByDisplayValue('master'), { target: { value: 'feat/x' } });
    fireEvent.change(screen.getByDisplayValue('info'), { target: { value: 'warn' } });

    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save config' });
    expect(save.disabled).toBe(true);
    expect(lab.branchCalls).toBe(0);
  });
});

describe('StackSettings — the rebuild note once the cc build is fresh', () => {
  it('does not render once the cc build is fresh even though rebuildRequired is still true', () => {
    lab.cfg = { status: 200, body: stackConfig(true, LIVE_VALUES) };
    lab.ccBuild = { sha: 'aaa', builtAt: 1, headSha: 'aaa', stale: false };
    render(<StackSettings />);

    fireEvent.change(screen.getByDisplayValue('master'), { target: { value: 'feat/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));
    act(() => {
      lab.branchOptions?.onSuccess?.({ body: { branch: 'feat/x', error: null, ccRebuildRequired: true } });
    });

    expect(screen.queryByText(/rebuild \+ restart the lab api/i)).toBeNull();
  });
});
