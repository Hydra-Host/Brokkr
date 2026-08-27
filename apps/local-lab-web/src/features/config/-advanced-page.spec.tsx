// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfigTreeEntry } from '@/contract';

const { lab } = vi.hoisted(() => ({
  lab: {
    tree: undefined as { status: number; body: unknown } | undefined,
    putBody: undefined as unknown,
    putOptions: undefined as { onSuccess?: (r: { body: unknown }) => void; onError?: (e: unknown) => void } | undefined,
  },
}));

vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle', proceed: () => {}, reset: () => {} }),
}));
vi.mock('@/lib/api', () => ({
  tsr: {
    getConfigTree: { useQuery: () => ({ data: lab.tree, error: undefined, refetch: () => Promise.resolve() }) },
    putStackConfig: {
      useMutation: () => ({
        isPending: false,
        mutate: (vars: { body: unknown }, opts: typeof lab.putOptions) => {
          lab.putBody = vars.body;
          lab.putOptions = opts;
        },
      }),
    },
  },
}));
vi.mock('@/components/config/section-rail', () => ({ SectionRail: () => null, scrollToSection: () => {} }));

import { ConfigAdvancedPage } from './advanced-page';

const entry = (over: Partial<ConfigTreeEntry> & { path: string }): ConfigTreeEntry => {
  const base: ConfigTreeEntry = {
    label: 'Label',
    group: 'Group',
    description: 'why this knob exists',
    value: 'true',
    default: 'true',
    definedIn: [],
    secret: false,
    overridden: false,
    writable: true,
    kind: 'bool',
    choices: [],
    danger: false,
    applyClass: 'redeploy',
    ...over,
  };
  return { ...base, overridden: over.overridden ?? base.value !== base.default };
};

const open = (entries: ConfigTreeEntry[]) => {
  lab.tree = { status: 200, body: { seeded: true, entries } };
  render(<ConfigAdvancedPage />);
};

beforeEach(() => {
  cleanup();
  lab.tree = undefined;
  lab.putBody = undefined;
  lab.putOptions = undefined;
});

describe('ConfigAdvancedPage — behavioural forks', () => {
  it('offers a control for a writable fork', () => {
    open([entry({ path: 'redisAcl.enable', label: 'Per-zone Redis ACLs' })]);

    expect(screen.getByLabelText('Per-zone Redis ACLs')).toBeTruthy();
  });

  it('sends the edited path under its canonical name', () => {
    open([entry({ path: 'redisAcl.enable', label: 'Per-zone Redis ACLs' })]);

    fireEvent.change(screen.getByLabelText('Per-zone Redis ACLs'), { target: { value: 'false' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));

    expect(lab.putBody).toEqual({ entries: { 'redisAcl.enable': 'false' } });
  });

  it('sends nothing for a path it did not touch', () => {
    open([entry({ path: 'redisAcl.enable', label: 'A' }), entry({ path: 'vrrpSim.enable', label: 'B' })]);

    fireEvent.change(screen.getByLabelText('A'), { target: { value: 'false' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));

    expect(lab.putBody).toEqual({ entries: { 'redisAcl.enable': 'false' } });
  });

  it('names each refused path with its reason rather than only that it failed', () => {
    open([entry({ path: 'redisAcl.enable', label: 'A' })]);

    fireEvent.change(screen.getByLabelText('A'), { target: { value: 'false' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));
    act(() => {
      lab.putOptions?.onSuccess?.({
        body: { ok: true, applied: [], rejected: [{ path: 'redisAcl.enable', reason: 'pinned', detail: 'BROKKR_X' }] },
      });
    });

    expect(screen.getByText('redisAcl.enable — pinned (BROKKR_X)')).toBeTruthy();
  });
});

describe('ConfigAdvancedPage — the keys that must never be a text input', () => {
  const key = () =>
    entry({
      path: 'zoneCrypto.hubPrivateKey',
      label: 'Hub private key',
      secret: true,
      danger: true,
      writable: false,
      kind: 'text',
      value: '***',
      default: '***',
      valueDigest: 'abc12345',
    });

  it('renders no input at all for a secret', () => {
    open([key()]);

    expect(screen.queryByLabelText('Hub private key')).toBeNull();
  });

  it('shows it as keyed state with the fingerprint rather than the value', () => {
    open([key()]);

    expect(screen.getByText(/● keyed abc12345/)).toBeTruthy();
  });

  it('says the value never reaches the page', () => {
    open([key()]);

    expect(screen.getByText(/never reaches this page/)).toBeTruthy();
  });

  it('renders no input even if the server called it writable, because a secret is never typed here', () => {
    open([{ ...key(), writable: true }]);

    expect(screen.queryByLabelText('Hub private key')).toBeNull();
  });

  it('marks a danger knob whatever else the row says', () => {
    open([key()]);

    expect(screen.getByText('⚠')).toBeTruthy();
  });
});

describe('ConfigAdvancedPage — a path with no writer', () => {
  it('shows the value and says where to set it instead', () => {
    open([
      entry({ path: 'polyrepo.hub.path', label: 'Hub checkout path', writable: false, kind: 'text', value: '/co' }),
    ]);

    expect(screen.getByText('/co')).toBeTruthy();
    expect(screen.getByText(/set it in devenv\.local\.nix/)).toBeTruthy();
  });

  it('reads an unset value as (unset) rather than as a blank', () => {
    open([entry({ path: 'polyrepo.hub.url', label: 'U', writable: false, kind: 'text', value: null, default: null })]);

    expect(screen.getByText('(unset)')).toBeTruthy();
  });

  it('names the variable when a pin holds the path', () => {
    open([entry({ path: 'redisAcl.enable', label: 'A', pinnedBy: 'BROKKR_ACL' })]);

    expect(screen.getByText(/unset \$BROKKR_ACL to change it/)).toBeTruthy();
  });

  it('still offers a control for a writable path no rule classifies, since writable is the only gate', () => {
    open([entry({ path: 'redisAcl.enable', label: 'A', applyClass: null })]);

    expect(screen.getByLabelText('A')).toBeTruthy();
  });

  it('keeps a non-writable path read-only whatever its apply class says', () => {
    open([entry({ path: 'redisAcl.enable', label: 'A', writable: false, applyClass: 'datastore-reset' })]);

    expect(screen.queryByLabelText('A')).toBeNull();
    expect(screen.getByText(/set it in devenv\.local\.nix/)).toBeTruthy();
  });

  it('blames the missing reader, not a missing writer, for an inert knob', () => {
    open([
      entry({
        path: 'stackDefaults.spoke.ANALYTICS_ENABLED',
        label: 'Analytics',
        writable: false,
        applyClass: 'inert',
      }),
    ]);

    expect(screen.getByText(/nothing reads this path today/)).toBeTruthy();
    expect(screen.queryByText(/set it in devenv\.local\.nix/)).toBeNull();
  });
});

describe('ConfigAdvancedPage — the residue', () => {
  it('lists a catalogued path no rule owns, so the gap stays measurable', () => {
    open([entry({ path: 'remoteInfra.enable', label: 'Remote infra' })]);

    expect(screen.getByText('remoteInfra.enable')).toBeTruthy();
  });

  it('says so plainly when every catalogued path has an editor', () => {
    open([entry({ path: 'redisAcl.enable', label: 'A' })]);

    expect(screen.getByText('every catalogued path has an editor')).toBeTruthy();
  });

  it('keeps a path another page owns off this one entirely', () => {
    open([entry({ path: 'stackDefaults.hub.LOG_LEVEL', label: 'Log level', kind: 'select' })]);

    expect(screen.queryByText('stackDefaults.hub.LOG_LEVEL')).toBeNull();
  });
});

describe('ConfigAdvancedPage — a select knob', () => {
  it('offers its declared choices rather than a free-text box', () => {
    open([
      entry({ path: 'redisAcl.enable', label: 'Mode', kind: 'select', choices: ['a', 'b'], value: 'a', default: 'a' }),
    ]);

    const control = screen.getByLabelText('Mode');
    expect(control.tagName).toBe('SELECT');
    expect(Array.from(control.querySelectorAll('option')).map((o) => o.textContent)).toEqual(['a', 'b']);
  });

  it('still offers true and false for a bool', () => {
    open([entry({ path: 'redisAcl.enable', label: 'Flag', kind: 'bool' })]);

    const control = screen.getByLabelText('Flag');
    expect(Array.from(control.querySelectorAll('option')).map((o) => o.textContent)).toEqual(['true', 'false']);
  });
});
