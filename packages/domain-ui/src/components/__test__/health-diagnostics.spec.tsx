import type { DeviceHealthChecksListResponse, DeviceHealthSummary, DeviceTokenSummary } from '@repo/api-client';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeDiagnosticsApi, renderWithDiagnostics } from '../../test/diagnostics-harness';
import type { DiagnosticDevice } from '../diagnostic-header-lines';
import { HealthDiagnostics } from '../health-diagnostics';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/', search: {}, searchStr: '' }),
}));

const DEVICE = '22222222-2222-2222-2222-222222222222';

const device: DiagnosticDevice = {
  id: DEVICE,
  displayName: 'gpu-node-07',
  zoneId: null,
  zoneName: null,
  bmcIp: '10.40.0.17',
  deployedOs: true,
  status: 'Provisioned',
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
    bmcCredsValid: false,
    poweredOn: true,
    brokkrLiveRunning: null,
    reachability: 'auth-failed',
  },
  isHealthy: false,
  reason: 'BMC credentials are invalid',
  icmpFiltered: false,
};

const history: DeviceHealthChecksListResponse = {
  data: [
    {
      id: 'hc-1',
      testedAt: '2026-09-16T11:21:00.000Z',
      primaryReachable: true,
      bmcIcmpReachable: true,
      bmcIpmiReachable: true,
      bmcRedfishReachable: true,
      bmcCredsValid: false,
      poweredOn: true,
      brokkrLiveRunning: null,
      reachability: 'auth-failed',
    },
  ],
  meta: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 },
  retentionDays: 7,
  edgeTriggered: true,
};

const token: DeviceTokenSummary = {
  id: 't-1',
  deviceId: DEVICE,
  context: 'DEPLOYMENT_OS',
  displayId: 'ab12',
  status: 'ACTIVE',
  rotationGeneration: 2,
  expiresAt: null,
  lastUsedAt: new Date(Date.now() - 4 * 60_000),
  lastUsedIp: '10.40.1.23',
  revokedAt: null,
  revokedReason: null,
  createdAt: new Date('2026-09-15T10:00:00.000Z'),
};

function api(overrides: Parameters<typeof fakeDiagnosticsApi>[0] = {}) {
  return fakeDiagnosticsApi({
    healthSummary: vi.fn().mockResolvedValue(summary),
    listHealthChecks: vi.fn().mockResolvedValue(history),
    listDeviceTokens: vi.fn().mockResolvedValue([token]),
    requestHealthCheck: vi.fn().mockResolvedValue({ jobId: 'health-request-1' }),
    ...overrides,
  });
}

afterEach(cleanup);

describe('HealthDiagnostics', () => {
  it('renders the summary, the history row and the token recency from the api', async () => {
    const fake = api();
    renderWithDiagnostics(<HealthDiagnostics device={device} />, fake);

    expect(await screen.findByText('Last checked 4 min ago.')).toBeInTheDocument();
    expect(screen.getByText('Reason: BMC credentials are invalid')).toBeInTheDocument();
    expect(await screen.findByText('4 min ago from 10.40.1.23')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(fake.listHealthChecks).toHaveBeenCalledWith(DEVICE, expect.objectContaining({ page: 1 }));
    expect(fake.listDeviceTokens).toHaveBeenCalledWith(DEVICE);
  });

  it('requests a check through the api and confirms it', async () => {
    const fake = api();
    renderWithDiagnostics(<HealthDiagnostics device={device} />, fake);

    fireEvent.click(await screen.findByRole('button', { name: /Check now/ }));
    expect(await screen.findByText(/^Check requested\./)).toBeInTheDocument();
    expect(fake.requestHealthCheck).toHaveBeenCalledWith(DEVICE);
  });

  it('shows the api message when the request is refused', async () => {
    const fake = api({
      requestHealthCheck: vi.fn().mockRejectedValue({ status: 409, body: { message: 'rejected at 11:21' } }),
    });
    renderWithDiagnostics(<HealthDiagnostics device={device} />, fake);

    fireEvent.click(await screen.findByRole('button', { name: /Check now/ }));
    expect(await screen.findByText('rejected at 11:21')).toBeInTheDocument();
  });

  it('disables check now and hides the tokens without the gates', async () => {
    const fake = api({ gates: { isLoading: false, can: () => false } });
    renderWithDiagnostics(<HealthDiagnostics device={device} />, fake);

    expect(await screen.findByRole('button', { name: /Check now/ })).toBeDisabled();
    expect(screen.queryByText('Device tokens')).toBeNull();
    expect(fake.listDeviceTokens).not.toHaveBeenCalled();
  });

  it('mutes the discovery os probe in the summary and the history while the deployed os runs', async () => {
    renderWithDiagnostics(<HealthDiagnostics device={device} />, api());

    expect(await screen.findByText('Last checked 4 min ago.')).toBeInTheDocument();
    expect(await screen.findAllByLabelText('discovery OS: not expected while the deployed OS runs')).toHaveLength(2);
    expect(screen.queryByLabelText('discovery OS: not tested')).toBeNull();
    expect(screen.getAllByLabelText('creds: failed')).toHaveLength(2);
  });

  it('reports the discovery os probe as untested before the deployed os runs', async () => {
    renderWithDiagnostics(
      <HealthDiagnostics device={{ ...device, deployedOs: false, status: 'Provisioning' }} />,
      api(),
    );

    expect(await screen.findByText('Last checked 4 min ago.')).toBeInTheDocument();
    expect(await screen.findAllByLabelText('discovery OS: not tested')).toHaveLength(2);
    expect(screen.queryByLabelText(/discovery OS: not expected/)).toBeNull();
  });

  it('explains a forbidden summary instead of the card', async () => {
    renderWithDiagnostics(
      <HealthDiagnostics device={device} />,
      api({ healthSummary: vi.fn().mockRejectedValue({ status: 403 }) }),
    );
    expect(await screen.findByText('You do not have access to this device.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Check now/ })).toBeNull();
  });
});
