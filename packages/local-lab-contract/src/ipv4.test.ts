import { describe, expect, it } from 'vitest';

import { isIpv4, NODE_IP_BASE } from './ipv4';

describe('ipv4 re-exports', () => {
  it('resolves a utils helper through the contract barrel', () => {
    expect(isIpv4('10.0.0.1')).toBe(true);
  });
});

describe('NODE_IP_BASE', () => {
  it('is 10', () => {
    expect(NODE_IP_BASE).toBe(10);
  });
});
