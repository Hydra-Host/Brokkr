import { describe, expect, it, vi } from 'vitest';

import { CommandFailed, type CommandResult } from '../../common/process/run-command';
import type { RedisService } from '../../common/redis/redis.service';
import { ContextLogger } from '../../logger/logger.service';
import { VrrpReconcilerService, type RunCommand } from '../vrrp-reconciler.service';

const VIP_A = '10.0.0.5/24';
const VIP_B = '192.168.1.5/24';
const IFACE_A = 'eth0';
const IFACE_B = 'eth1';

const VRRP_LABEL = 'brokkr-vrrp';

function envelope(value: unknown): string {
  return JSON.stringify({ status: 'ok', value, written_at: 1, request_id: null });
}

function ipShowJson(bound: Array<{ iface: string; vip: string; labeled?: boolean }>): string {
  const byIface = new Map<string, Array<{ iface: string; vip: string; labeled?: boolean }>>();
  for (const b of bound) {
    const list = byIface.get(b.iface) ?? [];
    list.push(b);
    byIface.set(b.iface, list);
  }
  const interfaces = [...byIface.entries()].map(([ifname, entries]) => ({
    ifname,
    addr_info: entries.map((e) => {
      const [local, prefixlenStr] = e.vip.split('/');
      return {
        local,
        prefixlen: Number(prefixlenStr),
        ...(e.labeled === false ? {} : { label: VRRP_LABEL }),
      };
    }),
  }));
  return JSON.stringify(interfaces);
}

function ok(stdout = ''): CommandResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function fail(stderr: string): CommandFailed {
  return new CommandFailed(['ip'], 1, '', stderr);
}

interface Harness {
  service: VrrpReconcilerService;
  runCommand: ReturnType<typeof vi.fn>;
  redis: { scan: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  setLeader: (value: boolean) => void;
}

const SELF_INSTANCE_ID = 'bridge-a';

function buildHarness(opts: {
  runCommandImpl?: RunCommand;
  scanKeys?: string[];
  atoms?: Record<string, { vip: string; ifaceByBridge: Record<string, string>; garpCount?: number }>;
  selfInstanceId?: string;
}): Harness {
  const scanKeys = opts.scanKeys ?? [];
  const atoms = opts.atoms ?? {};
  const selfInstanceId = opts.selfInstanceId ?? SELF_INSTANCE_ID;
  const scan = vi.fn().mockResolvedValue(scanKeys);
  const get = vi.fn().mockImplementation(async (key: string) => {
    const value = atoms[key];
    return value ? envelope(value) : null;
  });
  const del = vi.fn().mockResolvedValue(0);
  const redis = { scan, get, delete: del };

  let leader = true;
  const isLeader = () => leader;

  const runCommand = vi.fn(opts.runCommandImpl ?? (async () => ok()));

  const service = new VrrpReconcilerService(
    isLeader,
    redis as unknown as RedisService,
    new ContextLogger(),
    'test',
    selfInstanceId,
    runCommand as unknown as RunCommand,
  );

  return { service, runCommand, redis, setLeader: (v) => (leader = v) };
}

function atom(vip: string, iface: string, instanceId: string = SELF_INSTANCE_ID, garpCount?: number) {
  return { vip, ifaceByBridge: { [instanceId]: iface }, ...(garpCount === undefined ? {} : { garpCount }) };
}

describe('VrrpReconcilerService.reconcileOnce — attach/detach/noop matrix', () => {
  it('attaches when leader and the VIP is not present: ip addr add + arping with correct args', async () => {
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A) },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([])) : ok()),
    });

    await service.reconcileOnce();

    const addCall = runCommand.mock.calls.find((c) => c[0][0] === 'ip' && c[0][1] === 'addr' && c[0][2] === 'add');
    expect(addCall).toBeDefined();
    expect(addCall![0]).toEqual(['ip', 'addr', 'add', VIP_A, 'dev', IFACE_A, 'label', VRRP_LABEL]);

    const garpCall = runCommand.mock.calls.find((c) => c[0][0] === 'arping');
    expect(garpCall).toBeDefined();
    expect(garpCall![0]).toEqual(['arping', '-U', '-c', '5', '-I', IFACE_A, '10.0.0.5']);
  });

  it('detaches when not leader and the VIP is present', async () => {
    const { service, runCommand, setLeader } = buildHarness({
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([{ iface: IFACE_A, vip: VIP_A }])) : ok()),
    });
    setLeader(false);

    await service.reconcileOnce();

    const delCall = runCommand.mock.calls.find((c) => c[0][0] === 'ip' && c[0][1] === 'addr' && c[0][2] === 'del');
    expect(delCall).toBeDefined();
    expect(delCall![0]).toEqual(['ip', 'addr', 'del', VIP_A, 'dev', IFACE_A]);
  });

  it('is a true no-op when leader and already present: no ip addr add, no GARP', async () => {
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A) },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([{ iface: IFACE_A, vip: VIP_A }])) : ok()),
    });

    await service.reconcileOnce();

    expect(runCommand.mock.calls.some((c) => c[0][0] === 'ip' && c[0][2] === 'add')).toBe(false);
    expect(runCommand.mock.calls.some((c) => c[0][0] === 'arping')).toBe(false);
  });

  it('is a no-op when not leader and nothing is present', async () => {
    const { service, runCommand, setLeader } = buildHarness({
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([])) : ok()),
    });
    setLeader(false);

    await service.reconcileOnce();

    expect(runCommand.mock.calls.some((c) => c[0][0] === 'ip' && (c[0][2] === 'add' || c[0][2] === 'del'))).toBe(false);
  });
});

describe('VrrpReconcilerService — idempotent error handling', () => {
  it('refuses (no GARP, error) when "File exists" is a foreign/unlabeled address, not one of ours', async () => {
    const errorSpy = vi.spyOn(ContextLogger.prototype, 'error');
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A) },
      runCommandImpl: async (cmd) => {
        if (cmd[1] === '-j') return ok(ipShowJson([]));
        if (cmd[2] === 'add') throw fail('RTNETLINK answers: File exists');
        return ok();
      },
    });

    await expect(service.reconcileOnce()).resolves.toBeUndefined();
    expect(runCommand.mock.calls.some((c) => c[0][0] === 'arping')).toBe(false);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('without the'))).toBe(true);
    errorSpy.mockRestore();
  });

  it('treats "File exists" as our own binding (GARP) when the vip is labeled on another iface (iface-move)', async () => {
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A) },
      runCommandImpl: async (cmd) => {
        if (cmd[1] === '-j') return ok(ipShowJson([{ iface: IFACE_B, vip: VIP_A }]));
        if (cmd[2] === 'add') throw fail('RTNETLINK answers: File exists');
        return ok();
      },
    });

    await service.reconcileOnce();

    expect(runCommand.mock.calls.some((c) => c[0][0] === 'arping')).toBe(true);
    const delCall = runCommand.mock.calls.find((c) => c[0][0] === 'ip' && c[0][2] === 'del');
    expect(delCall![0]).toEqual(['ip', 'addr', 'del', VIP_A, 'dev', IFACE_B]);
  });

  it('treats "Cannot assign requested address" on del as idempotent success (no error thrown)', async () => {
    const { service, setLeader } = buildHarness({
      runCommandImpl: async (cmd) => {
        if (cmd[1] === '-j') return ok(ipShowJson([{ iface: IFACE_A, vip: VIP_A }]));
        if (cmd[2] === 'del') throw fail('RTNETLINK answers: Cannot assign requested address');
        return ok();
      },
    });
    setLeader(false);

    await expect(service.reconcileOnce()).resolves.toBeUndefined();
  });

  it('treats "Cannot find device" on del as a real failure (no longer swallowed as idempotent)', async () => {
    const { service, setLeader } = buildHarness({
      runCommandImpl: async (cmd) => {
        if (cmd[1] === '-j') return ok(ipShowJson([{ iface: IFACE_A, vip: VIP_A }]));
        if (cmd[2] === 'del') throw fail('Cannot find device "eth0"');
        return ok();
      },
    });
    setLeader(false);

    await expect(service.reconcileOnce()).resolves.toBeUndefined();
  });

  it('a genuine (non-idempotent) add failure is logged and does not throw, and skips GARP', async () => {
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A) },
      runCommandImpl: async (cmd) => {
        if (cmd[1] === '-j') return ok(ipShowJson([]));
        if (cmd[2] === 'add') throw fail('Cannot find device "eth0"');
        return ok();
      },
    });

    await expect(service.reconcileOnce()).resolves.toBeUndefined();
    expect(runCommand.mock.calls.some((c) => c[0][0] === 'arping')).toBe(false);
  });
});

describe('VrrpReconcilerService — multiple bindings converge independently', () => {
  it('binds one VIP successfully even when another VIP fails', async () => {
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp', 'prefix:p2:config:vrrp'],
      atoms: {
        'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A),
        'prefix:p2:config:vrrp': atom(VIP_B, IFACE_B),
      },
      runCommandImpl: async (cmd) => {
        if (cmd[1] === '-j') return ok(ipShowJson([]));
        if (cmd[2] === 'add' && cmd[3] === VIP_A) throw fail('some transient failure');
        return ok();
      },
    });

    await service.reconcileOnce();

    const addCalls = runCommand.mock.calls.filter((c) => c[0][0] === 'ip' && c[0][2] === 'add');
    expect(addCalls).toHaveLength(2);
    const garpCalls = runCommand.mock.calls.filter((c) => c[0][0] === 'arping');
    expect(garpCalls).toHaveLength(1);
    expect(garpCalls[0][0]).toContain(IFACE_B);
  });

  it('releases a VIP no longer desired while leaving a still-desired one bound', async () => {
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A) },
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

    await service.reconcileOnce();

    const delCalls = runCommand.mock.calls.filter((c) => c[0][0] === 'ip' && c[0][2] === 'del');
    expect(delCalls).toHaveLength(1);
    expect(delCalls[0][0]).toEqual(['ip', 'addr', 'del', VIP_B, 'dev', IFACE_B]);
  });
});

describe('VrrpReconcilerService — iface-change release', () => {
  it('releases the old iface binding when a VIP moves to a different interface', async () => {
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A) },
      runCommandImpl: async (cmd) => {
        if (cmd[1] === '-j') return ok(ipShowJson([{ iface: IFACE_B, vip: VIP_A }]));
        return ok();
      },
    });

    await service.reconcileOnce();

    const addCalls = runCommand.mock.calls.filter((c) => c[0][0] === 'ip' && c[0][2] === 'add');
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0][0]).toEqual(['ip', 'addr', 'add', VIP_A, 'dev', IFACE_A, 'label', VRRP_LABEL]);

    const delCalls = runCommand.mock.calls.filter((c) => c[0][0] === 'ip' && c[0][2] === 'del');
    expect(delCalls).toHaveLength(1);
    expect(delCalls[0][0]).toEqual(['ip', 'addr', 'del', VIP_A, 'dev', IFACE_B]);
  });
});

describe('VrrpReconcilerService — iface-independent constant label', () => {
  const MAX_LEN_IFACE = 'abcdefghijklmno';
  const VLAN_IFACE = 'enp0s31f6.4094';

  it.each([
    ['max-length (15-char) interface', MAX_LEN_IFACE],
    ['long VLAN interface', VLAN_IFACE],
    ['short interface', IFACE_A],
  ])('binds with the constant label on a %s', async (_desc, iface) => {
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, iface) },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([])) : ok()),
    });

    await service.reconcileOnce();

    const addCall = runCommand.mock.calls.find((c) => c[0][0] === 'ip' && c[0][2] === 'add');
    expect(addCall).toBeDefined();
    expect(addCall![0]).toEqual(['ip', 'addr', 'add', VIP_A, 'dev', iface, 'label', VRRP_LABEL]);
    expect(VRRP_LABEL.length).toBeLessThanOrEqual(15);
  });

  it('recognizes a constant-labeled binding on a max-length iface as already-present (no re-add)', async () => {
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, MAX_LEN_IFACE) },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([{ iface: MAX_LEN_IFACE, vip: VIP_A }])) : ok()),
    });

    await service.reconcileOnce();

    expect(runCommand.mock.calls.some((c) => c[0][0] === 'ip' && c[0][2] === 'add')).toBe(false);
    expect(runCommand.mock.calls.some((c) => c[0][0] === 'arping')).toBe(false);
  });
});

describe('VrrpReconcilerService — GARP count from the atom', () => {
  it("passes the atom's garpCount to arping -c", async () => {
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A, SELF_INSTANCE_ID, 3) },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([])) : ok()),
    });

    await service.reconcileOnce();

    const garpCall = runCommand.mock.calls.find((c) => c[0][0] === 'arping');
    expect(garpCall![0]).toEqual(['arping', '-U', '-c', '3', '-I', IFACE_A, '10.0.0.5']);
  });

  it('defaults to 5 GARPs when the atom omits garpCount', async () => {
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A) },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([])) : ok()),
    });

    await service.reconcileOnce();

    const garpCall = runCommand.mock.calls.find((c) => c[0][0] === 'arping');
    expect(garpCall![0]).toEqual(['arping', '-U', '-c', '5', '-I', IFACE_A, '10.0.0.5']);
  });
});

describe('VrrpReconcilerService — fail-closed reads', () => {
  it('a failed "ip -j addr show" aborts the tick (fail-closed) — no VIPs released or bound', async () => {
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A) },
      runCommandImpl: async (cmd) => {
        if (cmd[1] === '-j') throw new Error('spawn ip ENOENT');
        return ok();
      },
    });

    await expect(service.reconcileOnce()).resolves.toBeUndefined();
    expect(runCommand.mock.calls.some((c) => c[0][0] === 'ip' && (c[0][2] === 'add' || c[0][2] === 'del'))).toBe(false);
  });

  it('a SCAN failure aborts the tick (fail-closed) — no VIPs released or bound', async () => {
    const { service, runCommand, redis } = buildHarness({
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([{ iface: IFACE_A, vip: VIP_A }])) : ok()),
    });
    redis.scan.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.reconcileOnce()).resolves.toBeUndefined();
    expect(runCommand.mock.calls.some((c) => c[0][0] === 'ip' && (c[0][2] === 'add' || c[0][2] === 'del'))).toBe(false);
  });

  it('a matching-key atom GET failure aborts the tick (fail-closed) — leader keeps its VIP', async () => {
    const { service, runCommand, redis } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([{ iface: IFACE_A, vip: VIP_A }])) : ok()),
    });
    redis.get.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.reconcileOnce()).resolves.toBeUndefined();
    expect(runCommand.mock.calls.some((c) => c[0][0] === 'ip' && (c[0][2] === 'add' || c[0][2] === 'del'))).toBe(false);
  });

  it('a non-leader with a failed actual read also aborts — does not release nothing (dual-master guard)', async () => {
    const { service, runCommand, setLeader } = buildHarness({
      runCommandImpl: async (cmd) => {
        if (cmd[1] === '-j') throw new Error('spawn ip ENOENT');
        return ok();
      },
    });
    setLeader(false);

    await expect(service.reconcileOnce()).resolves.toBeUndefined();
    expect(runCommand.mock.calls.some((c) => c[0][0] === 'ip' && c[0][2] === 'del')).toBe(false);
  });

  it('an unexpected non-array "ip -j addr show" shape aborts the tick (fail-closed)', async () => {
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A) },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok('{"unexpected":"object"}') : ok()),
    });

    await expect(service.reconcileOnce()).resolves.toBeUndefined();
    expect(runCommand.mock.calls.some((c) => c[0][0] === 'ip' && (c[0][2] === 'add' || c[0][2] === 'del'))).toBe(false);
  });
});

describe('VrrpReconcilerService — desired-set composition', () => {
  it('ignores an unrecognized-shape key from SCAN without crashing', async () => {
    const { service } = buildHarness({
      scanKeys: ['some:unrelated:key'],
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([])) : ok()),
    });

    await expect(service.reconcileOnce()).resolves.toBeUndefined();
  });
});

describe('VrrpReconcilerService — actual-state label discrimination', () => {
  it('does not treat an unlabeled (base) address as a VRRP VIP to release', async () => {
    const { service, runCommand } = buildHarness({
      runCommandImpl: async (cmd) =>
        cmd[1] === '-j' ? ok(ipShowJson([{ iface: IFACE_A, vip: VIP_A, labeled: false }])) : ok(),
    });

    await service.reconcileOnce();

    expect(runCommand.mock.calls.some((c) => c[0][0] === 'ip' && c[0][2] === 'del')).toBe(false);
  });
});

describe('VrrpReconcilerService — per-bridge iface selection', () => {
  const HETERO_ATOM = {
    vip: VIP_A,
    ifaceByBridge: { 'bridge-a': 'eth-vrrp0', 'bridge-b': 'eth-vrrp1' },
  };

  it("binds on ITS OWN iface (bridge-a → eth-vrrp0), not another bridge's iface", async () => {
    const { service, runCommand } = buildHarness({
      selfInstanceId: 'bridge-a',
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': HETERO_ATOM },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([])) : ok()),
    });

    await service.reconcileOnce();

    const addCall = runCommand.mock.calls.find((c) => c[0][0] === 'ip' && c[0][2] === 'add');
    expect(addCall).toBeDefined();
    expect(addCall![0]).toEqual(['ip', 'addr', 'add', VIP_A, 'dev', 'eth-vrrp0', 'label', VRRP_LABEL]);
    expect(runCommand.mock.calls.some((c) => c[0][0] === 'ip' && c[0][2] === 'add' && c[0][5] === 'eth-vrrp1')).toBe(
      false,
    );
  });

  it('a different bridge (bridge-b) binds the same VIP on eth-vrrp1', async () => {
    const { service, runCommand } = buildHarness({
      selfInstanceId: 'bridge-b',
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': HETERO_ATOM },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([])) : ok()),
    });

    await service.reconcileOnce();

    const addCall = runCommand.mock.calls.find((c) => c[0][0] === 'ip' && c[0][2] === 'add');
    expect(addCall).toBeDefined();
    expect(addCall![0]).toEqual(['ip', 'addr', 'add', VIP_A, 'dev', 'eth-vrrp1', 'label', VRRP_LABEL]);
  });

  it("holds nothing when it is absent from the atom's ifaceByBridge map", async () => {
    const { service, runCommand } = buildHarness({
      selfInstanceId: 'bridge-c',
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, 'eth-vrrp0', 'bridge-a') },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([])) : ok()),
    });

    await service.reconcileOnce();

    expect(runCommand.mock.calls.some((c) => c[0][0] === 'ip' && (c[0][2] === 'add' || c[0][2] === 'del'))).toBe(false);
    expect(runCommand.mock.calls.some((c) => c[0][0] === 'arping')).toBe(false);
  });
});

describe('VrrpReconcilerService — leadership re-check after computeDesired', () => {
  it('a demotion during the SCAN releases held VIPs and binds nothing', async () => {
    const { service, runCommand, redis, setLeader } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A) },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([{ iface: IFACE_A, vip: VIP_A }])) : ok()),
    });
    redis.scan.mockImplementationOnce(async () => {
      setLeader(false);
      return ['prefix:p1:config:vrrp'];
    });

    await service.reconcileOnce();

    expect(runCommand.mock.calls.some((c) => c[0][0] === 'ip' && c[0][2] === 'add')).toBe(false);
    const delCall = runCommand.mock.calls.find((c) => c[0][0] === 'ip' && c[0][2] === 'del');
    expect(delCall?.[0]).toEqual(['ip', 'addr', 'del', VIP_A, 'dev', IFACE_A]);
  });
});

describe('VrrpReconcilerService — GARP timeout scales with count', () => {
  it("passes arping a timeout of the atom's garpCount + buffer so all GARPs can send", async () => {
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A, SELF_INSTANCE_ID, 3) },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([])) : ok()),
    });

    await service.reconcileOnce();

    const garpCall = runCommand.mock.calls.find((c) => c[0][0] === 'arping');
    expect(garpCall).toBeDefined();
    expect(garpCall?.[1]).toBe(5);
  });

  it('scales the timeout with the default count when the atom omits garpCount', async () => {
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A) },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([])) : ok()),
    });

    await service.reconcileOnce();

    const garpCall = runCommand.mock.calls.find((c) => c[0][0] === 'arping');
    expect(garpCall).toBeDefined();
    expect(garpCall?.[1]).toBe(7);
  });
});

describe('VrrpReconcilerService.detachAll', () => {
  it('releases every VIP the daemon currently holds', async () => {
    const { service, runCommand } = buildHarness({
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

    const delCalls = runCommand.mock.calls.filter((c) => c[0][0] === 'ip' && c[0][2] === 'del');
    expect(delCalls).toHaveLength(2);
  });

  it('retries a transient "ip -j addr show" failure so the release still happens (no dup-IP window)', async () => {
    let showCalls = 0;
    const { service, runCommand } = buildHarness({
      runCommandImpl: async (cmd) => {
        if (cmd[1] === '-j') {
          showCalls += 1;
          if (showCalls === 1) throw new Error('spawn ip ETIMEDOUT');
          return ok(ipShowJson([{ iface: IFACE_A, vip: VIP_A }]));
        }
        return ok();
      },
    });

    await service.detachAll();

    const delCalls = runCommand.mock.calls.filter((c) => c[0][0] === 'ip' && c[0][2] === 'del');
    expect(delCalls).toHaveLength(1);
  });

  it('logs an error and releases nothing when the interface read fails persistently on detach', async () => {
    const errorSpy = vi.spyOn(ContextLogger.prototype, 'error').mockResolvedValue(undefined);
    try {
      const { service, runCommand } = buildHarness({
        runCommandImpl: async (cmd) => {
          if (cmd[1] === '-j') throw new Error('spawn ip ENOENT');
          return ok();
        },
      });

      await expect(service.detachAll()).resolves.toBeUndefined();

      expect(runCommand.mock.calls.some((c) => c[0][0] === 'ip' && c[0][2] === 'del')).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Could not read interface state'),
        expect.anything(),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not log an error and does not retry when `ip` is not installed (ENOENT)', async () => {
    const errorSpy = vi.spyOn(ContextLogger.prototype, 'error').mockResolvedValue(undefined);
    const debugSpy = vi.spyOn(ContextLogger.prototype, 'debug').mockResolvedValue(undefined);
    try {
      let showCalls = 0;
      const { service, runCommand } = buildHarness({
        runCommandImpl: async (cmd) => {
          if (cmd[1] === '-j') {
            showCalls += 1;
            throw Object.assign(new Error('spawn ip ENOENT'), { code: 'ENOENT' });
          }
          return ok();
        },
      });

      await expect(service.detachAll()).resolves.toBeUndefined();

      expect(showCalls).toBe(1);
      expect(runCommand.mock.calls.some((c) => c[0][0] === 'ip' && c[0][2] === 'del')).toBe(false);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('`ip` is not installed on this host'),
        expect.anything(),
      );
    } finally {
      errorSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it('still logs an error and retries when the message merely mentions ENOENT but the binary is not actually missing', async () => {
    const errorSpy = vi.spyOn(ContextLogger.prototype, 'error').mockResolvedValue(undefined);
    try {
      let showCalls = 0;
      const { service, runCommand } = buildHarness({
        runCommandImpl: async (cmd) => {
          if (cmd[1] === '-j') {
            showCalls += 1;
            throw new Error('spawn ip ENOENT');
          }
          return ok();
        },
      });

      await expect(service.detachAll()).resolves.toBeUndefined();

      expect(showCalls).toBe(3);
      expect(runCommand.mock.calls.some((c) => c[0][0] === 'ip' && c[0][2] === 'del')).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Could not read interface state'),
        expect.anything(),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('after detachAll, a subsequent reconcileOnce is a no-op (stopped guard)', async () => {
    const { service, runCommand } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A) },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([])) : ok()),
    });

    await service.detachAll();
    runCommand.mockClear();
    await service.reconcileOnce();

    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe('VrrpReconcilerService — leader named in no published atom (drift surfacing)', () => {
  it('warns once per transition when leader and every atom names other bridges', async () => {
    const warnSpy = vi.spyOn(ContextLogger.prototype, 'warning');
    const { service } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A, 'other-bridge') },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([])) : ok()),
    });

    await service.reconcileOnce();
    await service.reconcileOnce();

    const namedWarnings = warnSpy.mock.calls.filter((c) => String(c[0]).includes('named in none'));
    expect(namedWarnings).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it('does not warn when this bridge IS named in a published atom', async () => {
    const warnSpy = vi.spyOn(ContextLogger.prototype, 'warning');
    const { service } = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A) },
      runCommandImpl: async (cmd) => (cmd[1] === '-j' ? ok(ipShowJson([])) : ok()),
    });

    await service.reconcileOnce();

    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('named in none'))).toBe(false);
    warnSpy.mockRestore();
  });
});

describe('VrrpReconcilerService — leader assigned a VIP while `ip` is missing (latched error)', () => {
  function buildMissingIpHarness(atomInstanceId: string = SELF_INSTANCE_ID) {
    let ipInstalled = false;
    const harness = buildHarness({
      scanKeys: ['prefix:p1:config:vrrp'],
      atoms: { 'prefix:p1:config:vrrp': atom(VIP_A, IFACE_A, atomInstanceId) },
      runCommandImpl: async (cmd) => {
        if (cmd[1] === '-j') {
          if (!ipInstalled) throw Object.assign(new Error('spawn ip ENOENT'), { code: 'ENOENT' });
          return ok(ipShowJson([]));
        }
        return ok();
      },
    });
    return { ...harness, installIp: (value: boolean) => (ipInstalled = value) };
  }

  function spyOnError() {
    return vi.spyOn(ContextLogger.prototype, 'error').mockResolvedValue(undefined);
  }

  function assignedErrors(errorSpy: ReturnType<typeof spyOnError>) {
    return errorSpy.mock.calls.filter((c) => String(c[0]).includes('assigned this bridge VIP'));
  }

  it('logs the error once and does not repeat it on the next failing tick', async () => {
    const errorSpy = spyOnError();
    try {
      const { service } = buildMissingIpHarness();

      await service.reconcileOnce();
      await service.reconcileOnce();

      expect(assignedErrors(errorSpy)).toHaveLength(1);
      expect(String(assignedErrors(errorSpy)[0][0])).toContain(VIP_A);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a successful read resets the latch so a later missing-binary tick errors again', async () => {
    const errorSpy = spyOnError();
    try {
      const { service, installIp } = buildMissingIpHarness();

      await service.reconcileOnce();
      installIp(true);
      await service.reconcileOnce();
      installIp(false);
      await service.reconcileOnce();

      expect(assignedErrors(errorSpy)).toHaveLength(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('stays silent when this bridge is not the leader', async () => {
    const errorSpy = spyOnError();
    try {
      const { service, setLeader } = buildMissingIpHarness();
      setLeader(false);

      await service.reconcileOnce();

      expect(assignedErrors(errorSpy)).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('stays silent when no atom names this bridge', async () => {
    const errorSpy = spyOnError();
    try {
      const { service } = buildMissingIpHarness('other-bridge');

      await service.reconcileOnce();

      expect(assignedErrors(errorSpy)).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
