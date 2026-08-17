import { describe, expect, it } from 'vitest';
import { loadRedisConfig } from '../redis.config';
import { sanitizeRedisUrl } from '../url-sanitize';

describe('zone ACL password survives the REDIS_URL round-trip', () => {
  const passwords = [
    '+T5mabcXYZ0123456789defg',
    '!#$&*+-=?_~AbCdEf01234567',
    'a/b?c#d@e%f:gHIJKL01234567',
    'PlainAlnum0123456789abcdEF',
  ];

  for (const password of passwords) {
    it(`recovers ${JSON.stringify(password)} verbatim`, () => {
      const username = 'brokkr-spoke-00000000-0000-0000-0000-111111111111';
      const dialogUrl = `redis://${username}:${password}@redis.example.com:6379`;

      const config = loadRedisConfig({ REDIS_URL: dialogUrl, BRIDGE_AT_REST_KEY: 'x'.repeat(44) });

      expect(config.username).toBe(username);
      expect(config.password).toBe(password);
    });
  }

  it('double-encoding (the old dialog bug) does NOT round-trip — proving raw is required', () => {
    expect(sanitizeRedisUrl('redis://u:+@h:6379')).toBe('redis://u:%2B@h:6379');

    const preEncoded = `redis://u:${encodeURIComponent('+')}@h:6379`;
    expect(loadRedisConfig({ REDIS_URL: preEncoded, BRIDGE_AT_REST_KEY: 'x'.repeat(44) }).password).toBe('%2B');

    expect(loadRedisConfig({ REDIS_URL: 'redis://u:+@h:6379', BRIDGE_AT_REST_KEY: 'x'.repeat(44) }).password).toBe('+');
  });
});
