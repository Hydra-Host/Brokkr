import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useConfigQuery, useServingQuery, useReservationsQuery, useLeasesQuery } = vi.hoisted(() => ({
  useConfigQuery: vi.fn(),
  useServingQuery: vi.fn(),
  useReservationsQuery: vi.fn(),
  useLeasesQuery: vi.fn(),
}));

vi.mock('~/lib/api', () => ({
  tsr: {
    getPrefixDhcpConfig: { useQuery: useConfigQuery },
    getPrefixDhcpServing: { useQuery: useServingQuery },
    getPrefixDhcpReservations: { useQuery: useReservationsQuery },
    getPrefixDhcpLeases: { useQuery: useLeasesQuery },
  },
}));

import { PrefixDhcpSummaryCard } from '../prefix-dhcp-summary-card';

function mockIdle() {
  return { data: undefined, isPending: true, isLoading: false, isFetching: false, isError: false };
}

function mockLoading() {
  return { data: undefined, isPending: true, isLoading: true, isFetching: true, isError: false };
}

function mockSuccess<T>(body: T) {
  return { data: { status: 200, body }, isPending: false, isLoading: false, isFetching: false, isError: false };
}

function mockError() {
  return { data: undefined, isPending: false, isLoading: false, isFetching: false, isError: true };
}

describe('PrefixDhcpSummaryCard render', () => {
  beforeEach(() => {
    useConfigQuery.mockReset();
    useServingQuery.mockReset();
    useReservationsQuery.mockReset();
    useLeasesQuery.mockReset();

    useServingQuery.mockReturnValue(mockIdle());
    useReservationsQuery.mockReturnValue(mockIdle());
    useLeasesQuery.mockReturnValue(mockIdle());
  });

  it('shows skeleton while config is loading', () => {
    useConfigQuery.mockReturnValue(mockLoading());
    const { container } = render(<PrefixDhcpSummaryCard prefixId="p1" />);
    expect(container.querySelector('.h-48')).toBeInTheDocument();
  });

  it('shows error card when config query fails', () => {
    useConfigQuery.mockReturnValue(mockError());
    render(<PrefixDhcpSummaryCard prefixId="p1" />);
    expect(screen.getByText('Failed to load DHCP configuration.')).toBeInTheDocument();
  });

  it('shows OFF badge when mode is OFF', () => {
    useConfigQuery.mockReturnValue(mockSuccess({ dhcpMode: 'OFF' }));
    render(<PrefixDhcpSummaryCard prefixId="p1" />);
    expect(screen.getByText('OFF')).toBeInTheDocument();
    expect(screen.getByText('DHCP is explicitly disabled for this prefix.')).toBeInTheDocument();
  });

  it('shows not-configured badge when mode is null', () => {
    useConfigQuery.mockReturnValue(mockSuccess({ dhcpMode: null }));
    render(<PrefixDhcpSummaryCard prefixId="p1" />);
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getByText('DHCP has not been configured for this prefix.')).toBeInTheDocument();
  });

  it('does not show infinite skeleton for PROXY mode with disabled leases query', () => {
    useConfigQuery.mockReturnValue(mockSuccess({ dhcpMode: 'PROXY', ipxeBuildTarget: null }));
    useServingQuery.mockReturnValue(mockSuccess({ nextServer: '10.0.0.1', dnsServers: [] }));
    useReservationsQuery.mockReturnValue(mockSuccess([]));
    useLeasesQuery.mockReturnValue(mockIdle());

    render(<PrefixDhcpSummaryCard prefixId="p1" />);
    expect(screen.getByText('PROXY')).toBeInTheDocument();
    expect(screen.queryByText('Active leases')).not.toBeInTheDocument();
  });

  it('renders AUTHORITATIVE card with lease count', () => {
    useConfigQuery.mockReturnValue(
      mockSuccess({ dhcpMode: 'AUTHORITATIVE', dhcpLeaseTtlSeconds: 300, ipxeBuildTarget: null }),
    );
    useServingQuery.mockReturnValue(mockSuccess({ nextServer: '10.0.0.1', dnsServers: ['8.8.8.8'] }));
    useReservationsQuery.mockReturnValue(mockSuccess([{ mac: 'aa:bb:cc:dd:ee:ff' }]));
    useLeasesQuery.mockReturnValue(mockSuccess([{ ip: '10.0.0.2' }, { ip: '10.0.0.3' }]));

    render(<PrefixDhcpSummaryCard prefixId="p1" />);
    expect(screen.getByText('AUTHORITATIVE')).toBeInTheDocument();
    expect(screen.getByText('300s')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows partial error when supplementary queries fail', () => {
    useConfigQuery.mockReturnValue(mockSuccess({ dhcpMode: 'AUTHORITATIVE' }));
    useServingQuery.mockReturnValue(mockError());
    useReservationsQuery.mockReturnValue(mockSuccess([]));
    useLeasesQuery.mockReturnValue(mockSuccess([]));

    render(<PrefixDhcpSummaryCard prefixId="p1" />);
    expect(screen.getByText('Failed to load DHCP details.')).toBeInTheDocument();
  });
});
