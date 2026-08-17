import { INTERNAL_CLIENT_IP_HEADER, IP_ADDRESS_HEADERS } from '../index';

describe('IP_ADDRESS_HEADERS', () => {
  it('keys only on the server-stamped client IP header', () => {
    expect(IP_ADDRESS_HEADERS).toEqual([INTERNAL_CLIENT_IP_HEADER]);
  });

  it('never keys on client-controllable forwarded headers', () => {
    expect(IP_ADDRESS_HEADERS).not.toContain('x-forwarded-for');
    expect(IP_ADDRESS_HEADERS).not.toContain('cf-connecting-ip');
  });
});
