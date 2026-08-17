import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const made: { url: string; on: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const RedisCtor = vi.fn(function (url: string) {
    const fake = { url, on: vi.fn(), disconnect: vi.fn() };
    made.push(fake);
    return fake;
  });
  return { made, RedisCtor };
});

vi.mock('ioredis', () => ({ default: h.RedisCtor }));

import { RedisConnectionsService } from '../redis-connections.service';

beforeEach(() => {
  h.made.length = 0;
  h.RedisCtor.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RedisConnectionsService.url', () => {
  it('falls both targets back to the loopback default when nothing is configured', () => {
    vi.stubEnv('DATASTORE_REDIS_URL', undefined);
    vi.stubEnv('BRIDGE_REDIS_URL', undefined);
    const connections = new RedisConnectionsService();

    expect(connections.url('view')).toBe('redis://127.0.0.1:6379');
    expect(connections.url('bridge')).toBe('redis://127.0.0.1:6379');
  });

  it('follows BRIDGE_REDIS_URL on both targets when only it is set', () => {
    vi.stubEnv('DATASTORE_REDIS_URL', undefined);
    vi.stubEnv('BRIDGE_REDIS_URL', 'redis://spoke:6380');
    const connections = new RedisConnectionsService();

    expect(connections.url('view')).toBe('redis://spoke:6380');
    expect(connections.url('bridge')).toBe('redis://spoke:6380');
  });

  it('re-points only the view when DATASTORE_REDIS_URL is set, never the bridge', () => {
    vi.stubEnv('DATASTORE_REDIS_URL', 'redis://elsewhere:6381');
    vi.stubEnv('BRIDGE_REDIS_URL', 'redis://spoke:6380');
    const connections = new RedisConnectionsService();

    expect(connections.url('view')).toBe('redis://elsewhere:6381');
    expect(connections.url('bridge')).toBe('redis://spoke:6380');
  });

  it('leaves the bridge on the loopback default when only the view is re-pointed', () => {
    vi.stubEnv('DATASTORE_REDIS_URL', 'redis://elsewhere:6381');
    vi.stubEnv('BRIDGE_REDIS_URL', undefined);
    const connections = new RedisConnectionsService();

    expect(connections.url('view')).toBe('redis://elsewhere:6381');
    expect(connections.url('bridge')).toBe('redis://127.0.0.1:6379');
  });

  it('reads an empty variable as unset on both targets, so an empty knob never yields an empty url', () => {
    vi.stubEnv('DATASTORE_REDIS_URL', '');
    vi.stubEnv('BRIDGE_REDIS_URL', '');
    const connections = new RedisConnectionsService();

    expect(connections.url('view')).toBe('redis://127.0.0.1:6379');
    expect(connections.url('bridge')).toBe('redis://127.0.0.1:6379');
  });

  it('still reaches the bridge default when only the view is configured and the bridge knob is empty', () => {
    vi.stubEnv('DATASTORE_REDIS_URL', 'redis://elsewhere:6381');
    vi.stubEnv('BRIDGE_REDIS_URL', '');
    const connections = new RedisConnectionsService();

    expect(connections.url('bridge')).toBe('redis://127.0.0.1:6379');
  });
});

describe('bridge url ownership', () => {
  it('is the only place in the app that resolves a redis url from the environment', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const roots = ['apps/local-lab/src'];
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.includes('.spec.')) continue;
        if (full.endsWith('redis-connections.service.ts')) continue;
        const text = await readFile(full, 'utf8');
        if (text.includes('BRIDGE_REDIS_URL') || text.includes('DATASTORE_REDIS_URL')) offenders.push(full);
      }
    };
    for (const root of roots) await walk(join(process.cwd(), '..', '..', root));

    expect(offenders).toEqual([]);
  });
});

describe('RedisConnectionsService.client', () => {
  it('builds one client per target, on that target url, and reuses it', () => {
    vi.stubEnv('DATASTORE_REDIS_URL', 'redis://elsewhere:6381');
    vi.stubEnv('BRIDGE_REDIS_URL', 'redis://spoke:6380');
    const connections = new RedisConnectionsService();

    const view = connections.client('view');
    const bridge = connections.client('bridge');

    expect(connections.client('view')).toBe(view);
    expect(connections.client('bridge')).toBe(bridge);
    expect(view).not.toBe(bridge);
    expect(h.made.map((fake) => fake.url)).toEqual(['redis://elsewhere:6381', 'redis://spoke:6380']);
  });

  it('registers a logging error handler rather than a silent no-op', () => {
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    new RedisConnectionsService().client('bridge');

    const registration = h.made[0].on.mock.calls.find(([event]) => event === 'error');
    expect(registration).toBeDefined();
    registration?.[1](new Error('boom'));
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('disconnects every open client on shutdown and rebuilds on the next ask', () => {
    const connections = new RedisConnectionsService();
    const view = connections.client('view');
    connections.client('bridge');

    connections.onModuleDestroy();

    expect(h.made).toHaveLength(2);
    for (const fake of h.made) expect(fake.disconnect).toHaveBeenCalledTimes(1);
    expect(connections.client('view')).not.toBe(view);
  });
});
