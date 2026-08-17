import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentWorkReaderService, PROGRESS_READ_CAP, WORK_SCAN_CAP } from '../agent-work.reader';

const ZONE = '00000000-0000-0000-0000-111111111111';

function makeClient() {
  return {
    scan: vi.fn((_cursor: string, _match: string, pattern: string) => {
      void pattern;
      return Promise.resolve(['0', [] as string[]]);
    }),
    hget: vi.fn((_key: string, _field: string) => Promise.resolve<string | null>(null)),
  };
}

let client: ReturnType<typeof makeClient>;

const makeReader = () => new AgentWorkReaderService({ client: () => client } as never);

const scanFor = (dispatch: string[], progress: string[]) =>
  vi.fn((_cursor: string, _matchWord: string, pattern: string) =>
    Promise.resolve(['0', pattern.includes('dispatch') ? dispatch : progress]),
  );

beforeEach(() => {
  client = makeClient();
});

describe('AgentWorkReaderService', () => {
  it('counts dispatches in flight and reports the most recent progress stamp', async () => {
    client.scan = scanFor([`${ZONE}:work:dispatch:a`, `${ZONE}:work:dispatch:b`], [`${ZONE}:work:progress:a`]);
    client.hget.mockResolvedValue('1700000000.5');

    expect(await makeReader().read(ZONE)).toEqual({
      dispatchesInFlight: 2,
      lastActivityAtMs: 1_700_000_000_500,
      scanCapped: false,
      readError: null,
    });
  });

  it('takes the newest stamp across several progress hashes', async () => {
    client.scan = scanFor([], [`${ZONE}:work:progress:a`, `${ZONE}:work:progress:b`]);
    client.hget.mockResolvedValueOnce('1700000000.0').mockResolvedValueOnce('1700000009.0');

    const result = await makeReader().read(ZONE);

    expect(result.lastActivityAtMs).toBe(1_700_000_009_000);
  });

  it('reports a measured zero and no activity when the zone has seen no agent work', async () => {
    expect(await makeReader().read(ZONE)).toEqual({
      dispatchesInFlight: 0,
      lastActivityAtMs: null,
      scanCapped: false,
      readError: null,
    });
  });

  it('ignores an unparseable progress stamp rather than reporting it as an epoch', async () => {
    client.scan = scanFor([], [`${ZONE}:work:progress:a`]);
    client.hget.mockResolvedValue('recently');

    const result = await makeReader().read(ZONE);

    expect(result.lastActivityAtMs).toBeNull();
  });

  it('reports undetermined counts rather than zero when the scan fails', async () => {
    client.scan = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));

    const result = await makeReader().read(ZONE);

    expect(result.dispatchesInFlight).toBeNull();
    expect(result.lastActivityAtMs).toBeNull();
    expect(result.readError).toContain('ECONNREFUSED');
    expect(result.scanCapped).toBeNull();
  });

  it('caps the scan when the dispatch keyspace exceeds the scan cap', async () => {
    const dispatch = Array.from({ length: WORK_SCAN_CAP + 1 }, (_, i) => `${ZONE}:work:dispatch:${i}`);
    client.scan = scanFor(dispatch, []);

    const result = await makeReader().read(ZONE);

    expect(result.scanCapped).toBe(true);
    expect(result.dispatchesInFlight).toBe(WORK_SCAN_CAP);
  });

  it('keeps the read cap the only progress term it needs, since a capped progress scan always exceeds it', () => {
    expect(PROGRESS_READ_CAP).toBeLessThan(WORK_SCAN_CAP);
  });

  it('caps the scan when the progress keyspace exceeds the scan cap', async () => {
    const progress = Array.from({ length: WORK_SCAN_CAP + 1 }, (_, i) => `${ZONE}:work:progress:${i}`);
    client.scan = scanFor([], progress);

    expect((await makeReader().read(ZONE)).scanCapped).toBe(true);
  });

  it('caps when the progress scan completed but returned more keys than the stamps it will read', async () => {
    // the boundary the other two branches cannot reach: the scan finished well inside WORK_SCAN_CAP,
    // so only the read cap makes the answer a floor
    const progress = Array.from({ length: PROGRESS_READ_CAP + 1 }, (_, i) => `${ZONE}:work:progress:${i}`);
    client.scan = scanFor([], progress);

    const result = await makeReader().read(ZONE);

    expect(result.scanCapped).toBe(true);
    expect(progress.length).toBeLessThan(WORK_SCAN_CAP);
    expect(result.dispatchesInFlight).toBe(0);
  });

  it('does not cap when the progress keys exactly fill the read cap', async () => {
    const progress = Array.from({ length: PROGRESS_READ_CAP }, (_, i) => `${ZONE}:work:progress:${i}`);
    client.scan = scanFor([], progress);

    expect((await makeReader().read(ZONE)).scanCapped).toBe(false);
  });

  it('does not count a key the scan returned twice', async () => {
    client.scan = scanFor([`${ZONE}:work:dispatch:a`, `${ZONE}:work:dispatch:a`], []);

    const result = await makeReader().read(ZONE);

    expect(result.dispatchesInFlight).toBe(1);
  });
});
