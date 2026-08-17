import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { usePrefixesQuery, useValidateMutation, useSetMutation, toastError } = vi.hoisted(() => ({
  usePrefixesQuery: vi.fn(),
  useValidateMutation: vi.fn(),
  useSetMutation: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('~/lib/api', () => ({
  tsr: {
    listPrefixes: { useQuery: usePrefixesQuery },
    validatePrefixGateway: { useMutation: useValidateMutation },
    setPrefixGateway: { useMutation: useSetMutation },
  },
}));

vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));

import { IpAddressGatewayCard } from '../ip-address-gateway-card';

function renderCard(props: { ipAddressId?: string; address?: string; vrfId?: string | null } = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <IpAddressGatewayCard
        ipAddressId={props.ipAddressId ?? 'ip1'}
        address={props.address ?? '10.0.0.5/24'}
        vrfId={props.vrfId ?? null}
      />
    </QueryClientProvider>,
  );
}

const prefixes = [
  { id: 'p-wide', prefix: '10.0.0.0/8', vrfId: null, gatewayIpId: null },
  { id: 'p-narrow', prefix: '10.0.0.0/24', vrfId: null, gatewayIpId: null },
];

describe('IpAddressGatewayCard render', () => {
  const validateMutate = vi.fn();
  const setMutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    usePrefixesQuery.mockReturnValue({ data: { status: 200, body: prefixes }, isPending: false, isError: false });
    useValidateMutation.mockReturnValue({ isPending: false, mutateAsync: validateMutate });
    useSetMutation.mockReturnValue({ isPending: false, mutateAsync: setMutate });
    validateMutate.mockResolvedValue({ status: 200, body: { valid: true, reason: null } });
    setMutate.mockResolvedValue({ status: 200, body: {} });
  });

  it('renders nothing for a non-ipv4 address', () => {
    const { container } = renderCard({ address: '2001:db8::1' });
    expect(container.firstChild).toBeNull();
  });

  it('shows a skeleton while prefixes load', () => {
    usePrefixesQuery.mockReturnValue({ data: undefined, isPending: true, isError: false });
    const { container } = renderCard();
    expect(container.querySelector('.h-40')).toBeInTheDocument();
  });

  it('shows a message when no prefix contains the address', () => {
    renderCard({ address: '172.16.0.1' });
    expect(screen.getByText('No prefix contains this address.')).toBeInTheDocument();
  });

  it('shows the most specific containing prefix', () => {
    renderCard();
    expect(screen.getByText('10.0.0.0/24')).toBeInTheDocument();
  });

  it('disables the action when the address is already the gateway', () => {
    usePrefixesQuery.mockReturnValue({
      data: {
        status: 200,
        body: [{ id: 'p-narrow', prefix: '10.0.0.0/24', vrfId: null, gatewayIpId: 'ip1' }],
      },
      isPending: false,
      isError: false,
    });
    renderCard();
    expect(screen.getByText('Already the prefix gateway')).toBeDisabled();
  });

  it('validates then sets the gateway on click', async () => {
    renderCard();
    fireEvent.click(screen.getByText('Set as prefix gateway'));
    await waitFor(() =>
      expect(setMutate).toHaveBeenCalledWith({ params: { id: 'p-narrow' }, body: { gatewayIpId: 'ip1' } }),
    );
    expect(validateMutate).toHaveBeenCalledWith({ body: { prefixId: 'p-narrow', gatewayIpId: 'ip1' } });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('blocks the set and surfaces the reason when validation fails', async () => {
    validateMutate.mockResolvedValue({ status: 200, body: { valid: false, reason: 'vrf mismatch' } });
    renderCard();
    fireEvent.click(screen.getByText('Set as prefix gateway'));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('vrf mismatch'));
    expect(setMutate).not.toHaveBeenCalled();
  });

  it('fails closed when validation returns a non-200 response', async () => {
    validateMutate.mockResolvedValue({ status: 404, body: { message: 'not found' } });
    renderCard();
    fireEvent.click(screen.getByText('Set as prefix gateway'));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to validate gateway.'));
    expect(setMutate).not.toHaveBeenCalled();
  });
});
