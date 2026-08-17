import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ client: null as unknown as ScriptedRedis }));

vi.mock('ioredis', () => ({
  default: class {
    constructor() {
      return h.client;
    }
  },
}));

import { RedisConnectionsService } from '../redis-connections.service';
import { RedisService } from '../redis.service';

const makeService = (): RedisService => new RedisService(new RedisConnectionsService());

class ScriptedRedis {
  on = vi.fn();
  disconnect = vi.fn();
  ping = vi.fn();
  dbsize = vi.fn();
  info = vi.fn();
  call = vi.fn();
  scan = vi.fn();
  type = vi.fn();
  ttl = vi.fn();
  get = vi.fn();
  hlen = vi.fn();
  hscan = vi.fn();
  llen = vi.fn();
  lrange = vi.fn();
  scard = vi.fn();
  sscan = vi.fn();
  zcard = vi.fn();
  zscan = vi.fn();
  xlen = vi.fn();
  xrange = vi.fn();
}

beforeEach(() => {
  vi.restoreAllMocks();
  h.client = new ScriptedRedis();
});

describe('RedisService.value', () => {
  it('shapes a string value', async () => {
    h.client.type.mockResolvedValue('string');
    h.client.ttl.mockResolvedValue(-1);
    h.client.get.mockResolvedValue('hello');
    const result = await makeService().value('k');
    expect(result).toEqual({
      key: 'k',
      type: 'string',
      ttl: -1,
      kind: 'string',
      value: 'hello',
      truncated: false,
      length: 1,
    });
  });

  it('shapes a hash and loops the hscan cursor until it returns "0"', async () => {
    h.client.type.mockResolvedValue('hash');
    h.client.ttl.mockResolvedValue(60);
    h.client.hlen.mockResolvedValue(3);
    h.client.hscan.mockResolvedValueOnce(['7', ['a', '1', 'b', '2']]).mockResolvedValueOnce(['0', ['c', '3']]);
    const result = await makeService().value('h');
    expect(h.client.hscan).toHaveBeenCalledTimes(2);
    expect(h.client.hscan).toHaveBeenNthCalledWith(1, 'h', '0', 'COUNT', 200);
    expect(h.client.hscan).toHaveBeenNthCalledWith(2, 'h', '7', 'COUNT', 200);
    expect(result).toEqual({
      key: 'h',
      type: 'hash',
      ttl: 60,
      kind: 'hash',
      value: { a: '1', b: '2', c: '3' },
      truncated: false,
      length: 3,
    });
  });

  it('caps a hash at the collection cap and flags truncation', async () => {
    const pairs: string[] = [];
    for (let i = 0; i < 501; i++) pairs.push(`f${i}`, `v${i}`);
    h.client.type.mockResolvedValue('hash');
    h.client.ttl.mockResolvedValue(-1);
    h.client.hlen.mockResolvedValue(501);
    h.client.hscan.mockResolvedValue(['0', pairs]);
    const result = await makeService().value('big');
    expect(result.length).toBe(501);
    expect(result.truncated).toBe(true);
    if (result.kind !== 'hash') throw new Error('expected hash');
    expect(Object.keys(result.value)).toHaveLength(500);
  });

  it('shapes a set via sscan', async () => {
    h.client.type.mockResolvedValue('set');
    h.client.ttl.mockResolvedValue(-1);
    h.client.scard.mockResolvedValue(2);
    h.client.sscan.mockResolvedValue(['0', ['x', 'y']]);
    const result = await makeService().value('s');
    expect(h.client.sscan).toHaveBeenCalledWith('s', '0', 'COUNT', 200);
    expect(result).toEqual({
      key: 's',
      type: 'set',
      ttl: -1,
      kind: 'set',
      value: ['x', 'y'],
      truncated: false,
      length: 2,
    });
  });

  it('shapes a zset via zscan', async () => {
    h.client.type.mockResolvedValue('zset');
    h.client.ttl.mockResolvedValue(-1);
    h.client.zcard.mockResolvedValue(2);
    h.client.zscan.mockResolvedValue(['0', ['m1', '1.5', 'm2', '2.5']]);
    const result = await makeService().value('z');
    expect(h.client.zscan).toHaveBeenCalledWith('z', '0', 'COUNT', 200);
    expect(result).toEqual({
      key: 'z',
      type: 'zset',
      ttl: -1,
      kind: 'zset',
      value: [
        { member: 'm1', score: '1.5' },
        { member: 'm2', score: '2.5' },
      ],
      truncated: false,
      length: 2,
    });
  });

  it('shapes a stream via xrange', async () => {
    h.client.type.mockResolvedValue('stream');
    h.client.ttl.mockResolvedValue(-1);
    h.client.xlen.mockResolvedValue(1);
    h.client.xrange.mockResolvedValue([['1-0', ['field', 'value']]]);
    const result = await makeService().value('st');
    expect(h.client.xrange).toHaveBeenCalledWith('st', '-', '+', 'COUNT', 500);
    expect(result).toEqual({
      key: 'st',
      type: 'stream',
      ttl: -1,
      kind: 'stream',
      value: [{ id: '1-0', fields: { field: 'value' } }],
      truncated: false,
      length: 1,
    });
  });
});

describe('RedisService.scan', () => {
  it('passes MATCH and COUNT when a pattern is supplied', async () => {
    h.client.scan.mockResolvedValue(['12', ['k1', 'k2']]);
    h.client.type.mockResolvedValueOnce('string').mockResolvedValueOnce('hash');
    const result = await makeService().scan('0', 'foo:*', 50);
    expect(h.client.scan).toHaveBeenCalledWith('0', 'MATCH', 'foo:*', 'COUNT', 50);
    expect(result).toEqual({
      cursor: '12',
      keys: [
        { key: 'k1', type: 'string' },
        { key: 'k2', type: 'hash' },
      ],
    });
  });

  it('omits MATCH when no pattern is supplied', async () => {
    h.client.scan.mockResolvedValue(['0', []]);
    const result = await makeService().scan('0', undefined, 50);
    expect(h.client.scan).toHaveBeenCalledWith('0', 'COUNT', 50);
    expect(result).toEqual({ cursor: '0', keys: [] });
  });
});

describe('RedisService.info', () => {
  it('picks the whitelisted INFO fields and parses CLIENT LIST', async () => {
    h.client.dbsize.mockResolvedValue(7);
    h.client.info.mockResolvedValue(
      ['# Server', 'redis_version:7.2.0', 'redis_mode:standalone', 'not_picked:zzz', 'uptime_in_seconds:1234', ''].join(
        '\n',
      ),
    );
    h.client.call.mockResolvedValue(
      [
        'id=3 addr=127.0.0.1:5000 name=worker age=100 idle=5 db=0 cmd=get',
        'id=4 addr=127.0.0.1:5001 name=worker age=50 idle=1 db=0 cmd=ping',
        'id=5 addr=10.0.0.1:6000 age=200 idle=0 db=1 cmd=scan',
      ].join('\n'),
    );
    const result = await makeService().info();
    expect(h.client.call).toHaveBeenCalledWith('CLIENT', 'LIST');
    expect(result.dbsize).toBe(7);
    expect(result.server).toEqual({
      redis_version: '7.2.0',
      redis_mode: 'standalone',
      uptime_in_seconds: '1234',
    });
    expect(result.clients).toEqual([
      {
        label: 'worker',
        count: 2,
        clients: [
          { id: '3', addr: '127.0.0.1:5000', ageSeconds: 100, idleSeconds: 5, db: 0, cmd: 'get' },
          { id: '4', addr: '127.0.0.1:5001', ageSeconds: 50, idleSeconds: 1, db: 0, cmd: 'ping' },
        ],
      },
      {
        label: '10.0.0.1',
        count: 1,
        clients: [{ id: '5', addr: '10.0.0.1:6000', ageSeconds: 200, idleSeconds: 0, db: 1, cmd: 'scan' }],
      },
    ]);
  });

  it('degrades to an empty client list when CLIENT LIST throws', async () => {
    h.client.dbsize.mockResolvedValue(0);
    h.client.info.mockResolvedValue('redis_version:7.2.0');
    h.client.call.mockRejectedValue(new Error('NOPERM'));
    const result = await makeService().info();
    expect(result.clients).toEqual([]);
  });
});

describe('RedisService.probe', () => {
  it('returns true when PING replies PONG', async () => {
    h.client.ping.mockResolvedValue('PONG');
    expect(await makeService().probe()).toBe(true);
  });

  it('returns false when PING throws', async () => {
    h.client.ping.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await makeService().probe()).toBe(false);
  });
});

describe('RedisService client error handler', () => {
  it('registers a logging error handler rather than a silent no-op', async () => {
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    h.client.ping.mockResolvedValue('PONG');
    await makeService().probe();
    const registration = h.client.on.mock.calls.find(([event]) => event === 'error');
    expect(registration).toBeDefined();
    const handler = registration?.[1];
    expect(typeof handler).toBe('function');
    handler(new Error('boom'));
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});
