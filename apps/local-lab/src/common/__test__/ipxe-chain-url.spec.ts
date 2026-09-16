import { describe, expect, it } from 'vitest';

import { PORTS } from '../../ports';
import { ipxeChainBaseUrl } from '../ipxe-chain-url';

describe('ipxeChainBaseUrl', () => {
  it('names the uplink ip on the spoke base port', () => {
    expect(ipxeChainBaseUrl({ ip: '198.51.100.14' })).toBe(`http://198.51.100.14:${PORTS.spoke.base}`);
  });
});
