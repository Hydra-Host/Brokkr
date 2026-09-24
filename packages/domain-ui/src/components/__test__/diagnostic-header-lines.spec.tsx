import type { DeviceBootTrail, DeviceHealthSummary, DeviceTokenSummary } from '@repo/api-client';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeDiagnosticsApi, renderWithDiagnostics } from '../../test/diagnostics-harness';
import {
  BootHeaderLine,
  HeaderLine,
  HeaderLines,
  HealthHeaderLine,
  PhoneHomeHeaderLine,
  type DiagnosticDevice,
} from '../diagnostic-header-lines';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

const DEVICE = '7f3a2c1e-9b0d-4e5f-a6c7-8d9e0f1a2b3c';

const device = (over: Partial<DiagnosticDevice> = {}): DiagnosticDevice => ({
  id: DEVICE,
  displayName: 'gpu-node-07',
  zoneId: null,
  zoneName: null,
  bmcIp: null,
  deployedOs: false,
  status: 'Inventory',
  ...over,
});

const trail: DeviceBootTrail = {
  deviceId: DEVICE,
  pxeMac: '3c:ec:ef:1a:2b:3c',
  pxeInterface: 'eth0',
  pxeMacSource: 'address',
  candidateMacs: [],
  zoneId: '11111111-1111-1111-1111-111111111111',
  trail: {
    pxe: { outcome: 'offered', atMs: 1789560131000 },
    chainReached: true,
    chainAtMs: 1789560139000,
    chainDeviceMismatch: false,
    readError: null,
  },
  bootExpected: { expected: true, since: '2026-09-16T11:00:00.000Z', reason: 'active-job' },
  readAt: '2026-09-16T12:00:00.000Z',
};

const summary: DeviceHealthSummary = {
  view: 'owner',
  source: 'snapshot',
  checkedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  checks: {
    primaryReachable: true,
    bmcIcmpReachable: true,
    bmcIpmiReachable: true,
    bmcRedfishReachable: true,
    bmcCredsValid: true,
    poweredOn: true,
    brokkrLiveRunning: null,
    reachability: 'ok',
  },
  isHealthy: true,
  reason: null,
  icmpFiltered: false,
};

const token = (over: Partial<DeviceTokenSummary> = {}): DeviceTokenSummary => ({
  id: 't-1',
  deviceId: DEVICE,
  context: 'DEPLOYMENT_OS',
  displayId: 'ab12',
  status: 'ACTIVE',
  rotationGeneration: 0,
  expiresAt: null,
  lastUsedAt: null,
  lastUsedIp: null,
  revokedAt: null,
  revokedReason: null,
  createdAt: new Date('2026-09-15T10:00:00.000Z'),
  ...over,
});

afterEach(cleanup);

describe('HeaderLines', () => {
  it('renders the id and the BMC address as copyable lines', () => {
    render(<HeaderLines device={device({ bmcIp: '10.40.0.17' })} />);
    expect(screen.getByText(DEVICE)).toBeTruthy();
    expect(screen.getByText('10.40.0.17')).toBeTruthy();
  });

  it('omits the BMC line when no address is known', () => {
    render(<HeaderLines device={device()} />);
    expect(screen.queryByText('bmc')).toBeNull();
  });

  it('renders the extra lines inside the same list', () => {
    render(<HeaderLines device={device()} extra={<HeaderLine label="zone">rack-7</HeaderLine>} />);
    const term = screen.getByText('zone');
    expect(term.closest('dl')).toBe(screen.getByText('id').closest('dl'));
    expect(screen.getByText('rack-7')).toBeTruthy();
  });
});

describe('BootHeaderLine', () => {
  it('links the trail line to the diagnostics page while the device may network-boot', async () => {
    const bootTrail = vi.fn().mockResolvedValue(trail);
    renderWithDiagnostics(<BootHeaderLine device={device()} />, fakeDiagnosticsApi({ bootTrail }));

    const line = await screen.findByText(/^boot trail\s*$/);
    expect(line.closest('a')).toHaveAttribute('href', `/servers/${DEVICE}/diagnostics`);
    expect(screen.getByText('boot')).toBeInTheDocument();
    expect(bootTrail).toHaveBeenCalledWith(DEVICE);
  });

  it('renders nothing and reads nothing once the device is past network boot', () => {
    const bootTrail = vi.fn().mockResolvedValue(trail);
    const { container } = renderWithDiagnostics(
      <BootHeaderLine device={device({ status: 'Provisioned' })} />,
      fakeDiagnosticsApi({ bootTrail }),
    );

    expect(container).toBeEmptyDOMElement();
    expect(bootTrail).not.toHaveBeenCalled();
  });

  it('renders nothing until the trail has loaded', () => {
    const { container } = renderWithDiagnostics(
      <BootHeaderLine device={device()} />,
      fakeDiagnosticsApi({ bootTrail: () => new Promise(() => {}) }),
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('HealthHeaderLine', () => {
  it('links the summary line and the bmc reachability to the health page', async () => {
    const healthSummary = vi.fn().mockResolvedValue(summary);
    renderWithDiagnostics(<HealthHeaderLine device={device()} />, fakeDiagnosticsApi({ healthSummary }));

    const line = await screen.findByText(/^Last checked 4 min ago\. BMC ok\.$/);
    expect(line.closest('a')).toHaveAttribute('href', `/servers/${DEVICE}/health`);
    expect(screen.getByText('health')).toBeInTheDocument();
    expect(healthSummary).toHaveBeenCalledWith(DEVICE);
  });

  it('renders nothing until the summary has loaded', () => {
    const { container } = renderWithDiagnostics(
      <HealthHeaderLine device={device()} />,
      fakeDiagnosticsApi({ healthSummary: () => new Promise(() => {}) }),
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PhoneHomeHeaderLine', () => {
  it('reports the newest phone-home even when that token was rotated out', async () => {
    const listDeviceTokens = vi.fn().mockResolvedValue([
      token({ id: 't-old', status: 'REVOKED', lastUsedAt: new Date(Date.now() - 60_000) }),
      token({ id: 't-new', status: 'ACTIVE', lastUsedAt: null }),
    ]);
    renderWithDiagnostics(<PhoneHomeHeaderLine device={device()} />, fakeDiagnosticsApi({ listDeviceTokens }));

    const line = await screen.findByText(/deployment OS/);
    expect(line.closest('a')).toHaveAttribute('href', `/servers/${DEVICE}/health`);
    expect(screen.queryByText('No phone-home recorded')).toBeNull();
    expect(listDeviceTokens).toHaveBeenCalledWith(DEVICE);
  });

  it('names the discovery os when the newest phone-home came from brokkr live', async () => {
    const listDeviceTokens = vi.fn().mockResolvedValue([
      token({ id: 't-live', context: 'BROKKR_LIVE', lastUsedAt: new Date(Date.now() - 60_000) }),
      token({ id: 't-os', lastUsedAt: new Date(Date.now() - 3 * 60_000) }),
    ]);
    renderWithDiagnostics(<PhoneHomeHeaderLine device={device()} />, fakeDiagnosticsApi({ listDeviceTokens }));
    expect(await screen.findByText(/discovery OS/)).toBeInTheDocument();
  });

  it('says so when no token has phoned home', async () => {
    renderWithDiagnostics(
      <PhoneHomeHeaderLine device={device()} />,
      fakeDiagnosticsApi({ listDeviceTokens: vi.fn().mockResolvedValue([token()]) }),
    );
    expect(await screen.findByText('No phone-home recorded')).toBeInTheDocument();
  });

  it('renders nothing and reads nothing without the device-token gate', () => {
    const listDeviceTokens = vi.fn().mockResolvedValue([token()]);
    const { container } = renderWithDiagnostics(
      <PhoneHomeHeaderLine device={device()} />,
      fakeDiagnosticsApi({
        listDeviceTokens,
        gates: { isLoading: false, can: (gate) => gate !== 'device-tokens.read' },
      }),
    );
    expect(container).toBeEmptyDOMElement();
    expect(listDeviceTokens).not.toHaveBeenCalled();
  });
});
