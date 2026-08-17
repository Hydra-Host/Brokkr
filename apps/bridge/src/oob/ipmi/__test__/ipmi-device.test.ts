import { describe, expect, it } from 'vitest';

import { createIpmiDevice, withCipher } from '../device.js';

describe('createIpmiDevice', () => {
  it('applies default port, cipher, and jobId', () => {
    const d = createIpmiDevice({ ip: '10.0.0.1', username: 'admin', password: 'secret' });
    expect(d.port).toBe(623);
    expect(d.cipher).toBeNull();
    expect(d.jobId).toBe('');
  });

  it('preserves explicit construction values', () => {
    const d = createIpmiDevice({
      ip: '10.0.0.1',
      username: 'u',
      password: 'p',
      port: 624,
      cipher: '3',
      jobId: 'job-42',
    });
    expect(d.port).toBe(624);
    expect(d.cipher).toBe('3');
    expect(d.jobId).toBe('job-42');
  });
});

describe('withCipher', () => {
  it('returns a new device with the cipher set, leaving the original untouched', () => {
    const d = createIpmiDevice({ ip: '10.0.0.1', username: 'u', password: 'p' });
    const d2 = withCipher(d, '17');
    expect(d).not.toBe(d2);
    expect(d.cipher).toBeNull();
    expect(d2.cipher).toBe('17');
    expect(d2.ip).toBe(d.ip);
  });

  it('clears the cipher when passed null', () => {
    const d = createIpmiDevice({ ip: '10.0.0.1', username: 'u', password: 'p', cipher: '3' });
    const d2 = withCipher(d, null);
    expect(d2.cipher).toBeNull();
  });
});
