import { describe, expect, it } from 'vitest';

import { ipxeChainBodySchema } from '../chain.schema.js';

describe('ipxeChainBodySchema length bounds', () => {
  it('accepts normal-sized discovery facts', () => {
    const result = ipxeChainBodySchema.safeParse({
      platform: 'brokkr-discovery',
      buildarch: 'x86_64',
      mac: 'aa:bb:cc:dd:ee:ff',
      serial: 'SN-1234567890',
      manufacturer: 'Supermicro',
      system_uuid: '2efb2d6c-9b8a-4f55-9a39-307cd6e4a5f6',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an oversized serial rather than storing it verbatim', () => {
    const result = ipxeChainBodySchema.safeParse({ serial: 'x'.repeat(257) });
    expect(result.success).toBe(false);
  });

  it('rejects oversized unconstrained fields (manufacturer, ipmi_tag, system_uuid)', () => {
    expect(ipxeChainBodySchema.safeParse({ manufacturer: 'm'.repeat(257) }).success).toBe(false);
    expect(ipxeChainBodySchema.safeParse({ ipmi_tag: 't'.repeat(129) }).success).toBe(false);
    expect(ipxeChainBodySchema.safeParse({ system_uuid: 'u'.repeat(65) }).success).toBe(false);
  });

  it('rejects an oversized platform even within the allowed character set', () => {
    expect(ipxeChainBodySchema.safeParse({ platform: 'a'.repeat(65) }).success).toBe(false);
  });
});
