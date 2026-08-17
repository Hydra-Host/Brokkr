import * as net from 'node:net';

import { describe, expect, it } from 'vitest';

import { labelRedisStream, readHandleLabel } from '../../common/redis/redis-handle-label';
import { activeResourceCount, describeActiveHandles } from '../active-handles';

describe('redis handle labels', () => {
  it('reads back a stamped label without making it enumerable', () => {
    const stream = { remoteAddress: '127.0.0.1' };

    labelRedisStream(stream, 'redis:dhcp');

    expect(readHandleLabel(stream)).toBe('redis:dhcp');
    expect(Object.keys(stream)).toEqual(['remoteAddress']);
    expect(JSON.stringify(stream)).toBe('{"remoteAddress":"127.0.0.1"}');
  });

  it('tolerates an absent stream and an unlabelled handle', () => {
    expect(() => labelRedisStream(undefined, 'redis:dhcp')).not.toThrow();
    expect(() => labelRedisStream(null, 'redis:dhcp')).not.toThrow();
    expect(readHandleLabel({})).toBeNull();
    expect(readHandleLabel(undefined)).toBeNull();
  });
});

describe('describeActiveHandles', () => {
  it('reports the public resource census', () => {
    const timer = setInterval(() => undefined, 60_000);
    try {
      const dump = describeActiveHandles();

      expect(dump).toMatch(/^resources\[\d+\]: /);
      expect(dump).toContain('Timeout=');
      expect(activeResourceCount()).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  });

  it('names a labelled socket with its peer address', async () => {
    if (process._getActiveHandles === undefined) return;

    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address');

    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    labelRedisStream(socket, 'redis:probe-test');

    try {
      const dump = describeActiveHandles();

      expect(dump).toContain('label=redis:probe-test');
      expect(dump).toContain(`remote=127.0.0.1:${address.port}`);
    } finally {
      socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
