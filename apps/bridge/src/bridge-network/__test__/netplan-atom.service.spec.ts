import { describe, expect, it, vi, type Mock } from 'vitest';

import type { NetplanAtom } from '../../device-record/netplan/netplan.schema';
import { netplanAtomSchema } from '../../device-record/netplan/netplan.schema';
import { NetplanAtomService, type AtomFetcher } from '../netplan-atom.service';

const DEVICE_ID = 'abcdef00-1111-2222-3333-444455556666';

interface CapturedGetAtomArgs {
  domain: string;
  entityId: string;
  atomKey: string;
  valueSchema: unknown;
  timeoutS?: number;
  jobId?: string;
}

function makeFetcher(returnValue: NetplanAtom | null): {
  fetcher: AtomFetcher;
  getAtom: Mock<(...args: any[]) => any>;
} {
  const getAtom = vi.fn(async (_args: CapturedGetAtomArgs) => returnValue);
  const fetcher: AtomFetcher = { getAtom: getAtom as unknown as AtomFetcher['getAtom'] };
  return { fetcher, getAtom };
}

describe('NetplanAtomService.getLiveNetplan', () => {
  it('returns yaml string on success', async () => {
    const fakeAtom: NetplanAtom = { yaml: 'network:\n  version: 2\n' };
    const { fetcher, getAtom } = makeFetcher(fakeAtom);
    const service = new NetplanAtomService(fetcher);

    const result = await service.getLiveNetplan(DEVICE_ID, { jobId: 'job-1' });

    expect(result).toBe('network:\n  version: 2\n');
    expect(getAtom).toHaveBeenCalledTimes(1);
    const args = getAtom.mock.calls[0][0] as CapturedGetAtomArgs;
    expect(args.domain).toBe('netplan');
    expect(args.entityId).toBe(DEVICE_ID);
    expect(args.atomKey).toBe(`device:${DEVICE_ID}:config:netplan:live`);
    expect(args.valueSchema).toBe(netplanAtomSchema);
    expect(args.jobId).toBe('job-1');
  });

  it('returns null when atom fetcher returns null', async () => {
    const { fetcher } = makeFetcher(null);
    const service = new NetplanAtomService(fetcher);

    const result = await service.getLiveNetplan(DEVICE_ID);

    expect(result).toBeNull();
  });

  it('default jobId is empty string', async () => {
    const { fetcher, getAtom } = makeFetcher(null);
    const service = new NetplanAtomService(fetcher);

    await service.getLiveNetplan(DEVICE_ID);

    const args = getAtom.mock.calls[0][0] as CapturedGetAtomArgs;
    expect(args.jobId).toBe('');
  });

  it('atom key uses live phase', async () => {
    const { fetcher, getAtom } = makeFetcher(null);
    const service = new NetplanAtomService(fetcher);

    await service.getLiveNetplan(DEVICE_ID);

    const args = getAtom.mock.calls[0][0] as CapturedGetAtomArgs;
    expect(args.atomKey.endsWith(':live')).toBe(true);
  });
});
