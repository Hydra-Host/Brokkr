import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { z } from 'zod';
import { ConfigAtomWriter, TTL_SAGA_EPHEMERAL_SECONDS, TTL_STABLE_SECONDS } from '../config-atom-writer.service';
import { REDIS_CLIENT } from '../redis.module';

const ZONE_ID = '550e8400-e29b-41d4-a716-446655440042';
const REQUEST_ID = '11111111-2222-4333-8444-555555555555';
const FIXED_NOW = 1_730_000_000_123;

describe('ConfigAtomWriter', () => {
  let writer: ConfigAtomWriter;
  let redis: { set: Mock; get: Mock; del: Mock; multi: Mock; eval: Mock };
  let pipeline: { set: Mock; del: Mock; exec: Mock };

  beforeEach(async () => {
    pipeline = {
      set: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([[null, 'OK']]),
    };
    redis = {
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
      multi: vi.fn().mockReturnValue(pipeline),
      eval: vi.fn().mockResolvedValue('OK'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfigAtomWriter,
        { provide: REDIS_CLIENT, useValue: redis },
        {
          provide: `LoggerService${ConfigAtomWriter.name}`,
          useValue: {
            log: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            verbose: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();

    writer = module.get<ConfigAtomWriter>(ConfigAtomWriter);
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('writeStringNx', () => {
    it('returns true when the key was created (SET NX returns OK)', async () => {
      redis.set.mockResolvedValueOnce('OK');

      const result = await writer.writeStringNx(ZONE_ID, 'render:inflight:netplan:device-42', 'req-1', 30);

      expect(result).toBe(true);
      expect(redis.set).toHaveBeenCalledWith(`${ZONE_ID}:render:inflight:netplan:device-42`, 'req-1', 'EX', 30, 'NX');
    });

    it('returns false when the key already exists (SET NX returns null)', async () => {
      redis.set.mockResolvedValueOnce(null);

      const result = await writer.writeStringNx(ZONE_ID, 'render:inflight:netplan:device-42', 'req-2', 30);

      expect(result).toBe(false);
    });

    it('wraps Redis errors with the key for context', async () => {
      redis.set.mockRejectedValueOnce(new Error('connection refused'));

      await expect(writer.writeStringNx(ZONE_ID, 'render:inflight:netplan:device-42', 'req-3', 30)).rejects.toThrow(
        /Failed to write atom NX.*render:inflight:netplan:device-42.*connection refused/,
      );
    });
  });

  describe('writeAtomJson', () => {
    const schema = z.object({ ips: z.array(z.string()), ttl: z.number() });

    it('wraps the value in an ok envelope with written_at + request_id and JSON-stringifies', async () => {
      await writer.writeAtomJson(
        ZONE_ID,
        'dns:zone:a:host.example.com',
        { ips: ['10.0.0.1', '10.0.0.2'], ttl: 300 },
        schema,
        TTL_STABLE_SECONDS,
        { request_id: REQUEST_ID },
      );

      expect(redis.eval).toHaveBeenCalledTimes(1);
      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        `${ZONE_ID}:dns:zone:a:host.example.com`,
        JSON.stringify({
          status: 'ok',
          value: { ips: ['10.0.0.1', '10.0.0.2'], ttl: 300 },
          written_at: FIXED_NOW,
          request_id: REQUEST_ID,
        }),
        String(FIXED_NOW),
        String(TTL_STABLE_SECONDS),
      );
    });

    it('accepts request_id: null for unsolicited writes', async () => {
      await writer.writeAtomJson(
        ZONE_ID,
        'dns:zone:a:host.example.com',
        { ips: ['10.0.0.1'], ttl: 60 },
        schema,
        TTL_STABLE_SECONDS,
        { request_id: null },
      );

      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        `${ZONE_ID}:dns:zone:a:host.example.com`,
        expect.stringContaining('"request_id":null'),
        String(FIXED_NOW),
        String(TTL_STABLE_SECONDS),
      );
    });

    it('refuses to write a malformed value (no Redis call)', async () => {
      const permissiveSchema: z.ZodSchema<unknown> = schema;
      await expect(
        writer.writeAtomJson(
          ZONE_ID,
          'dns:zone:a:host.example.com',
          { ips: 'not-an-array', ttl: 'not-a-number' },
          permissiveSchema,
          TTL_STABLE_SECONDS,
          { request_id: REQUEST_ID },
        ),
      ).rejects.toThrow(/Refusing to write malformed atom/);

      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('writes with ttl="0" (Lua interprets as no-EX) when ttlSeconds is 0', async () => {
      await writer.writeAtomJson(ZONE_ID, 'dns:zone:a:host.example.com', { ips: ['10.0.0.1'], ttl: 60 }, schema, 0, {
        request_id: null,
      });

      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        `${ZONE_ID}:dns:zone:a:host.example.com`,
        expect.any(String),
        String(FIXED_NOW),
        '0',
      );
    });

    it('wraps Redis errors with the key for context', async () => {
      redis.eval.mockRejectedValueOnce(new Error('connection refused'));

      await expect(
        writer.writeAtomJson(
          ZONE_ID,
          'dns:zone:a:host.example.com',
          { ips: ['10.0.0.1'], ttl: 60 },
          schema,
          TTL_STABLE_SECONDS,
          { request_id: null },
        ),
      ).rejects.toThrow(/Failed to write atom.*dns:zone:a:host.example.com.*connection refused/);
    });

    it('abandons the write and returns { written: false, reason: "stale" } when the Lua script reports STALE', async () => {
      redis.eval.mockResolvedValueOnce('STALE');

      await expect(
        writer.writeAtomJson(
          ZONE_ID,
          'dns:zone:a:host.example.com',
          { ips: ['ours'], ttl: 1 },
          schema,
          TTL_STABLE_SECONDS,
          { request_id: null },
        ),
      ).resolves.toEqual({ written: false, reason: 'stale' });

      expect(redis.eval).toHaveBeenCalledTimes(1);
    });

    it('returns { written: true } when the Lua script reports OK (write applied)', async () => {
      redis.eval.mockResolvedValueOnce('OK');

      await expect(
        writer.writeAtomJson(
          ZONE_ID,
          'dns:zone:a:host.example.com',
          { ips: ['ours'], ttl: 1 },
          schema,
          TTL_STABLE_SECONDS,
          { request_id: null },
        ),
      ).resolves.toEqual({ written: true });
    });
  });

  describe('writeAtomString', () => {
    it('wraps a raw string in an ok envelope and returns { written: true }', async () => {
      await expect(
        writer.writeAtomString(ZONE_ID, 'netplan:device:42:config:live', 'network:\n  version: 2', TTL_STABLE_SECONDS, {
          request_id: REQUEST_ID,
        }),
      ).resolves.toEqual({ written: true });

      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        `${ZONE_ID}:netplan:device:42:config:live`,
        JSON.stringify({
          status: 'ok',
          value: 'network:\n  version: 2',
          written_at: FIXED_NOW,
          request_id: REQUEST_ID,
        }),
        String(FIXED_NOW),
        String(TTL_STABLE_SECONDS),
      );
    });

    it('passes ttl="0" so Lua skips EX when ttlSeconds is 0', async () => {
      await writer.writeAtomString(ZONE_ID, 'ipxe:device:42:identifier-pointer', 'abc', 0, { request_id: null });

      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        `${ZONE_ID}:ipxe:device:42:identifier-pointer`,
        expect.any(String),
        String(FIXED_NOW),
        '0',
      );
    });

    it('accepts the saga-ephemeral TTL', async () => {
      await writer.writeAtomString(
        ZONE_ID,
        'ipxe:device:42:config:custom',
        '#!ipxe\nboot',
        TTL_SAGA_EPHEMERAL_SECONDS,
        {
          request_id: null,
        },
      );

      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        expect.any(String),
        expect.any(String),
        String(FIXED_NOW),
        String(TTL_SAGA_EPHEMERAL_SECONDS),
      );
    });

    it('wraps Redis errors with the key for context', async () => {
      redis.eval.mockRejectedValueOnce(new Error('connection refused'));

      await expect(
        writer.writeAtomString(ZONE_ID, 'ipxe:device:42:config:disk', 'x', TTL_STABLE_SECONDS, { request_id: null }),
      ).rejects.toThrow(/key=550e8400-e29b-41d4-a716-446655440042:ipxe:device:42:config:disk.*connection refused/);
    });

    it('returns { written: false, reason: "stale" } when the Lua script reports STALE', async () => {
      redis.eval.mockResolvedValueOnce('STALE');

      await expect(
        writer.writeAtomString(ZONE_ID, 'ipxe:device:42:config:disk', 'x', TTL_STABLE_SECONDS, { request_id: null }),
      ).resolves.toEqual({ written: false, reason: 'stale' });
    });
  });

  describe('writeAtomError', () => {
    it('writes a failed envelope and returns { written: true }', async () => {
      await expect(
        writer.writeAtomError(ZONE_ID, 'netplan:device:42:config:live', 'unsupported_domain', 30, {
          request_id: REQUEST_ID,
        }),
      ).resolves.toEqual({ written: true });

      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        `${ZONE_ID}:netplan:device:42:config:live`,
        JSON.stringify({
          status: 'failed',
          reason: 'unsupported_domain',
          written_at: FIXED_NOW,
          request_id: REQUEST_ID,
        }),
        String(FIXED_NOW),
        '30',
      );
    });

    it('honors a short TTL (negative-cache pattern)', async () => {
      await writer.writeAtomError(ZONE_ID, 'netplan:device:42:config:live', 'entity_not_found', 10, {
        request_id: null,
      });

      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        expect.any(String),
        expect.any(String),
        String(FIXED_NOW),
        '10',
      );
    });

    it('wraps Redis errors with the key for context', async () => {
      redis.eval.mockRejectedValueOnce(new Error('connection refused'));

      await expect(
        writer.writeAtomError(ZONE_ID, 'netplan:device:42:config:live', 'unsupported_domain', 30, {
          request_id: null,
        }),
      ).rejects.toThrow(/Failed to write atom.*netplan:device:42:config:live.*connection refused/);
    });

    it('returns { written: false, reason: "stale" } when the Lua script reports STALE', async () => {
      redis.eval.mockResolvedValueOnce('STALE');

      await expect(
        writer.writeAtomError(ZONE_ID, 'netplan:device:42:config:live', 'unsupported_domain', 30, {
          request_id: null,
        }),
      ).resolves.toEqual({ written: false, reason: 'stale' });
    });
  });

  describe('readAtom', () => {
    const schema = z.object({ ips: z.array(z.string()), ttl: z.number() });
    const valueObject = { ips: ['10.0.0.1'], ttl: 300 };

    it('returns the unwrapped value when the envelope is status: ok', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({
          status: 'ok',
          value: valueObject,
          written_at: FIXED_NOW,
          request_id: REQUEST_ID,
        }),
      );

      const result = await writer.readAtom(ZONE_ID, 'dns:zone:a:host.example.com', schema);

      expect(result).toEqual(valueObject);
      expect(redis.get).toHaveBeenCalledWith(`${ZONE_ID}:dns:zone:a:host.example.com`);
    });

    it('returns null when the key is absent', async () => {
      redis.get.mockResolvedValueOnce(null);

      const result = await writer.readAtom(ZONE_ID, 'dns:zone:a:host.example.com', schema);

      expect(result).toBeNull();
    });

    it('returns null when the envelope is status: failed (negative-cache hit)', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({
          status: 'failed',
          reason: 'unsupported_domain',
          written_at: FIXED_NOW,
          request_id: REQUEST_ID,
        }),
      );

      const result = await writer.readAtom(ZONE_ID, 'dns:zone:a:host.example.com', schema);

      expect(result).toBeNull();
    });

    it('throws on malformed JSON with the key for context', async () => {
      redis.get.mockResolvedValueOnce('{not json');

      await expect(writer.readAtom(ZONE_ID, 'dns:zone:a:host.example.com', schema)).rejects.toThrow(
        /Failed to parse atom JSON.*dns:zone:a:host.example.com/,
      );
    });

    it('throws on envelope schema mismatch (corrupted atom)', async () => {
      redis.get.mockResolvedValueOnce(JSON.stringify({ status: 'whatever', value: valueObject }));

      await expect(writer.readAtom(ZONE_ID, 'dns:zone:a:host.example.com', schema)).rejects.toThrow(
        /Atom envelope schema mismatch \(key=/,
      );
    });

    it("throws on value schema mismatch (envelope ok but value doesn't match caller's schema)", async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({
          status: 'ok',
          value: { ips: 'not-an-array', ttl: 'not-a-number' },
          written_at: FIXED_NOW,
          request_id: REQUEST_ID,
        }),
      );

      await expect(writer.readAtom(ZONE_ID, 'dns:zone:a:host.example.com', schema)).rejects.toThrow(
        /Atom value schema mismatch \(key=.*dns:zone:a:host\.example\.com/,
      );
    });

    it('wraps Redis GET errors with the key for context', async () => {
      redis.get.mockRejectedValueOnce(new Error('connection refused'));

      await expect(writer.readAtom(ZONE_ID, 'dns:zone:a:host.example.com', schema)).rejects.toThrow(
        /Failed to read atom.*dns:zone:a:host.example.com.*connection refused/,
      );
    });
  });

  describe('writeMulti', () => {
    it('opens a MULTI pipeline and calls exec', async () => {
      await writer.writeMulti(ZONE_ID, [
        { op: 'set', key: 'device:abc:record', value: '{"deviceId":"abc"}' },
        { op: 'set', key: 'device:lookup:mac:aa:bb', value: 'abc' },
      ]);

      expect(redis.multi).toHaveBeenCalledTimes(1);
      expect(pipeline.set).toHaveBeenCalledTimes(2);
      expect(pipeline.set).toHaveBeenCalledWith(`${ZONE_ID}:device:abc:record`, '{"deviceId":"abc"}');
      expect(pipeline.set).toHaveBeenCalledWith(`${ZONE_ID}:device:lookup:mac:aa:bb`, 'abc');
      expect(pipeline.exec).toHaveBeenCalledTimes(1);
    });

    it('uses SET ... EX for operations with a positive ttl', async () => {
      await writer.writeMulti(ZONE_ID, [{ op: 'set', key: 'ephemeral:key', value: 'data', ttl: 3600 }]);

      expect(pipeline.set).toHaveBeenCalledWith(`${ZONE_ID}:ephemeral:key`, 'data', 'EX', 3600);
    });

    it('calls pipeline.del for del operations', async () => {
      await writer.writeMulti(ZONE_ID, [{ op: 'del', key: 'device:lookup:mac:old' }]);

      expect(pipeline.del).toHaveBeenCalledWith(`${ZONE_ID}:device:lookup:mac:old`);
      expect(pipeline.set).not.toHaveBeenCalled();
    });

    it('is a no-op when operations array is empty', async () => {
      await writer.writeMulti(ZONE_ID, []);

      expect(redis.multi).not.toHaveBeenCalled();
    });

    it('throws when exec returns a failed result', async () => {
      pipeline.exec.mockResolvedValueOnce([[new Error('READONLY'), null]]);

      await expect(writer.writeMulti(ZONE_ID, [{ op: 'set', key: 'k', value: 'v' }])).rejects.toThrow(
        /Failed to execute MULTI with 1 operation\(s\).*READONLY/,
      );
    });

    it('throws when exec returns null (MULTI discarded) rather than treating it as success', async () => {
      pipeline.exec.mockResolvedValueOnce(null);

      await expect(writer.writeMulti(ZONE_ID, [{ op: 'set', key: 'k', value: 'v' }])).rejects.toThrow(
        /Failed to execute MULTI with 1 operation\(s\).*writeMulti aborted: transaction discarded/,
      );
    });
  });

  describe('deleteKeys', () => {
    it('prefixes each key with zoneId and calls redis.del in a single call', async () => {
      await writer.deleteKeys(ZONE_ID, ['device:abc:record', 'device:lookup:mac:aa:bb:cc']);

      expect(redis.del).toHaveBeenCalledWith(`${ZONE_ID}:device:abc:record`, `${ZONE_ID}:device:lookup:mac:aa:bb:cc`);
    });

    it('is a no-op when the key array is empty', async () => {
      await writer.deleteKeys(ZONE_ID, []);

      expect(redis.del).not.toHaveBeenCalled();
    });

    it('wraps Redis errors with context', async () => {
      redis.del.mockRejectedValueOnce(new Error('connection refused'));

      await expect(writer.deleteKeys(ZONE_ID, ['device:abc:record'])).rejects.toThrow(
        /Failed to delete 1 atom\(s\).*connection refused/,
      );
    });
  });

  describe('setString (plain, non-envelope)', () => {
    it('writes the raw value (no envelope) under the zone prefix with a TTL', async () => {
      await writer.setString(ZONE_ID, 'device:42:rescue:ssh_pub_keys', 'ssh-ed25519 AAA\nssh-ed25519 BBB', 86400);

      expect(redis.set).toHaveBeenCalledWith(
        `${ZONE_ID}:device:42:rescue:ssh_pub_keys`,
        'ssh-ed25519 AAA\nssh-ed25519 BBB',
        'EX',
        86400,
      );
    });

    it('omits EX when ttl is non-positive', async () => {
      await writer.setString(ZONE_ID, 'device:42:rescue:ssh_pub_keys', 'value', 0);

      expect(redis.set).toHaveBeenCalledWith(`${ZONE_ID}:device:42:rescue:ssh_pub_keys`, 'value');
    });

    it('wraps Redis errors with context', async () => {
      redis.set.mockRejectedValueOnce(new Error('connection refused'));

      await expect(writer.setString(ZONE_ID, 'device:42:rescue:ssh_pub_keys', 'value', 86400)).rejects.toThrow(
        /Failed to write string.*connection refused/,
      );
    });
  });

  describe('delKey (single plain key)', () => {
    it('deletes the single zone-prefixed key', async () => {
      await writer.delKey(ZONE_ID, 'device:42:rescue:ssh_pub_keys');

      expect(redis.del).toHaveBeenCalledWith(`${ZONE_ID}:device:42:rescue:ssh_pub_keys`);
    });

    it('wraps Redis errors with context', async () => {
      redis.del.mockRejectedValueOnce(new Error('connection refused'));

      await expect(writer.delKey(ZONE_ID, 'device:42:rescue:ssh_pub_keys')).rejects.toThrow(
        /Failed to delete key.*connection refused/,
      );
    });
  });
});
