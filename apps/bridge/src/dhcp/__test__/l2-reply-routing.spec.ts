import { describe, expect, it } from 'vitest';

import { chooseNakRoute, chooseReplyRoute, type ReplyRoutingInput } from '../l2/reply-routing.js';

const TEST_CHADDR = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);

function input(overrides: Partial<ReplyRoutingInput> = {}): ReplyRoutingInput {
  return {
    giaddr: '0.0.0.0',
    ciaddr: '0.0.0.0',
    broadcastFlag: false,
    yiaddr: '10.0.0.100',
    afpacketAvailable: true,
    chaddr: TEST_CHADDR,
    ...overrides,
  };
}

describe('chooseReplyRoute', () => {
  it('relayed request → dgram-unicast to giaddr:67 regardless of broadcast flag', () => {
    const route = chooseReplyRoute(input({ giaddr: '10.0.0.254', broadcastFlag: true }));
    expect(route.kind).toBe('dgram-unicast');
    expect(route.target).toEqual({ address: '10.0.0.254', port: 67 });
  });

  it('giaddr 0.0.0.0 is not treated as a relay', () => {
    const route = chooseReplyRoute(input({ giaddr: '0.0.0.0' }));
    expect(route.kind).not.toBe('dgram-unicast');
  });

  it('giaddr 255.255.255.255 (leasequery) is not treated as a relay', () => {
    const route = chooseReplyRoute(input({ giaddr: '255.255.255.255', broadcastFlag: true }));
    expect(route.kind).not.toBe('dgram-unicast');
  });

  it('ciaddr set → dgram-unicast to ciaddr:68', () => {
    const route = chooseReplyRoute(input({ ciaddr: '10.0.0.77' }));
    expect(route.kind).toBe('dgram-unicast');
    expect(route.target).toEqual({ address: '10.0.0.77', port: 68 });
  });

  it('ciaddr takes precedence over broadcast flag', () => {
    const route = chooseReplyRoute(input({ ciaddr: '10.0.0.77', broadcastFlag: true }));
    expect(route.kind).toBe('dgram-unicast');
    expect(route.target.address).toBe('10.0.0.77');
  });

  it('broadcast flag set + afpacket → afpacket-broadcast', () => {
    const route = chooseReplyRoute(input({ broadcastFlag: true, afpacketAvailable: true }));
    expect(route.kind).toBe('afpacket-broadcast');
    expect(route.target.address).toBe('255.255.255.255');
    expect(route.target.port).toBe(68);
  });

  it('broadcast flag set + no afpacket → dgram-broadcast', () => {
    const route = chooseReplyRoute(input({ broadcastFlag: true, afpacketAvailable: false }));
    expect(route.kind).toBe('dgram-broadcast');
    expect(route.target.address).toBe('255.255.255.255');
  });

  it('broadcast flag clear + afpacket → afpacket-unicast to yiaddr with chaddr', () => {
    const route = chooseReplyRoute(input({ broadcastFlag: false, afpacketAvailable: true }));
    expect(route.kind).toBe('afpacket-unicast');
    expect(route.target.address).toBe('10.0.0.100');
    expect(route.target.port).toBe(68);
    if (route.kind === 'afpacket-unicast') {
      expect(route.chaddr).toBe(TEST_CHADDR);
    }
  });

  it('afpacket-unicast falls back to broadcast IP when yiaddr is 0.0.0.0', () => {
    const route = chooseReplyRoute(input({ broadcastFlag: false, yiaddr: '0.0.0.0', afpacketAvailable: true }));
    expect(route.kind).toBe('afpacket-unicast');
    if (route.kind === 'afpacket-unicast') {
      expect(route.target.address).toBe('255.255.255.255');
    }
  });

  it('broadcast flag clear + no afpacket → dgram-broadcast fallback', () => {
    const route = chooseReplyRoute(input({ broadcastFlag: false, afpacketAvailable: false }));
    expect(route.kind).toBe('dgram-broadcast');
    expect(route.target.address).toBe('255.255.255.255');
  });

  it('relay takes precedence over ciaddr', () => {
    const route = chooseReplyRoute(input({ giaddr: '10.0.0.254', ciaddr: '10.0.0.77' }));
    expect(route.kind).toBe('dgram-unicast');
    expect(route.target.address).toBe('10.0.0.254');
  });
});

describe('chooseNakRoute', () => {
  it('relayed NAK → dgram-unicast to relay', () => {
    const route = chooseNakRoute({ giaddr: '10.0.0.254', afpacketAvailable: true });
    expect(route.kind).toBe('dgram-unicast');
    expect(route.target).toEqual({ address: '10.0.0.254', port: 67 });
  });

  it('non-relayed NAK with afpacket → afpacket-broadcast', () => {
    const route = chooseNakRoute({ giaddr: '0.0.0.0', afpacketAvailable: true });
    expect(route.kind).toBe('afpacket-broadcast');
    expect(route.target.address).toBe('255.255.255.255');
  });

  it('non-relayed NAK without afpacket → dgram-broadcast', () => {
    const route = chooseNakRoute({ giaddr: '0.0.0.0', afpacketAvailable: false });
    expect(route.kind).toBe('dgram-broadcast');
  });

  it('giaddr 255.255.255.255 is not a relay (broadcasts)', () => {
    const route = chooseNakRoute({ giaddr: '255.255.255.255', afpacketAvailable: false });
    expect(route.kind).toBe('dgram-broadcast');
  });
});
