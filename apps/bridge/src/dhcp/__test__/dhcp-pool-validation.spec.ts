import { describe, expect, it } from 'vitest';

import { type DhcpPoolCandidate, validateDhcpPoolConsistency } from '../dhcp-pool-validation.js';

function pool(overrides: Partial<DhcpPoolCandidate> = {}): DhcpPoolCandidate {
  return {
    rangeStart: '10.0.0.10',
    rangeEnd: '10.0.0.20',
    subnetMask: '255.255.255.0',
    serverId: '10.0.0.1',
    reservations: [],
    routers: ['10.0.0.1'],
    ...overrides,
  };
}

describe('validateDhcpPoolConsistency', () => {
  it('accepts a coherent range + gateway pool', () => {
    expect(() => validateDhcpPoolConsistency(pool())).not.toThrow();
  });

  it('accepts a reservations-only pool (no dynamic range)', () => {
    expect(() =>
      validateDhcpPoolConsistency(
        pool({ rangeStart: '', rangeEnd: '', reservations: [{ mac: 'aa:bb:cc:dd:ee:ff', ip: '10.0.0.5' }] }),
      ),
    ).not.toThrow();
  });

  it('rejects an inverted range', () => {
    expect(() => validateDhcpPoolConsistency(pool({ rangeStart: '10.0.0.20', rangeEnd: '10.0.0.10' }))).toThrow(
      /below range start/,
    );
  });

  it('rejects a half-specified range (start without end)', () => {
    expect(() => validateDhcpPoolConsistency(pool({ rangeStart: '10.0.0.10', rangeEnd: '' }))).toThrow(
      /both a start and an end/,
    );
  });

  it('rejects an empty pool (no range and no reservations)', () => {
    expect(() => validateDhcpPoolConsistency(pool({ rangeStart: '', rangeEnd: '', reservations: [] }))).toThrow(
      /nothing to serve/,
    );
  });

  it('rejects a reservation outside the subnet', () => {
    expect(() =>
      validateDhcpPoolConsistency(pool({ reservations: [{ mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.1.5' }] })),
    ).toThrow(/outside the subnet/);
  });

  it('rejects a gateway outside the subnet', () => {
    expect(() => validateDhcpPoolConsistency(pool({ routers: ['192.168.99.1'] }))).toThrow(
      /gateway .* outside the subnet/,
    );
  });

  it('B5: accepts the 0.0.0.0 "no gateway" sentinel router', () => {
    expect(() => validateDhcpPoolConsistency(pool({ routers: ['0.0.0.0'] }))).not.toThrow();
  });

  it('accepts a reservation that overlaps the dynamic range (allocator carves it out)', () => {
    expect(() =>
      validateDhcpPoolConsistency(pool({ reservations: [{ mac: 'aa:bb:cc:dd:ee:ff', ip: '10.0.0.15' }] })),
    ).not.toThrow();
  });

  it('accepts a reservation in-subnet but outside the dynamic range', () => {
    expect(() =>
      validateDhcpPoolConsistency(pool({ reservations: [{ mac: 'aa:bb:cc:dd:ee:ff', ip: '10.0.0.5' }] })),
    ).not.toThrow();
  });

  it('rejects a range whose subnet differs from the serverId subnet', () => {
    expect(() =>
      validateDhcpPoolConsistency(
        pool({ serverId: '10.0.0.1', routers: [], rangeStart: '192.168.1.10', rangeEnd: '192.168.1.99' }),
      ),
    ).toThrow(/range .* outside the subnet of server/);
  });

  it('accepts a range fully inside the serverId subnet', () => {
    expect(() =>
      validateDhcpPoolConsistency(pool({ serverId: '10.0.0.1', rangeStart: '10.0.0.10', rangeEnd: '10.0.0.99' })),
    ).not.toThrow();
  });

  it('skips subnet-containment checks when serverId is empty (resolved at bind)', () => {
    expect(() =>
      validateDhcpPoolConsistency(
        pool({
          serverId: '',
          routers: ['192.168.99.1'],
          reservations: [{ mac: 'aa:bb:cc:dd:ee:ff', ip: '172.16.0.5' }],
        }),
      ),
    ).not.toThrow();
  });
});
