import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigAtomWriter } from '../../../common/redis';
import { TTL_DNS_RECORDS_SECONDS, DNS_RECORDS_KEY } from '../../../common/redis/redis-keys';
import { DnsRecordsAtomSchema, type DnsRecordsAtom } from '../dns-records-atom.schema';
import { DnsRecordsRedisWriterService } from '../dns-records-redis-writer.service';

const ZONE = '99999999-0000-0000-0000-000000000000';
const VALUE: DnsRecordsAtom = {
  domains: [
    {
      name: 'example.lan',
      type: 'FORWARD',
      records: [{ name: 'host-a', type: 'A', value: '10.0.0.1', ttl: null }],
    },
  ],
};

describe('DnsRecordsRedisWriterService', () => {
  let service: DnsRecordsRedisWriterService;
  let writeAtomJson: ReturnType<typeof vi.fn>;
  let delKey: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeAtomJson = vi.fn().mockResolvedValue({ written: true });
    delKey = vi.fn().mockResolvedValue(undefined);

    const atomWriter = { writeAtomJson, delKey } as unknown as ConfigAtomWriter;
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

    service = new DnsRecordsRedisWriterService(atomWriter, logger);
  });

  it('writes the DNS records as an ok envelope at the correct key with TTL 0', async () => {
    await service.set(ZONE, VALUE);

    expect(writeAtomJson).toHaveBeenCalledWith(ZONE, DNS_RECORDS_KEY, VALUE, DnsRecordsAtomSchema, TTL_DNS_RECORDS_SECONDS, {
      request_id: null,
    });
  });

  it('deletes the DNS records key via the atom writer', async () => {
    await service.clear(ZONE);

    expect(delKey).toHaveBeenCalledWith(ZONE, DNS_RECORDS_KEY);
  });

  it('surfaces the write result when the envelope is stale', async () => {
    writeAtomJson.mockResolvedValueOnce({ written: false, reason: 'stale' });

    const result = await service.set(ZONE, VALUE);

    expect(result).toEqual({ written: false, reason: 'stale' });
  });

  it('surfaces a thrown error when writeAtomJson rejects', async () => {
    writeAtomJson.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.set(ZONE, VALUE)).rejects.toThrow('redis down');
  });

  it('verifies TTL_DNS_RECORDS_SECONDS is 0 (durable, no expiry)', () => {
    expect(TTL_DNS_RECORDS_SECONDS).toBe(0);
  });

  it('verifies DNS_RECORDS_KEY key format', () => {
    expect(DNS_RECORDS_KEY).toBe('config:dns-records');
  });
});
