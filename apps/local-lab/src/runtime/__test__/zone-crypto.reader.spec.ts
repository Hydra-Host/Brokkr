import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ZoneCryptoReaderService } from '../zone-crypto.reader';

const ZONE = '00000000-0000-0000-0000-111111111111';

function makeClient() {
  return {
    exists: vi.fn(() => Promise.resolve(0)),
    ttl: vi.fn(() => Promise.resolve(-2)),
    get: vi.fn(() => Promise.resolve(null)),
    hgetall: vi.fn(() => Promise.resolve({})),
  };
}

let client: ReturnType<typeof makeClient>;

const makeReader = () => new ZoneCryptoReaderService({ client: () => client } as never);

beforeEach(() => {
  client = makeClient();
});

describe('ZoneCryptoReaderService', () => {
  it('reports an enrolled zone from key presence alone', async () => {
    client.exists.mockResolvedValue(1);

    expect(await makeReader().read(ZONE)).toEqual({
      state: 'enrolled',
      bootstrapLockTtlSeconds: null,
      readError: null,
    });
  });

  it('reports a bootstrap in flight with the lock countdown', async () => {
    client.ttl.mockResolvedValue(420);

    expect(await makeReader().read(ZONE)).toEqual({
      state: 'bootstrapping',
      bootstrapLockTtlSeconds: 420,
      readError: null,
    });
  });

  it('reports a never-enrolled zone when neither key is present', async () => {
    expect(await makeReader().read(ZONE)).toEqual({
      state: 'not-enrolled',
      bootstrapLockTtlSeconds: null,
      readError: null,
    });
  });

  it('reports a held lock with no expiry as bootstrapping with an undetermined countdown', async () => {
    client.ttl.mockResolvedValue(-1);

    expect(await makeReader().read(ZONE)).toEqual({
      state: 'bootstrapping',
      bootstrapLockTtlSeconds: null,
      readError: null,
    });
  });

  it('reports unknown rather than not-enrolled when the probe fails', async () => {
    client.exists.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await makeReader().read(ZONE);

    expect(result.state).toBe('unknown');
    expect(result.readError).toContain('ECONNREFUSED');
  });

  it('never fetches the zone key value, on any path', async () => {
    client.exists.mockResolvedValue(1);
    await makeReader().read(ZONE);
    client.exists.mockResolvedValue(0);
    client.ttl.mockResolvedValue(120);
    await makeReader().read(ZONE);
    client.ttl.mockResolvedValue(-2);
    await makeReader().read(ZONE);

    expect(client.get).not.toHaveBeenCalled();
    expect(client.hgetall).not.toHaveBeenCalled();
  });
});
