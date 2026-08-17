import { describe, expect, it } from 'vitest';

import {
  CreateReservationInviteRequestSchema,
  EditReservationInviteRequestSchema,
  ServerFilterOptionsQuerySchema,
  ServerSchema,
  ServersQuerySchema,
} from '../baremetal';

const VALID_CREATE = {
  inviterEmail: 'admin@example.com',
  inviteeEmail: 'buyer@example.com',
  organizationId: 'org-1',
  price: 100,
  billingFrequency: 'MONTHLY',
  dateExpires: new Date(),
  deviceIds: ['dev-1'],
};

const VALID_EDIT = {
  price: 100,
  billingFrequency: 'MONTHLY',
  dateExpires: new Date(),
  deviceIds: ['dev-1'],
};

describe('CreateReservationInviteRequestSchema', () => {
  it('accepts a valid invite', () => {
    expect(CreateReservationInviteRequestSchema.safeParse(VALID_CREATE).success).toBe(true);
  });

  it.each(['inviterEmail', 'inviteeEmail'])('rejects an invalid %s', (field) => {
    expect(CreateReservationInviteRequestSchema.safeParse({ ...VALID_CREATE, [field]: 'not-an-email' }).success).toBe(
      false,
    );
  });

  it('rejects a negative price', () => {
    expect(CreateReservationInviteRequestSchema.safeParse({ ...VALID_CREATE, price: -1 }).success).toBe(false);
  });
});

describe('EditReservationInviteRequestSchema', () => {
  it('accepts a valid edit', () => {
    expect(EditReservationInviteRequestSchema.safeParse(VALID_EDIT).success).toBe(true);
  });

  it('rejects a negative price', () => {
    expect(EditReservationInviteRequestSchema.safeParse({ ...VALID_EDIT, price: -5 }).success).toBe(false);
  });
});

describe('ServersQuerySchema decommissioned flag', () => {
  it.each([
    ['false', false],
    ['0', false],
    ['true', true],
    ['1', true],
  ])('parses decommissioned=%s to %s', (input, expected) => {
    const result = ServersQuerySchema.safeParse({ decommissioned: input });
    expect(result.success).toBe(true);
    expect(result.success && result.data.decommissioned).toBe(expected);
  });

  it('leaves decommissioned undefined when omitted', () => {
    const result = ServersQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.success && result.data.decommissioned).toBeUndefined();
  });

  it('rejects an empty-string decommissioned value', () => {
    expect(ServersQuerySchema.safeParse({ decommissioned: '' }).success).toBe(false);
  });
});

describe('ServersQuerySchema status enum', () => {
  it('rejects a non-enum status (would otherwise reach the raw Prisma cast → 500)', () => {
    expect(ServersQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false);
  });

  it('accepts a valid status case-insensitively', () => {
    const result = ServersQuerySchema.safeParse({ status: 'active' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.status).toBe('ACTIVE');
  });
});

describe('ServerFilterOptionsQuerySchema role enum', () => {
  it('rejects a non-enum role (would otherwise reach ::"DeviceRole" cast → 500)', () => {
    expect(ServerFilterOptionsQuerySchema.safeParse({ role: 'BOGUS' }).success).toBe(false);
  });

  it('accepts a valid role case-insensitively', () => {
    const result = ServerFilterOptionsQuerySchema.safeParse({ role: 'baremetal' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.role).toBe('Baremetal');
  });
});

const VALID_SERVER = {
  id: 'dev-1',
  name: 'srv-1',
  role: 'Baremetal',
  zoneName: 'zone-1',
  status: { value: 'active', label: 'Active' },
  powerStatus: { value: 'on', label: 'On' },
  customer: {},
  dcim: {},
  listing: {
    onDemandPrice: { perMonth: {}, perWeek: {}, perHour: {} },
    interruptiblePrice: { perMonth: {}, perWeek: {}, perHour: {} },
  },
  networking: {},
  interfaces: [],
  specs: { cpu: {}, gpu: {}, memory: {}, storage: {} },
  tenant: { name: 'Acme', slug: 'acme', id: 'org-1' },
  availableBaseLayers: [],
  availableComponentLayersByBase: {},
  storageLayouts: { configs: [], default: {} },
  defaultDiskLayouts: [],
  isHealthy: null,
  deletedAt: null,
};

describe('ServerSchema', () => {
  it('accepts a well-formed server with an empty interfaces array', () => {
    expect(ServerSchema.safeParse(VALID_SERVER).success).toBe(true);
  });

  it('accepts a server carrying a populated interface', () => {
    const withIface = {
      ...VALID_SERVER,
      interfaces: [
        {
          name: 'eth0',
          mac_address: '00:11:22:33:44:55',
          mark_connected: true,
          enabled: true,
          mgmt_only: false,
          ip_addresses: [],
        },
      ],
    };
    expect(ServerSchema.safeParse(withIface).success).toBe(true);
  });

  it.each(['interfaces', 'tenant', 'status', 'specs', 'listing'] as const)('rejects a server missing %s', (field) => {
    const { [field]: _omitted, ...rest } = VALID_SERVER;
    expect(ServerSchema.safeParse(rest).success).toBe(false);
  });
});
