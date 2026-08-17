import { describe, expect, it } from 'vitest';
import { BmcHandler } from '../bmc.handler';

describe('BmcHandler', () => {
  const handler = new BmcHandler();

  it('is a no-op — BMC identity is written to the IPMI Interface by ipmi-interface.composer', async () => {
    expect(await handler.handle()).toEqual({});
  });

  it('rejects missing ipv4', () => {
    expect(handler.schema.safeParse({ mac: '02:00:00:00:00:02' }).success).toBe(false);
  });

  it('rejects empty mac', () => {
    expect(handler.schema.safeParse({ ipv4: '10.0.0.2/24', mac: '' }).success).toBe(false);
  });

  it('accepts ipv6=null (common in prod)', () => {
    expect(handler.schema.safeParse({ ipv4: '10.0.0.2/24', mac: '02:00:00:00:00:02', ipv6: null }).success).toBe(true);
  });
});
