import { describe, expect, it } from 'vitest';
import { GatewaySchema } from '../gateways';

const GATEWAY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const IP_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PREFIX_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const VRF_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const baseGateway = {
  id: GATEWAY_ID,
  routingPriority: 100,
  vrfId: VRF_ID,
  gatewayIpId: IP_ID,
  prefixId: PREFIX_ID,
  gatewayIp: { id: IP_ID, address: '10.0.1.2/24' },
  prefix: { id: PREFIX_ID, prefix: '10.0.1.0/24' },
  vrf: { id: VRF_ID, name: 'vrf-blue' },
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:00:00.000Z',
};

describe('GatewaySchema', () => {
  it('accepts a gateway with resolved relation summaries', () => {
    const result = GatewaySchema.safeParse(baseGateway);
    expect(result.success).toBe(true);
  });

  it('accepts a null vrf for the global routing table', () => {
    const result = GatewaySchema.safeParse({ ...baseGateway, vrfId: null, vrf: null });
    expect(result.success).toBe(true);
  });

  it('rejects a gateway missing the prefix summary', () => {
    const { prefix: _prefix, ...withoutPrefix } = baseGateway;
    expect(GatewaySchema.safeParse(withoutPrefix).success).toBe(false);
  });

  it('rejects a gateway missing the gateway ip summary', () => {
    const { gatewayIp: _gatewayIp, ...withoutIp } = baseGateway;
    expect(GatewaySchema.safeParse(withoutIp).success).toBe(false);
  });
});
