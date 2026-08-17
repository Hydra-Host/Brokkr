import { describe, expect, it } from 'vitest';

import { PhoneHomeCreds } from '../deploy.js';

describe('PhoneHomeCreds.endpoint', () => {
  const token = 'tok-abc';
  const parse = (endpoint: string) => PhoneHomeCreds.safeParse({ endpoint, deployment_os_token: token }).success;

  it('accepts an https URL to any host', () => {
    expect(parse('https://hub.example/api/v1/bmc/phone-home')).toBe(true);
  });

  it('accepts http to loopback/private hosts (local dev + SIM)', () => {
    for (const endpoint of [
      'http://localhost:3000/api/v1/bmc/phone-home',
      'http://127.0.0.1:3000/phone-home',
      'http://192.168.200.1:3000/api/v1/bmc/phone-home',
      'http://10.0.0.5/phone-home',
      'http://172.16.4.2/phone-home',
    ]) {
      expect(parse(endpoint)).toBe(true);
    }
  });

  it('rejects plain-http to a public host (token exfiltration / SSRF)', () => {
    expect(parse('http://attacker.example/phone-home')).toBe(false);
    expect(parse('http://8.8.8.8/phone-home')).toBe(false);
  });

  it('rejects non-URL values and non-http(s) schemes', () => {
    for (const endpoint of ['', 'not-a-url', 'ftp://hub.example', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(parse(endpoint)).toBe(false);
    }
  });
});
