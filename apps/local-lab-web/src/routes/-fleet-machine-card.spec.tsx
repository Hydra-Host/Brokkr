// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BootTrail, Machine, VerifyFinding } from '@/contract';
import { VerifyFindingsCard } from '@/features/fleet/verify-findings-card';

import { MachineCard } from './fleet';

const { lab } = vi.hoisted(() => ({
  lab: { trail: undefined as { status: number; body: BootTrail } | undefined },
}));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ to, hash, children }: { to: string; hash?: string; children: ReactNode }) => (
    <a href={hash === undefined ? to : `${to}#${hash}`}>{children}</a>
  ),
}));

vi.mock('@/lib/api', () => ({
  tsr: { getMachineBootTrail: { useQuery: () => ({ data: lab.trail }) } },
}));

const CONSOLE_REASON = 'console is the libvirt serial log — use the BMC KVM for a real machine';
const EXEC_REASON = 'exec needs the data IP, which the lab only knows for a VM';

const FLEET_FINDING: VerifyFinding = {
  node: null,
  kind: 'bootptab-missing',
  healable: true,
  detail: 'bootptab is missing',
};
const CPU_FINDING: VerifyFinding = {
  node: 'cpu-1',
  kind: 'domain-undefined',
  healable: false,
  detail: 'domain cpu-1 is not defined',
};
const METAL_FINDING: VerifyFinding = {
  node: 'metal-1',
  kind: 'bmc-unreachable',
  healable: false,
  detail: 'no route to 10.0.0.9',
};

function machine(over: Partial<Machine> = {}): Machine {
  return { name: 'metal-1', kind: 'baremetal', power: 'on', configured: true, deviceId: 'd', bmc: null, ...over };
}

function renderCard(
  over: Partial<Machine> = {},
  extra: Pick<ComponentProps<typeof MachineCard>, 'findings' | 'onShowFindings'> = {},
) {
  render(
    <MachineCard
      machine={machine(over)}
      findings={extra.findings}
      onShowFindings={extra.onShowFindings}
      busy={false}
      onPower={vi.fn()}
      onConsole={vi.fn()}
      onReset={vi.fn()}
      onDiscover={vi.fn()}
      onExec={vi.fn()}
    />,
  );
}

function button(label: string): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: label });
}

function details(): HTMLDetailsElement {
  const el = document.querySelector<HTMLDetailsElement>('#fleet-verify details');
  if (!el) throw new Error('no #fleet-verify details rendered');
  return el;
}

afterEach(() => {
  cleanup();
  lab.trail = undefined;
});

const OK_BMC: Machine['bmc'] = { reachable: 'ok', powerState: 'On' };

describe('MachineCard actions by kind', () => {
  it('disables console and exec for a bare-metal row with a reason', () => {
    renderCard();
    expect(button('console').disabled).toBe(true);
    expect(button('console').title).toBe(CONSOLE_REASON);
    expect(button('exec').disabled).toBe(true);
    expect(button('exec').title).toBe(EXEC_REASON);
  });

  it('keeps cycle, off, rediscover and reset enabled for a bare-metal row', () => {
    renderCard();
    for (const label of ['cycle', 'off', 'rediscover', 'reset']) {
      expect(button(label).disabled).toBe(false);
    }
  });

  it('keeps on enabled for a powered-off bare-metal row', () => {
    renderCard({ power: 'off' });
    expect(button('on').disabled).toBe(false);
  });

  it('enables every action for a vm row', () => {
    renderCard({ name: 'cpu-1', kind: 'vm' });
    for (const label of ['console', 'exec', 'cycle', 'off', 'rediscover', 'reset']) {
      expect(button(label).disabled).toBe(false);
      expect(button(label).title).toBe('');
    }
  });

  it('enables on for a powered-off vm row', () => {
    renderCard({ name: 'cpu-1', kind: 'vm', power: 'off' });
    expect(button('on').disabled).toBe(false);
  });
});

describe('MachineCard findings chip', () => {
  it('offers the machine findings through a labeled chip button', () => {
    const onShowFindings = vi.fn();
    renderCard({}, { findings: [METAL_FINDING], onShowFindings });
    const chip = button('1 verify finding for metal-1, show');
    expect(chip.title).toBe('');
    fireEvent.click(chip);
    expect(onShowFindings).toHaveBeenCalledTimes(1);
  });

  it('pluralises the chip label by the finding count', () => {
    renderCard({}, { findings: [METAL_FINDING, { ...METAL_FINDING, kind: 'bmc-auth-failed' }] });
    expect(button('2 verify findings for metal-1, show').textContent).toBe('⚠ 2');
  });

  it('renders no chip for a row without findings', () => {
    renderCard({}, { findings: [] });
    expect(screen.queryByRole('button', { name: /verify finding/ })).toBeNull();
  });
});

describe('MachineCard bare-metal strip', () => {
  function checklist(): HTMLAnchorElement | null {
    return screen.queryByRole<HTMLAnchorElement>('link', { name: /checklist/ });
  }

  it('renders the BMC and hub pills for a bare-metal row', () => {
    renderCard({ bmc: OK_BMC });
    expect(screen.getByText('BMC')).toBeTruthy();
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.getByText('hub')).toBeTruthy();
    expect(screen.getByText('d')).toBeTruthy();
  });

  it('renders no strip for a vm row', () => {
    lab.trail = { status: 200, body: { pxe: null, chainReached: false, chainAtMs: null, readError: null } };
    renderCard({ name: 'cpu-1', kind: 'vm' });
    expect(screen.queryByText('BMC')).toBeNull();
    expect(screen.queryByText('hub')).toBeNull();
    expect(checklist()).toBeNull();
    expect(screen.queryByText('no PXE request seen yet')).toBeNull();
  });

  it('links to the bare-metal checklist when the BMC is not ok', () => {
    renderCard({ bmc: { reachable: 'unreachable', powerState: null } });
    expect(checklist()?.getAttribute('href')).toBe('/config/fleet#BAREMETAL');
  });

  it('links to the bare-metal checklist when the row has findings', () => {
    renderCard({ bmc: OK_BMC }, { findings: [METAL_FINDING] });
    expect(checklist()?.getAttribute('href')).toBe('/config/fleet#BAREMETAL');
  });

  it('renders no checklist link for a healthy bare-metal row without findings', () => {
    renderCard({ bmc: OK_BMC }, { findings: [] });
    expect(checklist()).toBeNull();
  });

  it('shows the boot trail line under a bare-metal row', () => {
    lab.trail = { status: 200, body: { pxe: null, chainReached: false, chainAtMs: null, readError: null } };
    renderCard({ bmc: OK_BMC });
    expect(screen.getByText('no PXE request seen yet')).toBeTruthy();
  });
});

describe('VerifyFindingsCard remedies', () => {
  function renderFinding(finding: VerifyFinding) {
    render(
      <VerifyFindingsCard
        findings={[finding]}
        open={false}
        onOpenChange={vi.fn()}
        anyHealable={false}
        healing={false}
        onHeal={vi.fn()}
      />,
    );
  }

  it('names the off-box remedy for an unreachable bmc instead of needs apply', () => {
    renderFinding({ node: 'metal-1', kind: 'bmc-unreachable', healable: false, detail: 'no route to 10.0.0.9' });
    expect(screen.getByText('(check cabling and credentials)')).toBeDefined();
    expect(screen.queryByText(/needs apply/)).toBeNull();
  });

  it('keeps needs apply for an undefined domain', () => {
    renderFinding({ node: 'cpu-1', kind: 'domain-undefined', healable: false, detail: 'domain cpu-1 is not defined' });
    expect(screen.getByText('(needs apply)')).toBeDefined();
  });

  it('adds no suffix to a healable daemon finding', () => {
    renderFinding({ node: 'cpu-1', kind: 'sushy-down', healable: true, detail: 'sushy is not listening' });
    expect(screen.queryByText(/\(.*\)$/)).toBeNull();
  });
});

describe('VerifyFindingsCard disclosure', () => {
  function renderDisclosure(over: Partial<ComponentProps<typeof VerifyFindingsCard>> = {}) {
    const onOpenChange = vi.fn();
    const onHeal = vi.fn();
    render(
      <VerifyFindingsCard
        findings={[METAL_FINDING, FLEET_FINDING, CPU_FINDING]}
        open={false}
        onOpenChange={onOpenChange}
        anyHealable={false}
        healing={false}
        onHeal={onHeal}
        {...over}
      />,
    );
    return { onOpenChange, onHeal };
  }

  it('lists every finding inside the details grouped fleet first then per node', () => {
    renderDisclosure();
    const card = details();
    expect(
      within(card)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'bootptab is missing',
      'no route to 10.0.0.9 (check cabling and credentials)',
      'domain cpu-1 is not defined (needs apply)',
    ]);
    expect(within(card).getByText('fleet')).toBeDefined();
    expect(within(card).getByText('metal-1')).toBeDefined();
    expect(within(card).getByText('cpu-1')).toBeDefined();
  });

  it('carries the count in the summary and starts collapsed', () => {
    renderDisclosure();
    expect(details().open).toBe(false);
    expect(screen.getByText('▸ Fleet verify: 3 findings')).toBeDefined();
  });

  it('marks an open card with the down glyph and a singular count', () => {
    renderDisclosure({ findings: [FLEET_FINDING], open: true });
    expect(details().open).toBe(true);
    expect(screen.getByText('▾ Fleet verify: 1 finding')).toBeDefined();
  });

  it('keeps a heal click from toggling the disclosure', () => {
    const { onHeal, onOpenChange } = renderDisclosure({ anyHealable: true });
    const heal = button('heal');
    expect(details().contains(heal)).toBe(false);
    fireEvent.click(heal);
    expect(onHeal).toHaveBeenCalledTimes(1);
    expect(details().open).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('shows a code once even when the detail already leads with it', () => {
    renderDisclosure({
      findings: [
        {
          node: null,
          kind: 'boot-readiness',
          healable: false,
          code: 'PXE-102',
          detail: 'PXE-102 (error): This prefix serves no DHCP.',
        },
        { node: 'metal-1', kind: 'boot-readiness', healable: false, code: 'PXE-106', detail: 'no DHCP lease seen' },
      ],
    });
    expect(screen.getAllByText(/PXE-102/)).toHaveLength(1);
    expect(screen.getByText('PXE-106')).toBeDefined();
    const lines = within(details())
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(lines[0]).toBe('PXE-102 (error): This prefix serves no DHCP.');
    expect(lines[1]).toMatch(/^PXE-106/);
  });

  it('reports a summary click through onOpenChange', async () => {
    const { onOpenChange } = renderDisclosure();
    fireEvent.click(screen.getByText('▸ Fleet verify: 3 findings'));
    expect(details().open).toBe(true);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(true));
  });
});
