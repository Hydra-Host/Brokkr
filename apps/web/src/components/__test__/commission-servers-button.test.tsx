import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ZoneListItem } from '@repo/api-client';

const can = vi.fn();

vi.mock('~/hooks/use-permissions', () => ({
  usePermissions: () => ({ can, isLoading: false, permissions: new Set<string>() }),
}));

const navigateSpy = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateSpy,
}));

const getZonesQuery = vi.fn();

vi.mock('~/lib/api', () => ({
  tsr: {
    getZones: {
      query: (...args: unknown[]) => getZonesQuery(...args),
    },
  },
}));

const toastError = vi.fn();
const toastInfo = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    info: (...args: unknown[]) => toastInfo(...args),
  },
}));

import { CommissionServersButton, formatZoneLocation } from '../commission-servers-button';

function mkZone(overrides: Partial<ZoneListItem> = {}): ZoneListItem {
  return {
    id: 'zone-1',
    name: 'Zone One',
    organizationId: 'org-1',
    primaryAddress: null,
    contactCount: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function zonesResponse(zones: ZoneListItem[]) {
  return {
    status: 200,
    body: {
      data: zones,
      meta: { page: 1, pageSize: 100, totalItems: zones.length, totalPages: 1 },
    },
  };
}

describe('formatZoneLocation', () => {
  it('joins city, state, and country, skipping blanks', () => {
    const zone = mkZone({
      primaryAddress: {
        id: 'addr-1',
        formattedAddress: '1 Main St, Dallas, TX, US',
        addressLineOne: '1 Main St',
        addressLineTwo: null,
        city: 'Dallas',
        stateOrProvince: 'TX',
        postalCode: null,
        country: null,
        countryCode: 'US',
        latitude: null,
        longitude: null,
        timezone: 'America/Chicago',
      },
    });
    expect(formatZoneLocation(zone)).toBe('Dallas, TX, US');
  });

  it('returns empty string when there is no primary address', () => {
    expect(formatZoneLocation(mkZone({ primaryAddress: null }))).toBe('');
  });
});

describe('CommissionServersButton', () => {
  beforeEach(() => {
    can.mockReset();
    navigateSpy.mockReset();
    getZonesQuery.mockReset();
    toastError.mockReset();
    toastInfo.mockReset();
  });

  it('renders nothing without device:create', () => {
    can.mockReturnValue(false);
    const { container } = render(<CommissionServersButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it('navigates straight to the commission route when exactly one zone exists', async () => {
    can.mockReturnValue(true);
    getZonesQuery.mockResolvedValue(zonesResponse([mkZone({ id: 'zone-a' })]));
    render(<CommissionServersButton />);

    fireEvent.click(screen.getByRole('button', { name: /commission servers/i }));

    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith({
        to: '/dcim/zones/$zoneId/commission',
        params: { zoneId: 'zone-a' },
      }),
    );
    expect(getZonesQuery).toHaveBeenCalledWith({ query: { pageSize: 100 } });
    expect(screen.queryByText('Select a zone')).not.toBeInTheDocument();
  });

  it('points to zone creation when no zones exist', async () => {
    can.mockReturnValue(true);
    getZonesQuery.mockResolvedValue(zonesResponse([]));
    render(<CommissionServersButton />);

    fireEvent.click(screen.getByRole('button', { name: /commission servers/i }));

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: '/dcim/zones/create' }));
    expect(toastInfo).toHaveBeenCalled();
  });

  it('opens the zone picker when multiple zones exist and navigates on choose', async () => {
    can.mockReturnValue(true);
    getZonesQuery.mockResolvedValue(
      zonesResponse([mkZone({ id: 'zone-a', name: 'Alpha' }), mkZone({ id: 'zone-b', name: 'Beta' })]),
    );
    render(<CommissionServersButton />);

    fireEvent.click(screen.getByRole('button', { name: /commission servers/i }));

    await waitFor(() => expect(screen.getByText('Select a zone')).toBeInTheDocument());
    expect(navigateSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /beta/i }));

    expect(navigateSpy).toHaveBeenCalledWith({
      to: '/dcim/zones/$zoneId/commission',
      params: { zoneId: 'zone-b' },
    });
    await waitFor(() => expect(screen.queryByText('Select a zone')).not.toBeInTheDocument());
  });

  it('surfaces an error toast and does not navigate on a non-200 response', async () => {
    can.mockReturnValue(true);
    getZonesQuery.mockResolvedValue({ status: 500, body: { message: 'boom' } });
    render(<CommissionServersButton />);

    fireEvent.click(screen.getByRole('button', { name: /commission servers/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('surfaces an error toast and does not navigate when the request throws', async () => {
    can.mockReturnValue(true);
    getZonesQuery.mockRejectedValue(new Error('network down'));
    render(<CommissionServersButton />);

    fireEvent.click(screen.getByRole('button', { name: /commission servers/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});
