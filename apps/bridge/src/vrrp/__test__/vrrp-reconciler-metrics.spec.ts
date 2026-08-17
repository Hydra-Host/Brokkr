import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecordingMeterFake } from '../../__test__/telemetry-meter-fake';
import { type CommandResult } from '../../common/process/run-command';
import type { RedisService } from '../../common/redis/redis.service';
import { ContextLogger } from '../../logger/logger.service';
import { VrrpReconcilerService, type RunCommand } from '../vrrp-reconciler.service';

const holder = vi.hoisted((): { fake: RecordingMeterFake | null } => ({ fake: null }));

vi.mock('@repo/telemetry', async () => {
  const { createRecordingMeterFake } = await import('../../__test__/telemetry-meter-fake');
  const fake = createRecordingMeterFake();
  holder.fake = fake;
  return {
    getTelemetryMeter: () => fake.meter,
    emitTelemetryLog: vi.fn(),
    getBullMqTelemetry: () => undefined,
    isTelemetryEnabled: () => false,
    enrichActiveSpan: vi.fn(),
  };
});

let telemetryFake: RecordingMeterFake;

const VIP_EVENTS = 'brokkr.vrrp.vip_events';
const RECONCILE_ABORTS = 'brokkr.vrrp.reconcile_aborts';
const BOUND_VIPS = 'brokkr.vrrp.bound_vips';

const VIP_A = '10.0.0.5/24';
const VIP_B = '192.168.1.5/24';
const IFACE_A = 'eth0';
const IFACE_B = 'eth1';
const VRRP_LABEL = 'brokkr-vrrp';
const SELF_INSTANCE_ID = 'bridge-a';

function envelope(value: unknown): string {
  return JSON.stringify({ status: 'ok', value, written_at: 1, request_id: null });
}

function ipShowJson(bound: Array<{ iface: string; vip: string }>): string {
  const byIface = new Map<string, string[]>();
  for (const b of bound) {
    const list = byIface.get(b.iface) ?? [];
    list.push(b.vip);
    byIface.set(b.iface, list);
  }
  const interfaces = [...byIface.entries()].map(([ifname, vips]) => ({
    ifname,
    addr_info: vips.map((vip) => {
      const [local, prefixlenStr] = vip.split('/');
      return { local, prefixlen: Number(prefixlenStr), label: VRRP_LABEL };
    }),
  }));
  return JSON.stringify(interfaces);
}

function ok(stdout = ''): CommandResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function buildHarness(opts: {
  runCommandImpl?: RunCommand;
  scanKeys?: string[];
  atoms?: Record<string, { vip: string; ifaceByBridge: Record<string, string> }>;
}) {
  const atoms = opts.atoms ?? {};
  const scan = vi.fn().mockResolvedValue(opts.scanKeys ?? []);
  const get = vi.fn().mockImplementation(async (key: string) => {
    const value = atoms[key];
    return value ? envelope(value) : null;
  });
  const redis = { scan, get, delete: vi.fn().mockResolvedValue(0) };

  let leader = true;
  const runCommand = vi.fn(opts.runCommandImpl ?? (async () => ok()));
  const service = new VrrpReconcilerService(
    () => leader,
    redis as unknown as RedisService,
    new ContextLogger(),
    'test',
    SELF_INSTANCE_ID,
    runCommand as unknown as RunCommand,
  );
  return { service, redis, setLeader: (value: boolean) => (leader = value) };
}

function atom(vip: string, iface: string) {
  return { vip, ifaceByBridge: { [SELF_INSTANCE_ID]: iface } };
}

describe('VrrpReconcilerService telemetry', () => {
  beforeEach(() => {
    const fake = holder.fake;
    if (fake === null) throw new Error('@repo/telemetry mock did not install the meter fake');
    telemetryFake = fake;
    telemetryFake.reset();
  });

  it('counts a bind and reports the bound count after a converged leader tick', async () => {
    const { service } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A) },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([])) : ok()),
    });

    await service.reconcileOnce();

    expect(telemetryFake.counters[VIP_EVENTS]).toEqual([{ value: 1, attrs: { action: 'bind' } }]);
    expect(telemetryFake.counters[RECONCILE_ABORTS]).toBeUndefined();
    expect(await telemetryFake.collect(BOUND_VIPS)).toEqual([{ value: 1, attrs: undefined }]);
  });

  it('reports only the VIPs that actually bound when one bind fails', async () => {
    const { service } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp', 'prefix:p2:config:vrrp'],
      atoms: {
        'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A),
        'prefix:p2:config:vrrp': atom(VIP_B, IFACE_B),
      },
      runCommandImpl: async (cmd) => {
        if (cmd[1] === '-j') return ok(ipShowJson([]));
        if (cmd[2] === 'add' && cmd[3] === VIP_B) throw new Error('RTNETLINK answers: operation not permitted');
        return ok();
      },
    });

    await service.reconcileOnce();

    expect(telemetryFake.counters[VIP_EVENTS]).toEqual([{ value: 1, attrs: { action: 'bind' } }]);
    expect(await telemetryFake.collect(BOUND_VIPS)).toEqual([{ value: 1, attrs: undefined }]);
  });

  it('keeps a VIP counted in the gauge when its release fails', async () => {
    const { service, setLeader } = buildHarness({
      runCommandImpl: async (cmd) => {
        if (cmd[1] === '-j') return ok(ipShowJson([{ iface: IFACE_A, vip: VIP_A }]));
        throw new Error('RTNETLINK answers: operation not permitted');
      },
    });
    setLeader(false);

    await service.reconcileOnce();

    expect(telemetryFake.counters[VIP_EVENTS]).toBeUndefined();
    expect(await telemetryFake.collect(BOUND_VIPS)).toEqual([{ value: 1, attrs: undefined }]);
  });

  it('an already-converged tick emits no vip events but still reports the bound count', async () => {
    const { service } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A) },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([{ iface: IFACE_A, vip: VIP_A }])) : ok()),
    });

    await service.reconcileOnce();

    expect(telemetryFake.counters[VIP_EVENTS]).toBeUndefined();
    expect(await telemetryFake.collect(BOUND_VIPS)).toEqual([{ value: 1, attrs: undefined }]);
  });

  it('counts releases and zeroes the gauge when a non-leader sheds its VIPs', async () => {
    const { service, setLeader } = buildHarness({
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([{ iface: IFACE_A, vip: VIP_A }])) : ok()),
    });
    setLeader(false);

    await service.reconcileOnce();

    expect(telemetryFake.counters[VIP_EVENTS]).toEqual([{ value: 1, attrs: { action: 'release' } }]);
    expect(await telemetryFake.collect(BOUND_VIPS)).toEqual([{ value: 0, attrs: undefined }]);
  });

  it('counts an abort when the interface-state read fails and applies nothing', async () => {
    const { service } = buildHarness({
      runCommandImpl: async (cmd) => {
        if (cmd[1] === '-j') throw new Error('ip blipped');
        return ok();
      },
    });

    await service.reconcileOnce();

    expect(telemetryFake.counters[RECONCILE_ABORTS]).toEqual([{ value: 1, attrs: { reason: 'read_bindings' } }]);
    expect(telemetryFake.counters[VIP_EVENTS]).toBeUndefined();
  });

  it('counts an abort on a Redis SCAN blip while keeping the observed bound count', async () => {
    const { service, redis } = buildHarness({
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([{ iface: IFACE_A, vip: VIP_A }])) : ok()),
    });
    redis.scan.mockRejectedValue(new Error('redis down'));

    await service.reconcileOnce();

    expect(telemetryFake.counters[RECONCILE_ABORTS]).toEqual([{ value: 1, attrs: { reason: 'compute_desired' } }]);
    expect(telemetryFake.counters[VIP_EVENTS]).toBeUndefined();
    expect(await telemetryFake.collect(BOUND_VIPS)).toEqual([{ value: 1, attrs: undefined }]);
  });

  it('detachAll counts a release per VIP and zeroes the gauge', async () => {
    const { service } = buildHarness({
      runCommandImpl: async (cmd) =>
        cmd[1] === '-j'
          ? ok(
              ipShowJson([
                { iface: IFACE_A, vip: VIP_A },
                { iface: IFACE_B, vip: VIP_B },
              ]),
            )
          : ok(),
    });

    await service.detachAll();

    expect(telemetryFake.counters[VIP_EVENTS]).toEqual([
      { value: 1, attrs: { action: 'release' } },
      { value: 1, attrs: { action: 'release' } },
    ]);
    expect(await telemetryFake.collect(BOUND_VIPS)).toEqual([{ value: 0, attrs: undefined }]);
  });
});
