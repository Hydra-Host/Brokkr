import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShimBinding } from '../vrrp-desired';
import { VrrpReaderService } from '../vrrp.reader';

const ZONE = '00000000-0000-0000-0000-111111111111';
const KEY = `${ZONE}:prefix:prefix-1:config:vrrp`;

const atom = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    status: 'ok',
    value: { vip: '10.0.1.1/24', ifaceByBridge: { spoke: 'eth0' } },
    written_at: 1_700_000_000_000,
    request_id: null,
    ...over,
  });

function makeClient() {
  return {
    scan: vi.fn(() => Promise.resolve(['0', [KEY]])),
    get: vi.fn((_key: string) => Promise.resolve<string | null>(atom())),
  };
}

let client: ReturnType<typeof makeClient>;
let bindings: ShimBinding[] | null;

const makeReader = () =>
  new VrrpReaderService({ client: () => client } as never, { bindings: () => Promise.resolve(bindings) } as never);

beforeEach(() => {
  client = makeClient();
  bindings = [];
});

describe('VrrpReaderService', () => {
  it('reports the atom and the observed holder', async () => {
    bindings = [{ instanceId: 'spoke', cidr: '10.0.1.1/24' }];

    const result = await makeReader().read(ZONE);

    expect(result.observability).toBe('shim');
    expect(result.vips).toHaveLength(1);
    expect(result.vips[0]).toMatchObject({
      prefixId: 'prefix-1',
      vip: '10.0.1.1/24',
      ifaceByBridge: { spoke: 'eth0' },
      observedHolders: ['spoke'],
      atomError: null,
    });
  });

  it('marks bind state unobservable and nulls every holder list when the shim is silent', async () => {
    bindings = null;

    const result = await makeReader().read(ZONE);

    expect(result.observability).toBe('unavailable');
    expect(result.vips[0].observedHolders).toBeNull();
  });

  it('reports an observed empty holder list when the shim saw nobody holding it', async () => {
    const result = await makeReader().read(ZONE);

    expect(result.observability).toBe('shim');
    expect(result.vips[0].observedHolders).toEqual([]);
  });

  it('keeps a malformed atom as a row carrying its error, rather than dropping the vip', async () => {
    client.get.mockResolvedValue('{not json');

    const result = await makeReader().read(ZONE);

    expect(result.vips).toHaveLength(1);
    expect(result.vips[0].atomError).toBeTruthy();
    expect(result.vips[0].observedHolders).toBeNull();
    expect(result.readError).toBeNull();
    expect(result.vips[0].vip).toBeNull();
    expect(result.vips[0].writtenAtMs).toBeNull();
  });

  it('keeps a hub-failed atom visible with its reason', async () => {
    client.get.mockResolvedValue(
      JSON.stringify({ status: 'failed', reason: 'no_binding', written_at: 1_700_000_000_000, request_id: null }),
    );

    const result = await makeReader().read(ZONE);

    expect(result.vips[0].atomError).toContain('no_binding');
  });

  it('keeps the hub stamp on a hub-failed atom while leaving the address undetermined', async () => {
    client.get.mockResolvedValue(
      JSON.stringify({ status: 'failed', reason: 'no_binding', written_at: 1_700_000_000_000, request_id: null }),
    );

    const result = await makeReader().read(ZONE);

    expect(result.vips[0].writtenAtMs).toBe(1_700_000_000_000);
    expect(result.vips[0].vip).toBeNull();
  });

  it('reports an empty vip list as unknown, not as none configured, when discovery fails', async () => {
    client.scan.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await makeReader().read(ZONE);

    expect(result.vips).toEqual([]);
    expect(result.readError).toContain('ECONNREFUSED');
  });

  it('leaves desiredHolder for the caller, which is the only side holding the leader', async () => {
    const result = await makeReader().read(ZONE);

    expect(result.vips[0].desiredHolder).toBeNull();
  });
});
