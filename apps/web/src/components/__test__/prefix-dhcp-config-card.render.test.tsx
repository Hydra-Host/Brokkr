import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useConfigQuery, useUpdateMutation } = vi.hoisted(() => ({
  useConfigQuery: vi.fn(),
  useUpdateMutation: vi.fn(),
}));

vi.mock('~/lib/api', () => ({
  tsr: {
    getPrefixDhcpConfig: { useQuery: useConfigQuery },
    updatePrefixDhcpConfig: { useMutation: useUpdateMutation },
  },
}));

import { PrefixDhcpConfigCard } from '../prefix-dhcp-config-card';

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PrefixDhcpConfigCard prefixId="p1" />
    </QueryClientProvider>,
  );
}

function mockPending() {
  return { data: undefined, isPending: true, isError: false };
}

function mockSuccess<T>(body: T) {
  return { data: { status: 200, body }, isPending: false, isError: false };
}

function mockError() {
  return { data: undefined, isPending: false, isError: true };
}

const config = {
  dhcpMode: 'AUTHORITATIVE',
  dhcpLeaseTtlSeconds: 600,
  ipxeBuildTarget: null,
  dhcpOptions: [],
  dhcpProxyAllowedMacs: [],
};

describe('PrefixDhcpConfigCard render', () => {
  beforeEach(() => {
    useConfigQuery.mockReset();
    useUpdateMutation.mockReset();
    useUpdateMutation.mockReturnValue({ isPending: false, mutateAsync: vi.fn() });
  });

  it('shows skeleton while config is loading', () => {
    useConfigQuery.mockReturnValue(mockPending());
    const { container } = renderCard();
    expect(container.querySelector('.h-64')).toBeInTheDocument();
  });

  it('shows the error state without the form when the config query fails', () => {
    useConfigQuery.mockReturnValue(mockError());
    renderCard();
    expect(screen.getByText('Failed to load DHCP config. Refresh to retry.')).toBeInTheDocument();
    expect(screen.queryByText('Save DHCP Config')).not.toBeInTheDocument();
  });

  it('shows the error state without the form on a non-200 response', () => {
    useConfigQuery.mockReturnValue({
      data: { status: 404, body: { message: 'not found' } },
      isPending: false,
      isError: false,
    });
    renderCard();
    expect(screen.getByText('Failed to load DHCP config. Refresh to retry.')).toBeInTheDocument();
    expect(screen.queryByText('Save DHCP Config')).not.toBeInTheDocument();
  });

  it('renders the form once config loads', () => {
    useConfigQuery.mockReturnValue(mockSuccess(config));
    renderCard();
    expect(screen.getByText('Save DHCP Config')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load DHCP config. Refresh to retry.')).not.toBeInTheDocument();
  });
});
