import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LeaderReaderService } from '../leader.reader';

const ZONE = '00000000-0000-0000-0000-111111111111';

function makeClient() {
  return {
    get: vi.fn(() => Promise.resolve<string | null>(null)),
    ttl: vi.fn(() => Promise.resolve(-2)),
    scan: vi.fn(() => Promise.resolve(['0', [] as string[]])),
    hgetall: vi.fn((_key: string) => Promise.resolve<Record<string, string>>({})),
  };
}

let client: ReturnType<typeof makeClient>;

const makeReader = () => new LeaderReaderService({ client: () => client } as never);

beforeEach(() => {
  client = makeClient();
});

describe('LeaderReaderService.leader', () => {
  it('reports the holder and its remaining lease', async () => {
    client.get.mockResolvedValue('spoke');
    client.ttl.mockResolvedValue(28);

    expect(await makeReader().leader(ZONE)).toEqual({ holder: 'spoke', ttlSeconds: 28, readError: null });
  });

  it('reports an unheld lease as a measurement, not a failure', async () => {
    expect(await makeReader().leader(ZONE)).toEqual({ holder: null, ttlSeconds: null, readError: null });
  });

  it('reports a held lease whose ttl redis will not quantify as undetermined', async () => {
    client.get.mockResolvedValue('spoke');
    client.ttl.mockResolvedValue(-1);

    expect(await makeReader().leader(ZONE)).toEqual({ holder: 'spoke', ttlSeconds: null, readError: null });
  });

  it('reports a failed read as unknown rather than unheld', async () => {
    client.get.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await makeReader().leader(ZONE);

    expect(result.holder).toBeNull();
    expect(result.readError).toContain('ECONNREFUSED');
  });
});

describe('LeaderReaderService.presence', () => {
  it('reads every presence hash the scan discovers', async () => {
    client.scan.mockResolvedValue(['0', [`${ZONE}:bridge:instance:spoke`, `${ZONE}:bridge:instance:spoke-2`]]);
    client.hgetall.mockImplementation((key: string) =>
      Promise.resolve({ instance_id: key.split(':').pop() ?? '', is_leader: 'False' }),
    );

    const records = await makeReader().presence(ZONE);

    expect(records.map((record) => record.instanceId)).toEqual(['spoke', 'spoke-2']);
  });

  it('follows the scan cursor rather than trusting one page', async () => {
    client.scan
      .mockResolvedValueOnce(['7', [`${ZONE}:bridge:instance:spoke`]])
      .mockResolvedValueOnce(['0', [`${ZONE}:bridge:instance:spoke-2`]]);
    client.hgetall.mockImplementation((key: string) => Promise.resolve({ instance_id: key.split(':').pop() ?? '' }));

    expect(await makeReader().presence(ZONE)).toHaveLength(2);
    expect(client.scan).toHaveBeenCalledTimes(2);
  });

  it('drops a record with no instance id rather than reporting a nameless bridge', async () => {
    client.scan.mockResolvedValue(['0', [`${ZONE}:bridge:instance:spoke`]]);
    client.hgetall.mockResolvedValue({});

    expect(await makeReader().presence(ZONE)).toEqual([]);
  });

  it('does not read a duplicate key twice, since scan may return one more than once', async () => {
    client.scan.mockResolvedValue(['0', [`${ZONE}:bridge:instance:spoke`, `${ZONE}:bridge:instance:spoke`]]);
    client.hgetall.mockResolvedValue({ instance_id: 'spoke' });

    expect(await makeReader().presence(ZONE)).toHaveLength(1);
    expect(client.hgetall).toHaveBeenCalledTimes(1);
  });

  it('lets a scan failure propagate, so the caller degrades the section rather than reporting no bridges', async () => {
    client.scan.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(makeReader().presence(ZONE)).rejects.toThrow('ECONNREFUSED');
  });
});
