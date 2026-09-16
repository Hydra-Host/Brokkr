import { IpxeBuildTarget } from '@repo/database/enums';
import { describe, expect, it } from 'vitest';
import {
  CreateIpAddressRequestSchema,
  CreatePrefixRequestSchema,
  DhcpReservationSchema,
  IpAddressSchema,
  MAX_DHCP_DNS_SERVERS,
  PrefixBootReadinessFindingSchema,
  PrefixBootReadinessQuerySchema,
  PrefixBootReadinessSchema,
  PrefixDhcpServingSchema,
  PrefixSchema,
  UpdateIpAddressRequestSchema,
  UpdatePrefixRequestSchema,
  VrrpBindingSchema,
  VrrpBindingsSchema,
} from '../ipam';

const BRIDGE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BRIDGE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('VrrpBindingSchema.iface', () => {
  it('accepts a 15-char iface (Linux IFNAMSIZ-1)', () => {
    expect(VrrpBindingSchema.safeParse({ bridgeId: BRIDGE_A, iface: 'a'.repeat(15) }).success).toBe(true);
  });

  it('rejects a 16-char iface', () => {
    expect(VrrpBindingSchema.safeParse({ bridgeId: BRIDGE_A, iface: 'a'.repeat(16) }).success).toBe(false);
  });

  it('rejects an empty iface', () => {
    expect(VrrpBindingSchema.safeParse({ bridgeId: BRIDGE_A, iface: '' }).success).toBe(false);
  });
});

describe('VrrpBindingsSchema', () => {
  it('accepts distinct bridges', () => {
    const result = VrrpBindingsSchema.safeParse([
      { bridgeId: BRIDGE_A, iface: 'eth0' },
      { bridgeId: BRIDGE_B, iface: 'eth1' },
    ]);
    expect(result.success).toBe(true);
  });

  it('rejects a repeated bridgeId with a clear message', () => {
    const result = VrrpBindingsSchema.safeParse([
      { bridgeId: BRIDGE_A, iface: 'eth0' },
      { bridgeId: BRIDGE_A, iface: 'eth1' },
    ]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain('Duplicate bridge in VRRP bindings');
      expect(result.error.issues[0]?.path).toEqual([1, 'bridgeId']);
    }
  });

  it('accepts an empty binding list', () => {
    expect(VrrpBindingsSchema.safeParse([]).success).toBe(true);
  });
});

describe('IpAddress schemas — interfaceId semantics', () => {
  const UUID = '11111111-1111-4111-8111-111111111111';
  const baseIp = {
    id: UUID,
    address: '10.0.0.5/24',
    status: 'ACTIVE',
    dnsName: null,
    organizationId: UUID,
    vrfId: null,
    assignedObjectType: null,
    assignedObjectId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  it('IpAddressSchema.interfaceId is required-nullable (null or uuid parse; absent/malformed fails)', () => {
    expect(IpAddressSchema.safeParse({ ...baseIp, interfaceId: null }).success).toBe(true);
    expect(IpAddressSchema.safeParse({ ...baseIp, interfaceId: UUID }).success).toBe(true);
    expect(IpAddressSchema.safeParse(baseIp).success).toBe(false);
    expect(IpAddressSchema.safeParse({ ...baseIp, interfaceId: 'not-a-uuid' }).success).toBe(false);
  });

  it('CreateIpAddressRequestSchema.interfaceId is optional but NOT nullable', () => {
    expect(CreateIpAddressRequestSchema.safeParse({ address: '10.0.0.5' }).success).toBe(true);
    expect(CreateIpAddressRequestSchema.safeParse({ address: '10.0.0.5', interfaceId: UUID }).success).toBe(true);
    expect(CreateIpAddressRequestSchema.safeParse({ address: '10.0.0.5', interfaceId: null }).success).toBe(false);
  });

  it('UpdateIpAddressRequestSchema.interfaceId is nullable + optional (absent=no-op, null=clear, uuid=assign)', () => {
    expect(UpdateIpAddressRequestSchema.safeParse({}).success).toBe(true);
    expect(UpdateIpAddressRequestSchema.safeParse({ interfaceId: null }).success).toBe(true);
    expect(UpdateIpAddressRequestSchema.safeParse({ interfaceId: UUID }).success).toBe(true);
  });
});

describe('DhcpReservationSchema', () => {
  const UUID = '11111111-1111-4111-8111-111111111111';
  const valid = {
    mac: 'aa:bb:cc:dd:ee:01',
    ip: '10.0.1.50',
    hostname: 'gpu-1',
    ipxeBuildTarget: 'SNP',
    deviceId: UUID,
    interfaceId: UUID,
  };

  it('accepts a well-formed reservation', () => {
    expect(DhcpReservationSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a null hostname and null ipxeBuildTarget (inherit prefix/system default)', () => {
    expect(DhcpReservationSchema.safeParse({ ...valid, hostname: null, ipxeBuildTarget: null }).success).toBe(true);
  });

  it('rejects a non-colon-hex MAC', () => {
    expect(DhcpReservationSchema.safeParse({ ...valid, mac: 'NOT-A-MAC' }).success).toBe(false);
  });

  it('rejects a non-IPv4 ip', () => {
    expect(DhcpReservationSchema.safeParse({ ...valid, ip: 'nope' }).success).toBe(false);
  });

  it('rejects an invalid ipxeBuildTarget value', () => {
    expect(DhcpReservationSchema.safeParse({ ...valid, ipxeBuildTarget: 'BOGUS' }).success).toBe(false);
  });

  it('accepts every ipxeBuildTarget the canonical schema defines', () => {
    for (const ipxeBuildTarget of Object.values(IpxeBuildTarget)) {
      expect(DhcpReservationSchema.safeParse({ ...valid, ipxeBuildTarget }).success).toBe(true);
    }
  });

  it('rejects a MAC that is not exactly 6 octets', () => {
    expect(DhcpReservationSchema.safeParse({ ...valid, mac: 'aa:bb:cc:dd:ee' }).success).toBe(false);
    expect(DhcpReservationSchema.safeParse({ ...valid, mac: 'aa:bb:cc:dd:ee:ff:00' }).success).toBe(false);
  });

  it('accepts a display device-name hostname (spaces/uppercase) and degrades an over-long one to null', () => {
    expect(DhcpReservationSchema.safeParse({ ...valid, hostname: 'GPU Server 1' }).success).toBe(true);
    const over = DhcpReservationSchema.safeParse({ ...valid, hostname: 'x'.repeat(300) });
    expect(over.success && over.data.hostname).toBeNull();
  });

  it('requires deviceId and interfaceId (the link-to-manage handles)', () => {
    const { deviceId: _d, ...noDevice } = valid;
    const { interfaceId: _i, ...noIface } = valid;
    expect(DhcpReservationSchema.safeParse(noDevice).success).toBe(false);
    expect(DhcpReservationSchema.safeParse(noIface).success).toBe(false);
  });

  it('rejects a non-UUID deviceId or interfaceId', () => {
    expect(DhcpReservationSchema.safeParse({ ...valid, deviceId: 'not-a-uuid' }).success).toBe(false);
    expect(DhcpReservationSchema.safeParse({ ...valid, interfaceId: '123' }).success).toBe(false);
  });
});

describe('PrefixDhcpServingSchema', () => {
  it('accepts a VIP-derived serving (single address as nextServer + dnsServers)', () => {
    const result = PrefixDhcpServingSchema.safeParse({
      nextServer: '10.0.1.1',
      dnsServers: ['10.0.1.1'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts multiple bridge DNS servers', () => {
    const result = PrefixDhcpServingSchema.safeParse({
      nextServer: '10.0.1.10',
      dnsServers: ['10.0.1.10', '10.0.1.11'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts null nextServer with empty dnsServers (no serving address)', () => {
    const result = PrefixDhcpServingSchema.safeParse({
      nextServer: null,
      dnsServers: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-IPv4 nextServer', () => {
    expect(PrefixDhcpServingSchema.safeParse({ nextServer: 'not-an-ip', dnsServers: [] }).success).toBe(false);
  });

  it('rejects a non-IPv4 entry in dnsServers', () => {
    expect(PrefixDhcpServingSchema.safeParse({ nextServer: '10.0.1.1', dnsServers: ['10.0.1.1', 'bad'] }).success).toBe(
      false,
    );
  });

  it('rejects a missing nextServer field', () => {
    expect(PrefixDhcpServingSchema.safeParse({ dnsServers: [] }).success).toBe(false);
  });

  it('rejects a missing dnsServers field', () => {
    expect(PrefixDhcpServingSchema.safeParse({ nextServer: null }).success).toBe(false);
  });

  it('rejects an IPv4 with leading zeros (octal-ambiguous) in either field', () => {
    expect(PrefixDhcpServingSchema.safeParse({ nextServer: '010.0.0.1', dnsServers: [] }).success).toBe(false);
    expect(PrefixDhcpServingSchema.safeParse({ nextServer: null, dnsServers: ['010.0.0.1'] }).success).toBe(false);
  });

  it('accepts exactly MAX_DHCP_DNS_SERVERS dnsServers (the boundary) and rejects one more', () => {
    const gen = (n: number) => Array.from({ length: n }, (_, i) => `10.0.${Math.floor(i / 254)}.${(i % 254) + 1}`);
    expect(
      PrefixDhcpServingSchema.safeParse({ nextServer: '10.0.0.1', dnsServers: gen(MAX_DHCP_DNS_SERVERS) }).success,
    ).toBe(true);
    expect(
      PrefixDhcpServingSchema.safeParse({ nextServer: '10.0.0.1', dnsServers: gen(MAX_DHCP_DNS_SERVERS + 1) }).success,
    ).toBe(false);
  });
});

describe('PrefixBootReadinessFindingSchema', () => {
  const valid = { code: 'PXE-102', severity: 'error', message: 'dhcpMode is OFF; set it to SERVER or PROXY.' };

  it('accepts a well-formed finding', () => {
    expect(PrefixBootReadinessFindingSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts two- and three-digit registered codes', () => {
    expect(PrefixBootReadinessFindingSchema.safeParse({ ...valid, code: 'PXE-01' }).success).toBe(true);
    expect(PrefixBootReadinessFindingSchema.safeParse({ ...valid, code: 'PXE-106' }).success).toBe(true);
  });

  it('rejects a well-formed code the registry does not name', () => {
    expect(PrefixBootReadinessFindingSchema.safeParse({ ...valid, code: 'PXE-10' }).success).toBe(false);
    expect(PrefixBootReadinessFindingSchema.safeParse({ ...valid, code: 'PXE-99' }).success).toBe(false);
  });

  it('rejects one- and four-digit codes', () => {
    expect(PrefixBootReadinessFindingSchema.safeParse({ ...valid, code: 'PXE-1' }).success).toBe(false);
    expect(PrefixBootReadinessFindingSchema.safeParse({ ...valid, code: 'PXE-1000' }).success).toBe(false);
  });

  it('rejects a code outside the PXE vocabulary (other prefix, lowercase, or a bare number)', () => {
    expect(PrefixBootReadinessFindingSchema.safeParse({ ...valid, code: 'DHCP-102' }).success).toBe(false);
    expect(PrefixBootReadinessFindingSchema.safeParse({ ...valid, code: 'pxe-102' }).success).toBe(false);
    expect(PrefixBootReadinessFindingSchema.safeParse({ ...valid, code: '102' }).success).toBe(false);
  });

  it('accepts every severity the registry defines', () => {
    for (const severity of ['error', 'warn', 'info']) {
      expect(PrefixBootReadinessFindingSchema.safeParse({ ...valid, severity }).success).toBe(true);
    }
  });

  it('rejects a severity outside the registry', () => {
    expect(PrefixBootReadinessFindingSchema.safeParse({ ...valid, severity: 'fatal' }).success).toBe(false);
  });

  it('rejects an empty message', () => {
    expect(PrefixBootReadinessFindingSchema.safeParse({ ...valid, message: '' }).success).toBe(false);
  });
});

describe('PrefixBootReadinessQuerySchema', () => {
  const valid = { mac: 'aa:bb:cc:dd:ee:ff', bmcAddress: '10.0.2.15' };

  it('accepts a canonical MAC with a BMC address', () => {
    expect(PrefixBootReadinessQuerySchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a canonical MAC alone (the identity check is optional)', () => {
    expect(PrefixBootReadinessQuerySchema.safeParse({ mac: valid.mac }).success).toBe(true);
  });

  it('requires mac', () => {
    expect(PrefixBootReadinessQuerySchema.safeParse({ bmcAddress: valid.bmcAddress }).success).toBe(false);
  });

  it('rejects a non-canonical MAC (uppercase, hyphen-separated, or not 6 octets)', () => {
    expect(PrefixBootReadinessQuerySchema.safeParse({ ...valid, mac: 'AA:BB:CC:DD:EE:FF' }).success).toBe(false);
    expect(PrefixBootReadinessQuerySchema.safeParse({ ...valid, mac: 'aa-bb-cc-dd-ee-ff' }).success).toBe(false);
    expect(PrefixBootReadinessQuerySchema.safeParse({ ...valid, mac: 'aa:bb:cc:dd:ee' }).success).toBe(false);
    expect(PrefixBootReadinessQuerySchema.safeParse({ ...valid, mac: 'aa:bb:cc:dd:ee:ff:00' }).success).toBe(false);
  });

  it('rejects a bmcAddress that is not a strict IPv4 address', () => {
    expect(PrefixBootReadinessQuerySchema.safeParse({ ...valid, bmcAddress: 'not-an-ip' }).success).toBe(false);
    expect(PrefixBootReadinessQuerySchema.safeParse({ ...valid, bmcAddress: '10.0.2.256' }).success).toBe(false);
    expect(PrefixBootReadinessQuerySchema.safeParse({ ...valid, bmcAddress: '010.0.2.15' }).success).toBe(false);
    expect(PrefixBootReadinessQuerySchema.safeParse({ ...valid, bmcAddress: '::1' }).success).toBe(false);
  });
});

describe('PrefixBootReadinessSchema', () => {
  const report = {
    findings: [
      { code: 'PXE-102', severity: 'error', message: 'dhcpMode is OFF; set it to SERVER or PROXY.' },
      { code: 'PXE-104', severity: 'error', message: 'No bootfile is set; pick an iPXE build target.' },
      { code: 'PXE-106', severity: 'error', message: 'PXE MAC and BMC address belong to different devices.' },
    ],
  };

  it('parses a full report and preserves the findings as given', () => {
    const result = PrefixBootReadinessSchema.safeParse(report);

    expect(result.success && result.data).toEqual(report);
  });

  it('accepts an empty findings list (nothing in hub data blocks the boot)', () => {
    expect(PrefixBootReadinessSchema.safeParse({ findings: [] }).success).toBe(true);
  });

  it('rejects a report carrying a malformed finding', () => {
    const malformed = { findings: [{ ...report.findings[0], code: 'PXE-1' }] };

    expect(PrefixBootReadinessSchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects a missing findings field', () => {
    expect(PrefixBootReadinessSchema.safeParse({}).success).toBe(false);
  });
});

describe('Prefix schemas — netplan fields (prefixRoleId, enableVlanTag, bondParameters)', () => {
  const basePrefix = {
    id: '11111111-1111-1111-1111-111111111111',
    prefix: '10.0.0.0/24',
    status: 'ACTIVE',
    isPool: false,
    role: null,
    zoneId: null,
    organizationId: '22222222-2222-2222-2222-222222222222',
    vrfId: null,
    parentId: null,
    vlanId: null,
    gatewayIpId: null,
    vrrpVipId: null,
    prefixRoleId: null,
    enableVlanTag: false,
    bondParameters: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
  };

  it('PrefixSchema.prefixRoleId accepts null and a uuid, rejects a non-uuid', () => {
    expect(PrefixSchema.safeParse({ ...basePrefix, prefixRoleId: null }).success).toBe(true);
    expect(
      PrefixSchema.safeParse({ ...basePrefix, prefixRoleId: '33333333-3333-3333-3333-333333333333' }).success,
    ).toBe(true);
    expect(PrefixSchema.safeParse({ ...basePrefix, prefixRoleId: 'not-a-uuid' }).success).toBe(false);
  });

  it('PrefixSchema.enableVlanTag is required on the response (absent → parse failure)', () => {
    const { enableVlanTag: _omit, ...withoutFlag } = basePrefix;
    expect(PrefixSchema.safeParse(withoutFlag).success).toBe(false);
  });

  it('PrefixSchema.bondParameters accepts null and a scalar record, rejects a string and nested-object values', () => {
    expect(PrefixSchema.safeParse({ ...basePrefix, bondParameters: null }).success).toBe(true);
    expect(
      PrefixSchema.safeParse({ ...basePrefix, bondParameters: { mode: 'active-backup', 'mii-monitor-interval': 100 } })
        .success,
    ).toBe(true);
    expect(PrefixSchema.safeParse({ ...basePrefix, bondParameters: 'nope' }).success).toBe(false);
    expect(PrefixSchema.safeParse({ ...basePrefix, bondParameters: { mode: { nested: true } } }).success).toBe(false);
  });

  it('bondParameters rejects a key that could inject netplan YAML (newline / structural chars)', () => {
    expect(
      PrefixSchema.safeParse({ ...basePrefix, bondParameters: { 'mode: x\n        injected': 'y' } }).success,
    ).toBe(false);
  });

  it('CreatePrefixRequestSchema accepts omitted netplan fields (backward compat) and rejects a non-uuid prefixRoleId', () => {
    expect(CreatePrefixRequestSchema.safeParse({ prefix: '10.0.0.0/24' }).success).toBe(true);
    expect(CreatePrefixRequestSchema.safeParse({ prefix: '10.0.0.0/24', prefixRoleId: 'nope' }).success).toBe(false);
  });

  it('UpdatePrefixRequestSchema: prefixRoleId null (clear) and omitted (no-op) both parse', () => {
    expect(UpdatePrefixRequestSchema.safeParse({ prefixRoleId: null }).success).toBe(true);
    expect(UpdatePrefixRequestSchema.safeParse({}).success).toBe(true);
  });
});
