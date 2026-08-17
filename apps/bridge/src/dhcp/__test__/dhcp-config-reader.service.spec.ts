import { describe, expect, it, vi } from 'vitest';

import type { DhcpAtomValue, DhcpZoneOpsAtomValue } from '../dhcp-atom-value.schema';
import { DhcpConfigReaderService } from '../dhcp-config-reader.service';
import { makeAtom, makeLogger, okEnvelope } from './test-factories.js';

const VALID_VALUE: DhcpAtomValue = makeAtom();

function failedEnvelope(reason: string, writtenAt = 0): string {
  return JSON.stringify({
    status: 'failed',
    reason,
    written_at: writtenAt,
    request_id: null,
  });
}

function createReader(
  redisOverrides: Record<string, unknown> = {},
  logger: ReturnType<typeof makeLogger> = makeLogger(),
) {
  const redis = {
    scan: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    ...redisOverrides,
  };
  return { reader: new DhcpConfigReaderService(redis as never, logger as never), redis, logger };
}

describe('DhcpConfigReaderService', () => {
  it('returns ok with an empty map when no atoms exist', async () => {
    const { reader } = createReader();

    const result = await reader.readAll();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configs.size).toBe(0);
    }
  });

  it('returns ok with parsed configs, extracting prefixId from the key', async () => {
    const prefixId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const key = `prefix:${prefixId}:config:dhcp`;
    const { reader } = createReader({
      scan: vi.fn().mockResolvedValue([key]),
      get: vi.fn().mockResolvedValue(okEnvelope(VALID_VALUE)),
    });

    const result = await reader.readAll();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configs.size).toBe(1);
      expect(result.configs.get(prefixId)).toEqual(VALID_VALUE);
    }
  });

  it('skips failed-envelope atoms without error (returns null from readAtom)', async () => {
    const key = 'prefix:aaa:config:dhcp';
    const { reader } = createReader({
      scan: vi.fn().mockResolvedValue([key]),
      get: vi.fn().mockResolvedValue(failedEnvelope('render error')),
    });

    const result = await reader.readAll();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configs.size).toBe(0);
    }
  });

  it('skips malformed JSON atoms without fatality', async () => {
    const key = 'prefix:aaa:config:dhcp';
    const { reader } = createReader({
      scan: vi.fn().mockResolvedValue([key]),
      get: vi.fn().mockResolvedValue('not json'),
    });

    const result = await reader.readAll();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configs.size).toBe(0);
    }
  });

  it('skips absent atoms (null GET) without fatality', async () => {
    const key = 'prefix:aaa:config:dhcp';
    const { reader } = createReader({
      scan: vi.fn().mockResolvedValue([key]),
      get: vi.fn().mockResolvedValue(null),
    });

    const result = await reader.readAll();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configs.size).toBe(0);
    }
  });

  it('returns ok:false (fail-closed) when Redis SCAN throws', async () => {
    const logger = makeLogger();
    const { reader } = createReader(
      {
        scan: vi.fn().mockRejectedValue(new Error('connection refused')),
      },
      logger,
    );

    const result = await reader.readAll();
    expect(result.ok).toBe(false);
    expect(logger.warning).toHaveBeenCalled();
  });

  it('returns ok:false (fail-closed) when readAtom batch rejects', async () => {
    const key = 'prefix:aaa:config:dhcp';
    const logger = makeLogger();
    const { reader } = createReader(
      {
        scan: vi.fn().mockResolvedValue([key]),
        get: vi.fn().mockRejectedValue(new Error('timeout')),
      },
      logger,
    );

    const result = await reader.readAll();
    expect(result.ok).toBe(false);
    expect(logger.warning).toHaveBeenCalled();
  });

  it('handles multiple atoms, skipping invalid ones', async () => {
    const prefixA = 'aaa';
    const prefixB = 'bbb';
    const keyA = `prefix:${prefixA}:config:dhcp`;
    const keyB = `prefix:${prefixB}:config:dhcp`;
    const valueB: DhcpAtomValue = { ...VALID_VALUE, subnet: '10.0.2.0/24' };

    const { reader } = createReader({
      scan: vi.fn().mockResolvedValue([keyA, keyB]),
      get: vi.fn().mockResolvedValueOnce('bad json').mockResolvedValueOnce(okEnvelope(valueB)),
    });

    const result = await reader.readAll();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configs.size).toBe(1);
      expect(result.configs.get(prefixB)).toEqual(valueB);
    }
  });

  it('warns and skips atoms whose key does not match the expected pattern', async () => {
    const key = 'bad-key-format';
    const logger = makeLogger();
    const { reader } = createReader(
      {
        scan: vi.fn().mockResolvedValue([key]),
        get: vi.fn().mockResolvedValue(okEnvelope(VALID_VALUE)),
      },
      logger,
    );

    const result = await reader.readAll();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configs.size).toBe(0);
    }
    expect(logger.warning).toHaveBeenCalled();
  });

  describe('readZoneOps', () => {
    const OPS_VALUE: DhcpZoneOpsAtomValue = {
      leaderPollMs: 2000,
      pruneIntervalMs: 60000,
      declineBackoffSeconds: 600,
    };

    function opsEnvelope(value: DhcpZoneOpsAtomValue): string {
      return JSON.stringify({ status: 'ok', value, written_at: 0, request_id: null });
    }

    it('reads the zone ops atom from the wire-contract key literal', async () => {
      const get = vi.fn().mockResolvedValue(opsEnvelope(OPS_VALUE));
      const { reader } = createReader({ get });

      const result = await reader.readZoneOps();

      expect(result).toEqual(OPS_VALUE);
      expect(get.mock.calls[0][0]).toBe('config:dhcp');
    });

    it('returns null when the atom is absent', async () => {
      const { reader } = createReader({ get: vi.fn().mockResolvedValue(null) });

      await expect(reader.readZoneOps()).resolves.toBeNull();
    });

    it('returns null when the envelope value fails schema validation', async () => {
      const { reader } = createReader({
        get: vi.fn().mockResolvedValue(opsEnvelope({ ...OPS_VALUE, leaderPollMs: 0 })),
      });

      await expect(reader.readZoneOps()).resolves.toBeNull();
    });

    it('returns null and warns (fail-safe) when the Redis read throws', async () => {
      const logger = makeLogger();
      const { reader } = createReader({ get: vi.fn().mockRejectedValue(new Error('connection refused')) }, logger);

      await expect(reader.readZoneOps()).resolves.toBeNull();
      expect(logger.warning).toHaveBeenCalled();
    });
  });
});
