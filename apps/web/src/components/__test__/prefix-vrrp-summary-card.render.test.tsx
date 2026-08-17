import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useVipQuery, useBindingsQuery, useBridgesQuery } = vi.hoisted(() => ({
  useVipQuery: vi.fn(),
  useBindingsQuery: vi.fn(),
  useBridgesQuery: vi.fn(),
}));

vi.mock('~/lib/api', () => ({
  tsr: {
    getIpAddress: { useQuery: useVipQuery },
    getPrefixVrrpBindings: { useQuery: useBindingsQuery },
    getBridges: { useQuery: useBridgesQuery },
  },
}));

import { PrefixVrrpSummaryCard } from '../prefix-vrrp-summary-card';

function mockIdle() {
  return { data: undefined, isPending: true, isLoading: false, isFetching: false, isError: false };
}

function mockSuccess<T>(body: T) {
  return { data: { status: 200, body }, isPending: false, isLoading: false, isFetching: false, isError: false };
}

function mockError() {
  return { data: undefined, isPending: false, isLoading: false, isFetching: false, isError: true };
}

describe('PrefixVrrpSummaryCard render', () => {
  beforeEach(() => {
    useVipQuery.mockReset();
    useBindingsQuery.mockReset();
    useBridgesQuery.mockReset();

    useVipQuery.mockReturnValue(mockIdle());
    useBindingsQuery.mockReturnValue(mockIdle());
    useBridgesQuery.mockReturnValue(mockIdle());
  });

  it('shows zone prompt when zoneId is null', () => {
    render(<PrefixVrrpSummaryCard prefixId="p1" vrrpVipId={null} zoneId={null} />);
    expect(screen.getByText('Assign this prefix to a zone to configure VRRP.')).toBeInTheDocument();
  });

  it('shows error card on network failure', () => {
    useBindingsQuery.mockReturnValue(mockError());
    useBridgesQuery.mockReturnValue(mockSuccess({ data: [], meta: { totalPages: 1, totalItems: 0 } }));

    render(<PrefixVrrpSummaryCard prefixId="p1" vrrpVipId={null} zoneId="z1" />);
    expect(screen.getByText('Failed to load VRRP configuration.')).toBeInTheDocument();
  });

  it('shows not-configured when no VIP is assigned', () => {
    useBindingsQuery.mockReturnValue(mockSuccess([]));
    useBridgesQuery.mockReturnValue(mockSuccess({ data: [], meta: { totalPages: 1, totalItems: 0 } }));

    render(<PrefixVrrpSummaryCard prefixId="p1" vrrpVipId={null} zoneId="z1" />);
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getByText('No VRRP floating IP is assigned to this prefix.')).toBeInTheDocument();
  });

  it('renders VIP address and bridge bindings', () => {
    useVipQuery.mockReturnValue(mockSuccess({ address: '10.0.0.100/32' }));
    useBindingsQuery.mockReturnValue(mockSuccess([{ bridgeId: 'b1', iface: 'eth0' }]));
    useBridgesQuery.mockReturnValue(
      mockSuccess({ data: [{ id: 'b1', name: 'bridge-alpha' }], meta: { totalPages: 1, totalItems: 1 } }),
    );

    render(<PrefixVrrpSummaryCard prefixId="p1" vrrpVipId="vip1" zoneId="z1" />);
    expect(screen.getByText('10.0.0.100/32')).toBeInTheDocument();
    expect(screen.getByText('bridge-alpha')).toBeInTheDocument();
    expect(screen.getByText('eth0')).toBeInTheDocument();
  });

  it('shows truncation warning when bridges exceed one page', () => {
    useVipQuery.mockReturnValue(mockSuccess({ address: '10.0.0.100/32' }));
    useBindingsQuery.mockReturnValue(mockSuccess([{ bridgeId: 'b1', iface: 'eth0' }]));
    useBridgesQuery.mockReturnValue(
      mockSuccess({ data: [{ id: 'b1', name: 'bridge-alpha' }], meta: { totalPages: 2, totalItems: 150 } }),
    );

    render(<PrefixVrrpSummaryCard prefixId="p1" vrrpVipId="vip1" zoneId="z1" />);
    expect(screen.getByText(/Showing first 100 of 150 bridges/)).toBeInTheDocument();
  });
});
