import { describe, expect, it } from 'vitest';
import { PublicIpHandler } from '../public_ip.handler';

describe('PublicIpHandler', () => {
  const handler = new PublicIpHandler();

  it('returns empty mutation when ipv4 present', async () => {
    const parsed = handler.schema.parse({ ipv4: '198.51.100.42', ipv6: null, check_url: 'https://icanhazip.com' });
    const mutation = await handler.handle(parsed);
    expect(mutation).toEqual({});
  });

  it('returns empty mutation when only ipv6 present', async () => {
    const parsed = handler.schema.parse({ ipv4: null, ipv6: '2001:db8::1' });
    const mutation = await handler.handle(parsed);
    expect(mutation).toEqual({});
  });

  it('warns when both missing', async () => {
    const parsed = handler.schema.parse({ ipv4: null, ipv6: null });
    const mutation = await handler.handle(parsed);
    expect(mutation.warnings).toContain('public_ip: neither ipv4 nor ipv6 populated');
  });
});
