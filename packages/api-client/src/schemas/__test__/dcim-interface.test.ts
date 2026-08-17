import { describe, expect, it } from 'vitest';
import {
  BulkCreateDcimInterfaceSchema,
  BulkUpdateDcimInterfaceSchema,
  BulkUpdateDeviceInterfacesRequestSchema,
  CreateDcimInterfaceRequestSchema,
  DcimInterfaceIpSchema,
  DcimInterfaceSchema,
  DeviceInterfaceWithIpsSchema,
  INTERFACE_NAME_REGEX,
  MAC_ADDRESS_REGEX,
  MAX_BULK_INTERFACE_OPS,
} from '../dcim';

const UUID = '11111111-1111-4111-8111-111111111111';

const baseInterface = {
  id: UUID,
  name: 'eth0',
  type: null,
  enabled: true,
  mtu: null,
  macAddress: null,
  speed: null,
  mgmtOnly: false,
  markConnected: false,
  mode: null,
  description: null,
  linkType: null,
  guid: null,
  portState: null,
  maxSpeedGbps: null,
  pciDeviceId: null,
  lldpNeighborName: null,
  lldpNeighborPort: null,
  lldpNeighborDescr: null,
  lldpNeighborMgmtIp: null,
  deviceId: UUID,
  lagId: null,
  parentId: null,
  untaggedVlanId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const uuidAt = (i: number) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;

describe('BulkUpdateDeviceInterfacesRequestSchema', () => {
  it('accepts a minimal empty request', () => {
    const result = BulkUpdateDeviceInterfacesRequestSchema.safeParse({
      creates: [],
      updates: [],
      deletes: [],
    });
    expect(result.success).toBe(true);
  });

  it('defaults omitted arrays to [] (a delete-only request needs only deletes)', () => {
    const result = BulkUpdateDeviceInterfacesRequestSchema.safeParse({ deletes: [UUID] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.creates).toEqual([]);
      expect(result.data.updates).toEqual([]);
      expect(result.data.deletes).toEqual([UUID]);
    }
  });

  it('accepts a fully empty object (all three arrays default to [])', () => {
    const result = BulkUpdateDeviceInterfacesRequestSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it(`accepts a deletes array with exactly ${MAX_BULK_INTERFACE_OPS} items (on-boundary)`, () => {
    const result = BulkUpdateDeviceInterfacesRequestSchema.safeParse({
      creates: [],
      updates: [],
      deletes: Array.from({ length: MAX_BULK_INTERFACE_OPS }, (_, i) => uuidAt(i)),
    });
    expect(result.success).toBe(true);
  });

  it(`rejects a deletes array with ${MAX_BULK_INTERFACE_OPS + 1} items (over-boundary)`, () => {
    const result = BulkUpdateDeviceInterfacesRequestSchema.safeParse({
      creates: [],
      updates: [],
      deletes: Array.from({ length: MAX_BULK_INTERFACE_OPS + 1 }, (_, i) => uuidAt(i)),
    });
    expect(result.success).toBe(false);
  });

  it(`accepts exactly ${MAX_BULK_INTERFACE_OPS} creates and rejects ${MAX_BULK_INTERFACE_OPS + 1}`, () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `e${i}` }));
    expect(
      BulkUpdateDeviceInterfacesRequestSchema.safeParse({
        creates: make(MAX_BULK_INTERFACE_OPS),
        updates: [],
        deletes: [],
      }).success,
    ).toBe(true);
    expect(
      BulkUpdateDeviceInterfacesRequestSchema.safeParse({
        creates: make(MAX_BULK_INTERFACE_OPS + 1),
        updates: [],
        deletes: [],
      }).success,
    ).toBe(false);
  });

  it(`accepts exactly ${MAX_BULK_INTERFACE_OPS} updates and rejects ${MAX_BULK_INTERFACE_OPS + 1}`, () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => ({ id: uuidAt(i) }));
    expect(
      BulkUpdateDeviceInterfacesRequestSchema.safeParse({
        creates: [],
        updates: make(MAX_BULK_INTERFACE_OPS),
        deletes: [],
      }).success,
    ).toBe(true);
    expect(
      BulkUpdateDeviceInterfacesRequestSchema.safeParse({
        creates: [],
        updates: make(MAX_BULK_INTERFACE_OPS + 1),
        deletes: [],
      }).success,
    ).toBe(false);
  });

  it('rejects when the three arrays COMBINED exceed the cap (total-ops guard)', () => {
    const result = BulkUpdateDeviceInterfacesRequestSchema.safeParse({
      creates: [{ name: 'eth0' }],
      updates: [],
      deletes: Array.from({ length: MAX_BULK_INTERFACE_OPS }, (_, i) => uuidAt(i)),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a UUID that appears in both updates and deletes (server rejects it too)', () => {
    const result = BulkUpdateDeviceInterfacesRequestSchema.safeParse({
      updates: [{ id: UUID }],
      deletes: [UUID],
    });
    expect(result.success).toBe(false);
  });

  it('accepts distinct UUIDs across updates and deletes', () => {
    const result = BulkUpdateDeviceInterfacesRequestSchema.safeParse({
      updates: [{ id: UUID }],
      deletes: [uuidAt(1)],
    });
    expect(result.success).toBe(true);
  });

  it('rejects the same UUID appearing twice in updates (server dedups → mid-tx collision)', () => {
    const result = BulkUpdateDeviceInterfacesRequestSchema.safeParse({
      updates: [
        { id: UUID, name: 'eth0' },
        { id: UUID, name: 'eth1' },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('BulkUpdateDcimInterfaceSchema', () => {
  it('rejects a non-UUID id', () => {
    const result = BulkUpdateDcimInterfaceSchema.safeParse({ id: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('accepts a valid UUID id (all other fields are optional)', () => {
    const result = BulkUpdateDcimInterfaceSchema.safeParse({ id: UUID });
    expect(result.success).toBe(true);
  });

  it('accepts a null macAddress (the explicit clear-MAC update path)', () => {
    expect(BulkUpdateDcimInterfaceSchema.safeParse({ id: UUID, macAddress: null }).success).toBe(true);
  });

  it('rejects an invalid macAddress string in a bulk update', () => {
    expect(BulkUpdateDcimInterfaceSchema.safeParse({ id: UUID, macAddress: 'not-a-mac' }).success).toBe(false);
  });
});

describe('BulkCreateDcimInterfaceSchema', () => {
  it('accepts a payload with a valid name and no deviceId', () => {
    const result = BulkCreateDcimInterfaceSchema.safeParse({ name: 'eth0' });
    expect(result.success).toBe(true);
  });

  it('rejects a payload missing name (name is required)', () => {
    const result = BulkCreateDcimInterfaceSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('DcimInterfaceIpSchema', () => {
  const validIp = { id: UUID, address: '10.0.0.5/24', status: 'ACTIVE' };

  it('accepts a valid IP (uuid id, address, status)', () => {
    expect(DcimInterfaceIpSchema.safeParse(validIp).success).toBe(true);
  });

  it('rejects a non-UUID id', () => {
    expect(DcimInterfaceIpSchema.safeParse({ ...validIp, id: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects an invalid status', () => {
    expect(DcimInterfaceIpSchema.safeParse({ ...validIp, status: 'BOGUS' }).success).toBe(false);
  });
});

describe('DeviceInterfaceWithIpsSchema', () => {
  it('accepts an interface with an empty ipAddresses array', () => {
    expect(DeviceInterfaceWithIpsSchema.safeParse({ ...baseInterface, ipAddresses: [] }).success).toBe(true);
  });

  it('accepts an interface with a populated ipAddresses entry', () => {
    const obj = { ...baseInterface, ipAddresses: [{ id: UUID, address: '10.0.0.5/24', status: 'ACTIVE' }] };
    expect(DeviceInterfaceWithIpsSchema.safeParse(obj).success).toBe(true);
  });

  it('rejects an interface that omits ipAddresses (tightened to required)', () => {
    expect(DeviceInterfaceWithIpsSchema.safeParse(baseInterface).success).toBe(false);
  });

  it('rejects an ipAddresses entry with an invalid status', () => {
    const obj = { ...baseInterface, ipAddresses: [{ id: UUID, address: '10.0.0.5/24', status: 'BOGUS' }] };
    expect(DeviceInterfaceWithIpsSchema.safeParse(obj).success).toBe(false);
  });
});

describe('macAddress validation (via CreateDcimInterfaceRequestSchema)', () => {
  const validBody = { name: 'eth0', deviceId: UUID };

  it('accepts a valid colon-separated MAC', () => {
    expect(CreateDcimInterfaceRequestSchema.safeParse({ ...validBody, macAddress: '00:11:22:33:44:55' }).success).toBe(
      true,
    );
  });

  it('accepts a valid hyphen-separated MAC', () => {
    expect(CreateDcimInterfaceRequestSchema.safeParse({ ...validBody, macAddress: '00-11-22-33-44-55' }).success).toBe(
      true,
    );
  });

  it('accepts an uppercase MAC (case-insensitive `i` flag)', () => {
    expect(CreateDcimInterfaceRequestSchema.safeParse({ ...validBody, macAddress: '00:11:22:33:44:FF' }).success).toBe(
      true,
    );
  });

  it('accepts an empty string (intentional "no MAC" passthrough)', () => {
    expect(CreateDcimInterfaceRequestSchema.safeParse({ ...validBody, macAddress: '' }).success).toBe(true);
  });

  it('rejects a mixed-separator MAC', () => {
    expect(CreateDcimInterfaceRequestSchema.safeParse({ ...validBody, macAddress: '00:11-22:33-44:55' }).success).toBe(
      false,
    );
  });

  it('rejects a MAC with non-hex characters', () => {
    expect(CreateDcimInterfaceRequestSchema.safeParse({ ...validBody, macAddress: '00:11:22:33:44:GG' }).success).toBe(
      false,
    );
  });

  it('rejects a MAC with too few octets', () => {
    expect(CreateDcimInterfaceRequestSchema.safeParse({ ...validBody, macAddress: '00:11:22:33:44' }).success).toBe(
      false,
    );
  });
});

describe('interface name validation (via BulkCreateDcimInterfaceSchema)', () => {
  it('accepts a single-character name', () => {
    expect(BulkCreateDcimInterfaceSchema.safeParse({ name: 'a' }).success).toBe(true);
  });

  it('accepts a 15-character name (on-boundary)', () => {
    expect(BulkCreateDcimInterfaceSchema.safeParse({ name: 'a'.repeat(15) }).success).toBe(true);
  });

  it('rejects a 16-character name (over-boundary)', () => {
    expect(BulkCreateDcimInterfaceSchema.safeParse({ name: 'a'.repeat(16) }).success).toBe(false);
  });

  it('rejects a name with a leading dot', () => {
    expect(BulkCreateDcimInterfaceSchema.safeParse({ name: '.eth0' }).success).toBe(false);
  });

  it('rejects a name with a space', () => {
    expect(BulkCreateDcimInterfaceSchema.safeParse({ name: 'eth 0' }).success).toBe(false);
  });

  it('accepts a digit-leading name', () => {
    expect(BulkCreateDcimInterfaceSchema.safeParse({ name: '0eth0' }).success).toBe(true);
  });

  it('accepts an uppercase name (the regex is not case-restricted)', () => {
    expect(BulkCreateDcimInterfaceSchema.safeParse({ name: 'Eth0' }).success).toBe(true);
  });

  it('accepts allowed special characters (. _ @ : -) in positions 2–15', () => {
    for (const name of ['eth.100', 'eth_0', 'eth@0', 'eth:0', 'eth-0']) {
      expect(BulkCreateDcimInterfaceSchema.safeParse({ name }).success).toBe(true);
    }
  });

  it('rejects a name with a disallowed special character', () => {
    expect(BulkCreateDcimInterfaceSchema.safeParse({ name: 'eth!0' }).success).toBe(false);
  });
});

describe('MAC_ADDRESS_REGEX (bare export)', () => {
  it('rejects the empty string', () => {
    expect(MAC_ADDRESS_REGEX.test('')).toBe(false);
  });

  it('accepts a well-formed colon-separated MAC', () => {
    expect(MAC_ADDRESS_REGEX.test('00:11:22:33:44:55')).toBe(true);
  });

  it('accepts a well-formed hyphen-separated MAC', () => {
    expect(MAC_ADDRESS_REGEX.test('00-11-22-33-44-55')).toBe(true);
  });

  it('accepts an uppercase MAC (the `i` flag is effective)', () => {
    expect(MAC_ADDRESS_REGEX.test('AA:BB:CC:DD:EE:FF')).toBe(true);
  });
});

describe('INTERFACE_NAME_REGEX (bare export)', () => {
  it('rejects the empty string', () => {
    expect(INTERFACE_NAME_REGEX.test('')).toBe(false);
  });

  it('rejects a dot-leading name', () => {
    expect(INTERFACE_NAME_REGEX.test('.eth0')).toBe(false);
  });

  it('rejects a hyphen-leading name', () => {
    expect(INTERFACE_NAME_REGEX.test('-eth0')).toBe(false);
  });

  it('rejects a name with a shell-injection character (;)', () => {
    expect(INTERFACE_NAME_REGEX.test('eth0;id')).toBe(false);
  });

  it('accepts a single lowercase letter', () => {
    expect(INTERFACE_NAME_REGEX.test('a')).toBe(true);
  });

  it('accepts an uppercase letter', () => {
    expect(INTERFACE_NAME_REGEX.test('Eth0')).toBe(true);
  });
});

describe('DcimInterfaceSchema', () => {
  it('accepts a complete interface', () => {
    expect(DcimInterfaceSchema.safeParse(baseInterface).success).toBe(true);
  });

  it('rejects an interface missing markConnected (required, not optional)', () => {
    const { markConnected: _markConnected, ...withoutMarkConnected } = baseInterface;
    expect(DcimInterfaceSchema.safeParse(withoutMarkConnected).success).toBe(false);
  });
});
