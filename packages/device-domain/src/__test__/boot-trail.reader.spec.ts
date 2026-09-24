import { JobType, LifecycleJobPhase, ServerLifecycleStatus } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BootTrailReader, parseChainHit, UNREADABLE, type BootTrailInput } from '../boot-trail.reader';

const DEVICE = '22222222-2222-2222-2222-222222222222';
const ZONE = '11111111-1111-1111-1111-111111111111';
const MAC = '3c:ec:ef:1a:2b:3c';

type Reply = [Error | null, unknown];

function fakeRedis(probes: Reply[] | Error, replies: Reply[] | Error) {
  const keys: string[] = [];
  const execs: Array<Reply[] | Error> = [probes, replies];
  const chain = {
    hgetall: (key: string) => {
      keys.push(key);
      return chain;
    },
    get: (key: string) => {
      keys.push(key);
      return chain;
    },
    exists: (key: string) => {
      keys.push(key);
      return chain;
    },
    exec: async () => {
      const batch = execs.shift() ?? replies;
      if (batch instanceof Error) throw batch;
      return batch;
    },
  };
  return { redis: { pipeline: () => chain }, keys };
}

const input = (over: Partial<BootTrailInput> = {}): BootTrailInput => ({
  deviceId: DEVICE,
  zoneId: ZONE,
  lifecycleStatus: ServerLifecycleStatus.INVENTORY,
  statusChangedAt: new Date('2026-09-16T11:00:00.000Z'),
  ...over,
});

function setup(opts: {
  probes?: Reply[] | Error;
  replies?: Reply[] | Error;
  interfaces?: Array<{ name: string; macAddress: string | null; mgmtOnly: boolean; ipAddresses: Array<{ address: string }> }>;
  job?: { createdAt: Date } | null;
}) {
  const interfaces = opts.interfaces ?? [
    { name: 'eth0', macAddress: '3C:EC:EF:1A:2B:3C', mgmtOnly: false, ipAddresses: [] },
    { name: 'eth1', macAddress: '3c:ec:ef:1a:2b:3d', mgmtOnly: false, ipAddresses: [{ address: '10.0.0.5' }] },
    { name: 'ipmi0', macAddress: '3c:ec:ef:1a:2b:00', mgmtOnly: true, ipAddresses: [] },
  ];
  const prisma = {
    interface: { findMany: vi.fn().mockResolvedValue(interfaces) },
    lifecycleJob: { findFirst: vi.fn().mockResolvedValue(opts.job ?? null) },
  };
  const { redis, keys } = fakeRedis(
    opts.probes ?? [
      [null, 0],
      [null, 0],
      [null, 1],
      [null, 0],
    ],
    opts.replies ?? [
      [null, {}],
      [null, null],
      [null, 0],
    ],
  );
  const reader = new BootTrailReader(redis, prisma);
  return { reader, prisma, keys };
}

describe('BootTrailReader.read', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-09-16T12:00:00.000Z') }));
  afterEach(() => vi.useRealTimers());

  it('reads the three markers by exact key and reports an offered request with a chain hit', async () => {
    const { reader, keys } = setup({
      replies: [
        [null, { outcome: 'offered', at: '1789560131000' }],
        [null, JSON.stringify({ atMs: 1789560139000, deviceId: DEVICE })],
        [null, 0],
      ],
    });
    const out = await reader.read(input());
    expect(keys.slice(-3)).toEqual([
      `${ZONE}:dhcp:pxe:${MAC}`,
      `${ZONE}:ipxe:chain:${MAC}`,
      `${ZONE}:discovery:pending:${MAC}`,
    ]);
    expect(out.pxeMac).toBe(MAC);
    expect(out.candidateMacs).toEqual(['3c:ec:ef:1a:2b:3d']);
    expect(out.zoneId).toBe(ZONE);
    expect(out.readAt).toBe('2026-09-16T12:00:00.000Z');
    expect(out.trail).toEqual({
      pxe: { outcome: 'offered', atMs: 1789560131000 },
      chainReached: true,
      chainAtMs: 1789560139000,
      chainDeviceMismatch: false,
      readError: null,
    });
  });

  it('chooses the addressed interface over an earlier one without an address', async () => {
    const { reader } = setup({
      probes: [
        [null, 0],
        [null, 0],
        [null, 0],
        [null, 0],
      ],
    });
    const out = await reader.read(input());
    expect(out).toMatchObject({ pxeMac: '3c:ec:ef:1a:2b:3d', pxeInterface: 'eth1', pxeMacSource: 'address' });
    expect(out.candidateMacs).toEqual([MAC]);
  });

  it('promotes the candidate the bridge recorded a marker for', async () => {
    const { reader, keys } = setup({
      probes: [
        [null, 0],
        [null, 0],
        [null, 1],
        [null, 0],
      ],
    });
    const out = await reader.read(input());
    expect(out).toMatchObject({ pxeMac: MAC, pxeInterface: 'eth0', pxeMacSource: 'marker' });
    expect(keys.slice(0, 4)).toEqual([
      `${ZONE}:dhcp:pxe:3c:ec:ef:1a:2b:3d`,
      `${ZONE}:ipxe:chain:3c:ec:ef:1a:2b:3d`,
      `${ZONE}:dhcp:pxe:${MAC}`,
      `${ZONE}:ipxe:chain:${MAC}`,
    ]);
  });

  it('falls back to name order when no interface has an address or a marker', async () => {
    const interfaces = [
      { name: 'eth0', macAddress: MAC, mgmtOnly: false, ipAddresses: [] },
      { name: 'eth1', macAddress: '3c:ec:ef:1a:2b:3d', mgmtOnly: false, ipAddresses: [] },
    ];
    const { reader } = setup({
      interfaces,
      probes: [
        [null, 0],
        [null, 0],
        [null, 0],
        [null, 0],
      ],
    });
    const out = await reader.read(input());
    expect(out).toMatchObject({ pxeMac: MAC, pxeInterface: 'eth0', pxeMacSource: 'name-order' });
  });

  it('reports both choice fields null when the device has no data mac', async () => {
    const { reader } = setup({ interfaces: [{ name: 'ipmi0', macAddress: MAC, mgmtOnly: true, ipAddresses: [] }] });
    const out = await reader.read(input());
    expect(out).toMatchObject({ pxeMac: null, pxeInterface: null, pxeMacSource: null });
  });

  it('reports absent markers as null, not false', async () => {
    const { reader } = setup({});
    const out = await reader.read(input());
    expect(out.trail).toEqual({
      pxe: null,
      chainReached: false,
      chainAtMs: null,
      chainDeviceMismatch: false,
      readError: null,
    });
  });

  it('counts a pending discovery marker as a chain hit without a time', async () => {
    const { reader } = setup({
      replies: [
        [null, {}],
        [null, null],
        [null, 1],
      ],
    });
    const out = await reader.read(input());
    expect(out.trail.chainReached).toBe(true);
    expect(out.trail.chainAtMs).toBeNull();
  });

  it('reports a redis failure as readError with unknown booleans', async () => {
    const { reader } = setup({ replies: new Error('ECONNREFUSED') });
    const out = await reader.read(input());
    expect(out.trail.readError).toContain('ECONNREFUSED');
    expect(out.trail.pxe).toBeNull();
    expect(out.trail.chainReached).toBeNull();
  });

  it('falls back to the tier and reports the outage when the marker probe fails too', async () => {
    const { reader } = setup({ probes: new Error('ECONNREFUSED'), replies: new Error('ECONNREFUSED') });
    const out = await reader.read(input());
    expect(out).toMatchObject({ pxeMac: '3c:ec:ef:1a:2b:3d', pxeInterface: 'eth1', pxeMacSource: 'address' });
    expect(out.trail.readError).toContain('ECONNREFUSED');
  });

  it('reports a failed pipeline reply as readError', async () => {
    const { reader } = setup({
      replies: [
        [new Error('WRONGTYPE'), null],
        [null, null],
        [null, 0],
      ],
    });
    const out = await reader.read(input());
    expect(out.trail).toEqual(UNREADABLE('WRONGTYPE'));
  });

  it('reports a device with no data mac as unreadable and reads no marker', async () => {
    const { reader, keys } = setup({
      interfaces: [{ name: 'ipmi0', macAddress: '3c:ec:ef:1a:2b:00', mgmtOnly: true, ipAddresses: [] }],
    });
    const out = await reader.read(input());
    expect(out.pxeMac).toBeNull();
    expect(out.zoneId).toBeNull();
    expect(out.trail.readError).toBe('no data interface with a MAC');
    expect(keys).toEqual([]);
  });

  it('reports a device without a zone as unreadable and reads no marker', async () => {
    const { reader, keys } = setup({});
    const out = await reader.read(input({ zoneId: null }));
    expect(out).toMatchObject({ pxeMac: '3c:ec:ef:1a:2b:3d', pxeInterface: 'eth1', pxeMacSource: 'address' });
    expect(out.zoneId).toBeNull();
    expect(out.trail.readError).toBe('device is not assigned to a zone');
    expect(keys).toEqual([]);
  });

  it('flags a chain hit that names another device', async () => {
    const { reader } = setup({
      replies: [
        [null, {}],
        [null, JSON.stringify({ atMs: 1789560139000, deviceId: 'other' })],
        [null, 0],
      ],
    });
    const out = await reader.read(input());
    expect(out.trail.chainDeviceMismatch).toBe(true);
    expect(out.trail.chainReached).toBe(true);
  });

  it('derives bootExpected from the newest network-boot job', async () => {
    const { reader, prisma } = setup({ job: { createdAt: new Date('2026-09-16T11:50:00.000Z') } });
    const out = await reader.read(input());
    expect(out.bootExpected).toEqual({ expected: true, since: '2026-09-16T11:50:00.000Z', reason: 'active-job' });
    expect(prisma.lifecycleJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deviceId: DEVICE,
          jobType: { in: [JobType.Provision, JobType.Reprovision, JobType.Deprovision] },
          phase: { notIn: [LifecycleJobPhase.COMPLETED, LifecycleJobPhase.FAILED, LifecycleJobPhase.ABORTED] },
        }),
      }),
    );
  });

  it('derives bootExpected from a provisioning status when no job is open', async () => {
    const { reader } = setup({});
    const out = await reader.read(input({ lifecycleStatus: ServerLifecycleStatus.PROVISIONING }));
    expect(out.bootExpected).toEqual({
      expected: true,
      since: '2026-09-16T11:00:00.000Z',
      reason: 'provisioning-status',
    });
  });

  it('expects no boot for an inventory device without a job', async () => {
    const { reader } = setup({});
    const out = await reader.read(input());
    expect(out.bootExpected).toEqual({ expected: false, since: null, reason: 'none' });
  });
});

describe('parseChainHit', () => {
  it('returns the parsed hit', () => {
    expect(parseChainHit(JSON.stringify({ atMs: 1789560139000, deviceId: DEVICE }))).toEqual({
      atMs: 1789560139000,
      deviceId: DEVICE,
    });
  });

  it('returns null for malformed json and for a value the schema rejects', () => {
    expect(parseChainHit('{not json')).toBeNull();
    expect(parseChainHit(JSON.stringify({ atMs: 'soon' }))).toBeNull();
  });
});
