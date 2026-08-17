// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FleetConfig } from '@/contract';

const { lab } = vi.hoisted(() => ({
  lab: {
    cfg: undefined as { status: number; body: unknown } | undefined,
  },
}));

vi.mock('@/lib/api', () => ({
  tsr: {
    getFleetConfig: { useQuery: () => ({ data: lab.cfg, dataUpdatedAt: 1, refetch: () => Promise.resolve() }) },
    getHost: {
      useQuery: () => ({
        data: { status: 200, body: { os: 'linux', arch: 'amd64', passthroughSupported: true } },
      }),
    },
    listPci: { useQuery: () => ({ data: { status: 200, body: [] } }) },
    listHostNics: {
      useQuery: () => ({ data: { status: 200, body: [{ name: 'eth9', ipv4: '198.51.100.31/24', up: true }] } }),
    },
    listStackRuns: { useQuery: () => ({ data: { status: 200, body: [] }, refetch: () => Promise.resolve() }) },
    getRun: { useQuery: () => ({ data: undefined, dataUpdatedAt: 0 }) },
    putFleetConfig: { useMutation: () => ({ isPending: false, submittedAt: 0, data: undefined, mutate: () => {} }) },
    startStackRun: { useMutation: () => ({ isPending: false, mutate: () => {} }) },
    baremetalPower: { useMutation: () => ({ isPending: false, mutate: () => {} }) },
  },
}));

vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle', proceed: () => {}, reset: () => {} }),
}));
vi.mock('@/lib/toast', () => ({ useToast: () => ({ ok: () => {}, error: () => {}, info: () => {} }) }));
vi.mock('@/lib/apply-run', () => ({
  useApplyPending: () => ({ apply: () => Promise.resolve(), launchRun: () => {}, isPending: false }),
}));
vi.mock('@/lib/pending', () => ({ saveToastMessage: () => 'saved' }));
vi.mock('@/components/stack-settings', () => ({ StackSettings: () => null }));
vi.mock('@/components/manifest-viewer', () => ({ ManifestViewer: () => null }));
vi.mock('@/components/pending-banner', () => ({ PendingBanner: () => null }));

import { SettingsPage } from './settings-page';

function fleetConfig(): FleetConfig {
  return {
    source: 'local',
    mode: 'vm',
    baremetal: { nics: [], arch: 'amd64', nodes: [] },
    bakedChainUrl: null,
    nodes: [],
    zones: ['local'],
    network: { cidr: '192.168.200.0/24', bmcCidr: '192.168.105.0/24' },
    bmcDefaults: { username: 'admin', password: 'admin' },
  };
}

function openBareMetal(): ReturnType<typeof render> {
  lab.cfg = { status: 200, body: fleetConfig() };
  const view = render(<SettingsPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Fleet' }));
  fireEvent.click(screen.getByText('Bare metal fleet'));
  return view;
}

function serverRefetch(view: ReturnType<typeof render>): void {
  lab.cfg = { status: 200, body: fleetConfig() };
  view.rerender(<SettingsPage />);
}

beforeEach(() => {
  lab.cfg = undefined;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SettingsPage — a fleet-config refetch while the operator edits', () => {
  it('leaves the selected bare-metal mode in place', () => {
    const view = openBareMetal();
    expect(screen.getByText('Uplink NIC')).toBeTruthy();

    serverRefetch(view);

    expect(screen.getByText('Uplink NIC')).toBeTruthy();
  });

  it('keeps a half-filled machine row', () => {
    const view = openBareMetal();
    fireEvent.click(screen.getByRole('button', { name: '+ Add server' }));
    fireEvent.change(screen.getByDisplayValue('metal-1'), { target: { value: 'rack-7' } });

    serverRefetch(view);

    expect(screen.getByDisplayValue('rack-7')).toBeTruthy();
  });

  it('keeps the selected uplink NIC', () => {
    const view = openBareMetal();
    fireEvent.change(screen.getByDisplayValue('— select a NIC —'), { target: { value: 'eth9' } });

    serverRefetch(view);

    expect(screen.getByDisplayValue('eth9 — 198.51.100.31/24')).toBeTruthy();
  });

  it('still hydrates from the server before any edit', () => {
    lab.cfg = { status: 200, body: { ...fleetConfig(), mode: 'baremetal' } };
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Fleet' }));

    expect(screen.getByText('Uplink NIC')).toBeTruthy();
  });
});
