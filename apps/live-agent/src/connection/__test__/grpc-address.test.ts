import { describe, expect, it } from 'vitest';

import { deriveGrpcAddress } from '../grpc-address';

describe('deriveGrpcAddress', () => {
  it('derives https:// when secure (default and explicit insecure=false)', () => {
    expect(deriveGrpcAddress('bridge-1:9082')).toBe('https://bridge-1:9082');
    expect(deriveGrpcAddress('bridge-1:9082', { insecure: false })).toBe('https://bridge-1:9082');
  });

  it('derives http:// (plaintext h2c) when insecure', () => {
    expect(deriveGrpcAddress('bridge-1:9082', { insecure: true })).toBe('http://bridge-1:9082');
  });

  it('returns the explicit override verbatim, regardless of the insecure flag', () => {
    expect(deriveGrpcAddress('bridge-1:9082', { override: 'http://10.0.1.2:9082' })).toBe('http://10.0.1.2:9082');
    expect(deriveGrpcAddress('bridge-1:9082', { insecure: false, override: 'http://10.0.1.2:9082' })).toBe(
      'http://10.0.1.2:9082',
    );
    expect(deriveGrpcAddress('bridge-1:443', { insecure: true, override: 'https://vip.example:443' })).toBe(
      'https://vip.example:443',
    );
  });
});
