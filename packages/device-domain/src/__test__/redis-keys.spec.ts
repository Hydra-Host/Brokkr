import { describe, expect, it } from 'vitest';
import { deviceRedisKeys } from '../redis-keys';

const ZONE = '11111111-1111-1111-1111-111111111111';
const MAC = '3c:ec:ef:1a:2b:3c';
const DEVICE = '22222222-2222-2222-2222-222222222222';

describe('deviceRedisKeys', () => {
  it('builds the pxe decision key', () => {
    expect(deviceRedisKeys.dhcpPxeDecision(ZONE, MAC)).toBe(`${ZONE}:dhcp:pxe:${MAC}`);
  });

  it('builds the chain hit key', () => {
    expect(deviceRedisKeys.ipxeChainHit(ZONE, MAC)).toBe(`${ZONE}:ipxe:chain:${MAC}`);
  });

  it('builds the pending discovery key for one mac', () => {
    expect(deviceRedisKeys.discoveryPendingFor(ZONE, MAC)).toBe(`${ZONE}:discovery:pending:${MAC}`);
  });

  it('builds the health snapshot key', () => {
    expect(deviceRedisKeys.deviceHealthSnapshot(ZONE, DEVICE)).toBe(`${ZONE}:device-health:${DEVICE}`);
  });
});
