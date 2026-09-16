// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppLink, BootTrail, Machine, VerifyFinding } from '@/contract';

import {
  BareMetalStatus,
  deriveNextSteps,
  groupFindingsByNode,
  hubWebUrl,
  IDENTITY_CODE,
  PREFIX_CODES,
  type DeriveInput,
  type NextStep,
} from './baremetal-status';

const { lab } = vi.hoisted(() => ({
  lab: { trail: undefined as { status: number; body: BootTrail } | undefined },
}));

vi.mock('@/lib/api', () => ({
  tsr: { getMachineBootTrail: { useQuery: () => ({ data: lab.trail }) } },
}));

const MAC = 'aa:bb:cc:dd:ee:01';
const UPLINK = '172.16.12.60/22';

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    name: 'bm-1',
    kind: 'baremetal',
    power: 'on',
    configured: true,
    deviceId: 'dev-1',
    bmc: { reachable: 'ok', powerState: 'On' },
    ...overrides,
  };
}

function finding(overrides: Partial<VerifyFinding> = {}): VerifyFinding {
  return {
    node: 'bm-1',
    kind: 'no-hub-device',
    healable: false,
    detail: 'PXE-104 (error): prefix is not in proxy mode',
    code: 'PXE-104',
    ref: null,
    ...overrides,
  };
}

function input(overrides: Partial<DeriveInput> = {}): DeriveInput {
  return {
    machine: machine(),
    findings: [],
    bake: 'ok',
    hubWeb: 'http://h',
    pxeMac: MAC,
    uplink: UPLINK,
    onConfigure: null,
    ...overrides,
  };
}

function step(steps: NextStep[], id: NextStep['id']): NextStep {
  const found = steps.find((s) => s.id === id);
  if (!found) throw new Error(`missing step ${id}`);
  return found;
}

describe('deriveNextSteps', () => {
  it('links the prefix step to the hub card when a PXE-104 finding carries a ref', () => {
    const steps = deriveNextSteps(input({ findings: [finding({ ref: 'p-1' })] }));
    const prefix = step(steps, 'prefix-dhcp');
    expect(prefix.state).toBe('todo');
    expect(prefix.href).toBe('http://h/ipam/prefixes/p-1/edit');
    expect(prefix.label).toContain('PROXY');
    expect(prefix.label).toContain('SNPONLY');
    expect(prefix.label).toContain(MAC);
  });

  it('leaves the prefix step unlinked when the hub web url is unknown', () => {
    const steps = deriveNextSteps(input({ hubWeb: null, findings: [finding({ ref: 'p-1' })] }));
    expect(step(steps, 'prefix-dhcp')).toMatchObject({ state: 'todo', href: null });
  });

  it('marks the prefix step done when no prefix finding exists', () => {
    const steps = deriveNextSteps(input({ findings: [finding({ code: 'PXE-111' })] }));
    expect(step(steps, 'prefix-dhcp')).toMatchObject({ state: 'done', href: null });
  });

  it('asks for a bake when none has run', () => {
    expect(step(deriveNextSteps(input({ bake: 'missing' })), 'bake').state).toBe('todo');
    expect(step(deriveNextSteps(input({ bake: 'ok' })), 'bake').state).toBe('done');
  });

  it('asks for a re-bake when the bake is stale', () => {
    const bake = step(deriveNextSteps(input({ bake: 'stale' })), 'bake');
    expect(bake.state).toBe('todo');
    expect(bake.label).toContain('Re-bake');
  });

  it('asks for a credential fix when the bmc rejected it', () => {
    const steps = deriveNextSteps(input({ machine: machine({ bmc: { reachable: 'auth-failed', powerState: null } }) }));
    const bmc = step(steps, 'bmc');
    expect(bmc.state).toBe('todo');
    expect(bmc.label).toContain('credential');
  });

  it('asks for bmc settings when the row has none saved', () => {
    const steps = deriveNextSteps(input({ machine: machine({ bmc: null }) }));
    expect(step(steps, 'bmc')).toMatchObject({ state: 'todo', label: 'Save a BMC address, user and password' });
  });

  it('flags the hub device step when a PXE-106 finding reports a split identity', () => {
    const steps = deriveNextSteps(input({ findings: [finding({ kind: 'identity-split', code: 'PXE-106' })] }));
    expect(step(steps, 'hub-device').state).toBe('todo');
    expect(step(steps, 'prefix-dhcp').state).toBe('done');
  });

  it('leaves the machine-derived steps unknown until the machine is listed', () => {
    const steps = deriveNextSteps(input({ machine: undefined, bake: 'missing' }));
    expect(step(steps, 'prefix-dhcp').state).toBe('unknown');
    expect(step(steps, 'hub-device').state).toBe('unknown');
    expect(step(steps, 'bmc').state).toBe('unknown');
    expect(step(steps, 'bake').state).toBe('todo');
    expect(step(steps, 'boot').state).toBe('todo');
  });

  it('orders the steps bake, prefix, hub device, bmc, boot', () => {
    expect(deriveNextSteps(input()).map((s) => s.id)).toEqual(['bake', 'prefix-dhcp', 'hub-device', 'bmc', 'boot']);
  });

  it('names the uplink cidr in the prefix step label', () => {
    const prefix = step(deriveNextSteps(input()), 'prefix-dhcp');
    expect(prefix.label).toBe(
      `Set the uplink prefix containing ${UPLINK} to DHCP mode PROXY, iPXE target SNPONLY, and allow ${MAC} in the hub`,
    );
    expect(step(deriveNextSteps(input({ uplink: null })), 'prefix-dhcp').label).toContain('the uplink address');
  });

  it('flags the prefix step for PXE-112 and PXE-04 findings', () => {
    expect(step(deriveNextSteps(input({ findings: [finding({ code: 'PXE-112' })] })), 'prefix-dhcp').state).toBe(
      'todo',
    );
    expect(step(deriveNextSteps(input({ findings: [finding({ code: 'PXE-04' })] })), 'prefix-dhcp').state).toBe('todo');
  });

  it('links the prefix step to the hub prefix list when no finding carries a ref', () => {
    const prefix = step(deriveNextSteps(input({ findings: [finding({ code: 'PXE-102', ref: null })] })), 'prefix-dhcp');
    expect(prefix).toMatchObject({ state: 'todo', href: 'http://h/ipam/prefixes' });
  });
});

describe('groupFindingsByNode', () => {
  it('groups node findings by name and drops fleet-level ones', () => {
    const byNode = groupFindingsByNode([
      finding({ node: 'bm-1' }),
      finding({ node: 'bm-2', code: 'PXE-106' }),
      finding({ node: null, code: 'PXE-105' }),
      finding({ node: 'bm-1', code: 'PXE-111' }),
    ]);
    expect([...byNode.keys()]).toEqual(['bm-1', 'bm-2']);
    expect(byNode.get('bm-1')?.map((f) => f.code)).toEqual(['PXE-104', 'PXE-111']);
    expect(byNode.get('bm-2')).toHaveLength(1);
  });
});

describe('hubWebUrl', () => {
  function link(overrides: Partial<AppLink> = {}): AppLink {
    return { id: 'hub-web', label: 'Hub', port: 5173, path: '/', ready: true, loopback: false, ...overrides };
  }

  it('builds the hub origin from the hub-web app link on the browser host', () => {
    expect(hubWebUrl([link({ id: 'grafana', port: 3001 }), link()])).toBe(`http://${window.location.hostname}:5173`);
  });

  it('targets localhost for a loopback-only hub-web', () => {
    expect(hubWebUrl([link({ loopback: true })])).toBe('http://localhost:5173');
  });

  it('returns null without a hub-web link', () => {
    expect(hubWebUrl([link({ id: 'grafana' })])).toBeNull();
    expect(hubWebUrl([])).toBeNull();
  });
});

describe('BareMetalStatus', () => {
  afterEach(() => {
    cleanup();
    lab.trail = undefined;
  });

  it('shows save to probe on an unsaved row', () => {
    render(<BareMetalStatus {...input()} dirty />);
    expect(screen.getByText('save to probe')).toBeTruthy();
    expect(screen.queryByText(/PROXY/)).toBeNull();
  });

  it('renders the power, bmc and hub strip for a listed machine', () => {
    render(<BareMetalStatus {...input()} dirty={false} />);
    expect(screen.getByText('on')).toBeTruthy();
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.getByText('dev-1')).toBeTruthy();
    expect(screen.getAllByLabelText('done').length).toBeGreaterThan(0);
  });

  it('renders the prefix step as a link into the hub prefix editor', () => {
    render(
      <BareMetalStatus
        {...input({ machine: machine({ deviceId: null }), findings: [finding({ ref: 'p-1' })] })}
        dirty={false}
      />,
    );
    const link = screen.getByRole('link', { name: /PROXY/ });
    expect(link.getAttribute('href')).toBe('http://h/ipam/prefixes/p-1/edit');
    expect(screen.getByText('no device')).toBeTruthy();
  });

  it('says the row is not probed yet when the machine is not listed', () => {
    render(<BareMetalStatus {...input({ machine: undefined })} dirty={false} />);
    expect(screen.getByText('not probed yet')).toBeTruthy();
    expect(screen.getAllByLabelText('unknown')).toHaveLength(3);
  });

  it('renders a Configure in hub button on a todo prefix step and calls onConfigure', () => {
    const onConfigure = vi.fn();
    render(<BareMetalStatus {...input({ findings: [finding()], onConfigure })} dirty={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure in hub' }));

    expect(onConfigure).toHaveBeenCalledTimes(1);
  });

  it('renders no Configure in hub button when the step is done or onConfigure is null', () => {
    render(<BareMetalStatus {...input({ onConfigure: vi.fn() })} dirty={false} />);
    expect(screen.queryByRole('button', { name: 'Configure in hub' })).toBeNull();
    cleanup();

    render(<BareMetalStatus {...input({ findings: [finding()], onConfigure: null })} dirty={false} />);
    expect(screen.queryByRole('button', { name: 'Configure in hub' })).toBeNull();
  });

  function trail(overrides: Partial<BootTrail> = {}): BootTrail {
    return { pxe: null, chainReached: false, chainAtMs: null, readError: null, ...overrides };
  }

  it('shows the boot trail line for a listed machine', () => {
    lab.trail = { status: 200, body: trail() };
    render(<BareMetalStatus {...input()} dirty={false} />);
    expect(screen.getByText('no PXE request seen yet')).toBeTruthy();
  });

  it('renders no boot trail line for an unlisted machine', () => {
    lab.trail = { status: 200, body: trail() };
    render(<BareMetalStatus {...input({ machine: undefined })} dirty={false} />);
    expect(screen.queryByText('no PXE request seen yet')).toBeNull();
  });
});

describe('hub readiness codes the card branches on', () => {
  it('pins the prefix codes to the hub prefix readiness registry and the lab uplink checks', () => {
    expect([...PREFIX_CODES].sort()).toEqual(['PXE-04', 'PXE-102', 'PXE-103', 'PXE-104', 'PXE-112']);
  });

  it('pins the identity split code', () => {
    expect(IDENTITY_CODE).toBe('PXE-106');
  });
});
