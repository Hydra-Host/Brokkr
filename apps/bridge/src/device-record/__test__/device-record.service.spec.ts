import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { AtomCache, EnqueueRenderRequest } from '../atom/atom-fetcher';
import { isPlaceholder, type DeviceRecord } from '../device-record.schema';
import { DeviceRecordService, ResolveOutcome } from '../device-record.service';

vi.mock('../atom/atom-fetcher', async () => {
  const actual = await vi.importActual<typeof import('../atom/atom-fetcher')>('../atom/atom-fetcher');
  return { ...actual, getAtom: vi.fn() };
});

import * as atomFetcher from '../atom/atom-fetcher';

const getAtomMock = vi.mocked(atomFetcher.getAtom);

const DEVICE_UUID = '33333333-3333-3333-3333-333333333333';

function makeRecord(id: string = DEVICE_UUID, placeholder = false): DeviceRecord {
  return {
    id,
    is_placeholder: placeholder,
    status: 'provisioning',
    role: 'server',
    installed_os: null,
    rescue_os: null,
    platform_tags: [],
    device_type: 'poweredge-r750',
    netplan: null,
    serial_port_recommended: null,
    location_network_type: 'roce',
    is_vpc: false,
    last_job_id: null,
    buildarch: 'amd64',
  };
}

interface CacheScript {
  get?: (key: string) => string | null;
}

function makeCache(script: CacheScript = {}): AtomCache & { get: Mock<(...args: any[]) => any> } {
  const getFn = vi.fn(async (key: string, _jobId?: string) => (script.get ? script.get(key) : null));
  return {
    get: getFn,
    delete: vi.fn(async () => 0),
  } as AtomCache & { get: Mock<(...args: any[]) => any> };
}

beforeEach(() => {
  getAtomMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('MAC normalization (via lookup-key probe)', () => {
  it('colons become hyphens, value lowercased', async () => {
    const cache = makeCache();
    const enq: EnqueueRenderRequest = vi.fn(async () => false);
    const service = new DeviceRecordService(cache, enq);
    await service.resolveDevice({ mac: 'AA:BB:CC:DD:EE:FF' }, { jobId: 'j' });
    expect(cache.get).toHaveBeenCalledWith('device:lookup:mac:aa-bb-cc-dd-ee-ff', 'j');
  });

  it('hyphens stay hyphens, value lowercased', async () => {
    const cache = makeCache();
    const enq: EnqueueRenderRequest = vi.fn(async () => false);
    const service = new DeviceRecordService(cache, enq);
    await service.resolveDevice({ mac: 'AA-BB-CC-DD-EE-FF' }, { jobId: 'j' });
    expect(cache.get).toHaveBeenCalledWith('device:lookup:mac:aa-bb-cc-dd-ee-ff', 'j');
  });
});

describe('lookup-key shapes (via cache-key probe)', () => {
  it.each([
    ['mac', 'AA:BB:CC:DD:EE:FF', 'device:lookup:mac:aa-bb-cc-dd-ee-ff'],
    ['ipmi_mac', 'AA:BB:CC:DD:EE:FF', 'device:lookup:ipmi_mac:aa-bb-cc-dd-ee-ff'],
    ['serial', 'ABC-123', 'device:lookup:serial:abc-123'],
    ['system_uuid', 'FOO-UUID', 'device:lookup:system_uuid:foo-uuid'],
    ['chassis_serial', 'Chassis-XYZ', 'device:lookup:chassis_serial:chassis-xyz'],
    ['board_serial', 'Board-42', 'device:lookup:board_serial:board-42'],
  ])('%s kind produces key %s', async (kind, value, expectedKey) => {
    const cache = makeCache();
    const enq: EnqueueRenderRequest = vi.fn(async () => false);
    const service = new DeviceRecordService(cache, enq);
    await service.resolveDevice({ [kind]: value }, { jobId: 'j' });
    expect(cache.get).toHaveBeenCalledWith(expectedKey, 'j');
  });
});

describe('resolveDevice: pointer hit', () => {
  it('mac pointer hit fetches the record atom', async () => {
    const cache = makeCache({ get: () => DEVICE_UUID });
    const record = makeRecord();
    getAtomMock.mockResolvedValue(record);
    const enq: EnqueueRenderRequest = vi.fn(async () => true);
    const service = new DeviceRecordService(cache, enq);

    const result = await service.resolveDevice({ mac: 'AA:BB:CC:DD:EE:FF' }, { jobId: 'j' });

    expect(result).toBe(record);
    expect(cache.get).toHaveBeenCalledWith('device:lookup:mac:aa-bb-cc-dd-ee-ff', 'j');
    const call = getAtomMock.mock.calls[0]?.[0];
    expect(call?.atomKey).toBe(`device:${DEVICE_UUID}:device_record`);
    expect(call?.entityId).toBe(DEVICE_UUID);
  });

  it('record fetch respects the resolve timeout budget (not getAtom default)', async () => {
    const cache = makeCache({ get: () => '42' });
    const record = makeRecord();
    getAtomMock.mockResolvedValue(record);
    const enq: EnqueueRenderRequest = vi.fn(async () => true);
    const service = new DeviceRecordService(cache, enq);

    const result = await service.resolveDevice({ mac: 'AA:BB:CC:DD:EE:FF' }, { jobId: 'j', timeoutS: 30 });
    expect(result).toBe(record);
    const passedTimeout = getAtomMock.mock.calls[0]?.[0].timeoutS;
    expect(passedTimeout).toBeDefined();
    expect(passedTimeout!).toBeGreaterThanOrEqual(28);
    expect(passedTimeout!).toBeLessThanOrEqual(30);
  });

  it('falls through to next kind when pointer is missing', async () => {
    const cache = makeCache({
      get: (key) => (key === 'device:lookup:serial:xyz' ? DEVICE_UUID : null),
    });
    const record = makeRecord();
    getAtomMock.mockResolvedValue(record);
    const enq: EnqueueRenderRequest = vi.fn(async () => true);
    const service = new DeviceRecordService(cache, enq);

    const result = await service.resolveDevice({ mac: 'AA:BB:CC:DD:EE:FF', serial: 'XYZ' }, { jobId: 'j' });
    expect(result).toBe(record);
  });

  it('returns UNKNOWN with no usable identifiers', async () => {
    const cache = makeCache();
    const enq: EnqueueRenderRequest = vi.fn(async () => false);
    const service = new DeviceRecordService(cache, enq);
    const result = await service.resolveDevice({}, { jobId: 'j' });
    expect(result).toBe(ResolveOutcome.UNKNOWN);
  });

  it('skips identifier kinds outside IDENTIFIER_KINDS', async () => {
    const cache = makeCache();
    const enq: EnqueueRenderRequest = vi.fn(async () => false);
    const service = new DeviceRecordService(cache, enq);
    const result = await service.resolveDevice({ vlan: '100' }, { jobId: 'j' });
    expect(result).toBe(ResolveOutcome.UNKNOWN);
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('ignores empty/whitespace pointer values', async () => {
    const cache = makeCache({ get: () => '   ' });
    const enq: EnqueueRenderRequest = vi.fn(async () => false);
    const service = new DeviceRecordService(cache, enq);
    const result = await service.resolveDevice({ mac: 'aa:bb:cc:dd:ee:ff' }, { jobId: 'j' });
    expect(result).toBe(ResolveOutcome.UNKNOWN);
  });

  it('pointer hit but missing atom returns KNOWN_RECORD_MISSING', async () => {
    const cache = makeCache({ get: () => '42' });
    getAtomMock.mockResolvedValue(null);
    const enq: EnqueueRenderRequest = vi.fn(async () => true);
    const service = new DeviceRecordService(cache, enq);
    const result = await service.resolveDevice({ mac: 'aa:bb:cc:dd:ee:ff' }, { jobId: 'j' });
    expect(result).toBe(ResolveOutcome.KNOWN_RECORD_MISSING);
  });

  it('placeholder identifiers are excluded from pointer lookups and the render bundle', async () => {
    const cache = makeCache();
    const enq: EnqueueRenderRequest = vi.fn(async () => false);
    const service = new DeviceRecordService(cache, enq);
    await service.resolveDevice(
      { mac: 'aa:bb:cc:dd:ee:ff', serial: 'To Be Filled By O.E.M.', board_serial: '00000000' },
      { jobId: 'j' },
    );
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(cache.get).toHaveBeenCalledWith('device:lookup:mac:aa-bb-cc-dd-ee-ff', 'j');
    const enqCall = (enq as Mock<(...args: any[]) => any>).mock.calls[0][0];
    expect(enqCall.params.identifiers).toEqual({ mac: 'aa:bb:cc:dd:ee:ff' });
  });

  it('returns UNKNOWN when all identifiers are placeholders', async () => {
    const cache = makeCache();
    const enq: EnqueueRenderRequest = vi.fn(async () => false);
    const service = new DeviceRecordService(cache, enq);
    const result = await service.resolveDevice(
      { serial: 'Default string', manufacturer: 'System Manufacturer' },
      { jobId: 'j' },
    );
    expect(result).toBe(ResolveOutcome.UNKNOWN);
    expect(cache.get).not.toHaveBeenCalled();
  });
});

describe('resolveDevice: render-on-miss', () => {
  it('sends render request and polls until pointer appears', async () => {
    const responses: Array<string | null> = [null, null, DEVICE_UUID];
    const cache = makeCache({ get: () => (responses.length > 0 ? responses.shift()! : null) });
    const record = makeRecord();
    getAtomMock.mockResolvedValue(record);
    const enq: EnqueueRenderRequest = vi.fn(async () => true);
    const service = new DeviceRecordService(cache, enq);

    const result = await service.resolveDevice(
      { mac: 'aa:bb:cc:dd:ee:ff' },
      { buildarch: 'amd64', jobId: 'j', timeoutS: 5, pollIntervalS: 0 },
    );
    expect(result).toBe(record);
    const enqCall = (enq as Mock<(...args: any[]) => any>).mock.calls[0][0];
    expect(enqCall.params.identifiers).toEqual({ mac: 'aa:bb:cc:dd:ee:ff' });
    expect(enqCall.params.buildarch).toBe('amd64');
    expect(enqCall.domain).toBe('device_record');
  });

  it('merges non-identifier render facts into the identifier bundle (empty values dropped)', async () => {
    const responses: Array<string | null> = [null, null, DEVICE_UUID];
    const cache = makeCache({ get: () => (responses.length > 0 ? responses.shift()! : null) });
    getAtomMock.mockResolvedValue(makeRecord());
    const enq: EnqueueRenderRequest = vi.fn(async () => true);
    const service = new DeviceRecordService(cache, enq);

    await service.resolveDevice(
      { mac: 'aa:bb:cc:dd:ee:ff' },
      {
        buildarch: 'amd64',
        jobId: 'j',
        timeoutS: 5,
        pollIntervalS: 0,
        renderFacts: { ip: '10.0.0.5', ipmi_ip: '10.0.0.9', manufacturer: 'Dell', serial: '' },
      },
    );

    const enqCall = (enq as Mock<(...args: any[]) => any>).mock.calls[0][0];
    expect(enqCall.params.identifiers).toEqual({
      mac: 'aa:bb:cc:dd:ee:ff',
      ip: '10.0.0.5',
      ipmi_ip: '10.0.0.9',
      manufacturer: 'Dell',
    });
  });

  it('returns UNKNOWN when render enqueue fails', async () => {
    const cache = makeCache();
    const enq: EnqueueRenderRequest = vi.fn(async () => false);
    const service = new DeviceRecordService(cache, enq);
    const result = await service.resolveDevice({ mac: 'aa:bb:cc:dd:ee:ff' }, { jobId: 'j' });
    expect(result).toBe(ResolveOutcome.UNKNOWN);
  });

  it('returns UNKNOWN when polling times out', async () => {
    const ticks = [0, 500, 1000, 1500, 2000, 2500, 999_000, 999_000, 999_000];
    let i = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (i < ticks.length ? ticks[i++] : 999_000));

    const cache = makeCache();
    const enq: EnqueueRenderRequest = vi.fn(async () => true);
    const service = new DeviceRecordService(cache, enq);

    const result = await service.resolveDevice(
      { mac: 'aa:bb:cc:dd:ee:ff' },
      { jobId: 'j', timeoutS: 5, pollIntervalS: 0 },
    );
    expect(result).toBe(ResolveOutcome.UNKNOWN);
  });
});

describe('isPlaceholder', () => {
  it('real device is not a placeholder', () => {
    expect(isPlaceholder(makeRecord(DEVICE_UUID, false))).toBe(false);
  });

  it('placeholder flag true', () => {
    expect(isPlaceholder(makeRecord('44444444-4444-4444-4444-444444444444', true))).toBe(true);
  });
});
