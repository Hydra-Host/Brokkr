import { describe, expect, it } from 'vitest';

import { featuresFromEnv } from '../rendered-config.service';

describe('featuresFromEnv', () => {
  it('names the flags the environment turns on, in table order', () => {
    const env = new Map([
      ['TFTP_ENABLED', 'true'],
      ['BRIDGE_IPXE_BUILDS_STRICT', 'true'],
    ]);

    expect(featuresFromEnv(env)).toEqual(['TFTP', 'iPXE strict']);
  });

  it('names nothing for a flag set to false', () => {
    expect(featuresFromEnv(new Map([['TFTP_ENABLED', 'false']]))).toEqual([]);
  });

  it('names nothing for an unrelated environment', () => {
    expect(featuresFromEnv(new Map([['HUB_PORT', '3000']]))).toEqual([]);
  });
});
