import { describe, expect, it, vi, type Mock } from 'vitest';

import { NIL_DEVICE_ID } from '../../constants';
import { fetchLiveNetplanForInitrd, INITRD_NETPLAN_TIMEOUT_S } from '../initrd-netplan';
import type { NetplanAtomService } from '../netplan-atom.service';

const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';

function makeNetplanAtom(impl: NetplanAtomService['getLiveNetplan']): {
  service: NetplanAtomService;
  getLiveNetplan: Mock<(...args: any[]) => any>;
} {
  const getLiveNetplan = vi.fn(impl);
  const service = { getLiveNetplan } as unknown as NetplanAtomService;
  return { service, getLiveNetplan };
}

describe('fetchLiveNetplanForInitrd', () => {
  it('nil device id short-circuits without fetching', async () => {
    const { service, getLiveNetplan } = makeNetplanAtom(async () => 'should-not-be-returned');
    const result = await fetchLiveNetplanForInitrd(service, NIL_DEVICE_ID, { jobId: 'job-1' });
    expect(result).toBe('');
    expect(getLiveNetplan).not.toHaveBeenCalled();
  });

  it('empty device id short-circuits without fetching', async () => {
    const { service, getLiveNetplan } = makeNetplanAtom(async () => 'should-not-be-returned');
    const result = await fetchLiveNetplanForInitrd(service, '', { jobId: 'job-1' });
    expect(result).toBe('');
    expect(getLiveNetplan).not.toHaveBeenCalled();
  });

  it('exception is swallowed and returns empty string', async () => {
    const { service } = makeNetplanAtom(async () => {
      throw new Error('boom');
    });
    const result = await fetchLiveNetplanForInitrd(service, DEVICE_ID, { jobId: 'job-1' });
    expect(result).toBe('');
  });

  it('null result falls back to empty string', async () => {
    const { service, getLiveNetplan } = makeNetplanAtom(async () => null);
    const result = await fetchLiveNetplanForInitrd(service, DEVICE_ID, { jobId: 'job-1' });
    expect(result).toBe('');
    expect(getLiveNetplan).toHaveBeenCalledTimes(1);
    expect(getLiveNetplan).toHaveBeenCalledWith(DEVICE_ID, {
      jobId: 'job-1',
      timeoutS: INITRD_NETPLAN_TIMEOUT_S,
    });
  });

  it('returns yaml string on success', async () => {
    const yaml = 'network:\n  version: 2\n';
    const { service } = makeNetplanAtom(async () => yaml);
    const result = await fetchLiveNetplanForInitrd(service, DEVICE_ID, { jobId: 'job-1' });
    expect(result).toBe(yaml);
  });

  it('default jobId is empty string', async () => {
    const { service, getLiveNetplan } = makeNetplanAtom(async () => null);
    await fetchLiveNetplanForInitrd(service, DEVICE_ID);
    expect(getLiveNetplan).toHaveBeenCalledWith(DEVICE_ID, {
      jobId: '',
      timeoutS: INITRD_NETPLAN_TIMEOUT_S,
    });
  });
});
