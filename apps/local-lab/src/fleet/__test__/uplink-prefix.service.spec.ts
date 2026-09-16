import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hubApiFetch, hubApiSignIn } from '../../common/hub-client';
import type { RunState } from '../../runner/runner.service';
import { zoneUuid } from '../../zones/zones.service';
import type { RosterNode } from '../fleet-roster';
import { UplinkPrefixService } from '../uplink-prefix.service';

vi.mock('../../common/hub-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/hub-client')>();
  return { ...actual, hubApiSignIn: vi.fn(), hubApiFetch: vi.fn() };
});

const PREFIXES = '/api/v1/ipam/prefixes';
const PREFIX_ID = '11111111-1111-4111-8111-111111111111';
const SIM_PREFIX_ID = '22222222-2222-4222-8222-222222222222';
const NEW_PREFIX_ID = '33333333-3333-4333-8333-333333333333';
const RACE_PREFIX_ID = '44444444-4444-4444-8444-444444444444';
const BMC_PREFIX_ID = '66666666-6666-4666-8666-666666666666';
const WIDE_PREFIX_ID = '77777777-7777-4777-8777-777777777777';
const ZONE = zoneUuid(0);
const UPLINK = { iface: 'ens2', ip: '172.16.12.60', cidr: '172.16.12.60/22' };
const NETWORK = '172.16.12.0/22';
const SIM_NET = { cidr: '192.168.200.0/24', bmc_cidr: '192.168.105.0/24' };

type Answer = { code: number; body: unknown };
type Call = { method: string; path: string; body: unknown };

const prefix = (over: Record<string, unknown> = {}) => ({
  id: PREFIX_ID,
  prefix: NETWORK,
  role: null,
  zoneId: ZONE,
  ...over,
});

const config = (over: Record<string, unknown> = {}) => ({
  dhcpMode: null,
  dhcpLeaseTtlSeconds: null,
  ipxeBuildTarget: 'IPXE',
  dhcpOptions: [],
  dhcpProxyAllowedMacs: [],
  dhcpProxyPeerAuthoritative: false,
  dhcpRelayAgentIp: null,
  ...over,
});

const converged = (over: Record<string, unknown> = {}) =>
  config({
    dhcpMode: 'PROXY',
    ipxeBuildTarget: 'SNPONLY',
    dhcpProxyPeerAuthoritative: true,
    dhcpProxyAllowedMacs: ['aa:bb:cc:dd:ee:01'],
    ...over,
  });

const bmNode = (name: string, pxeMac: string | null): RosterNode => ({
  name,
  kind: 'baremetal',
  deviceId: `device-${name}`,
  pxeMac,
  bmcIp: null,
  zone: null,
});

const vmNode = (name: string): RosterNode => ({ ...bmNode(name, null), kind: 'vm' });

function scriptHub(routes: Record<string, Answer | Answer[]>): Call[] {
  const calls: Call[] = [];
  const queues = new Map<string, Answer[]>();
  for (const [key, answer] of Object.entries(routes)) queues.set(key, Array.isArray(answer) ? [...answer] : [answer]);
  vi.mocked(hubApiSignIn).mockResolvedValue(new Map());
  vi.mocked(hubApiFetch).mockImplementation((_base, _jar, method, path, body) => {
    calls.push({ method, path, body });
    const queue = queues.get(`${method} ${path}`) ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return Promise.resolve(next ?? { code: 404, body: { message: `unscripted ${method} ${path}` } });
  });
  return calls;
}

function makeRun(over: Partial<RunState> = {}): RunState {
  return {
    runId: 'run-1',
    section: 'stack',
    opId: 'baremetal-uplink-prefix',
    label: 'baremetal-uplink-prefix',
    status: 'running',
    startedAt: 1,
    exitCode: null,
    log$: new Subject<string>(),
    lines: [],
    bytes: 0,
    ...over,
  };
}

function makeService(over: {
  uplink?: { iface: string; ip: string; cidr: string | null } | null;
  zones?: string[];
  network?: Record<string, unknown> | null;
  roster?: RosterNode[];
}) {
  const overlay = {
    bmUplink: () => (over.uplink === undefined ? UPLINK : over.uplink),
    fleetZones: () => over.zones ?? ['sim-zone'],
    fleetConfig: () => (over.network === null ? null : { network: over.network ?? SIM_NET, defaults: {}, nodes: {} }),
  };
  const fleet = { roster: () => over.roster ?? [bmNode('bm-1', 'aa:bb:cc:dd:ee:01')] };
  const lines: string[] = [];
  const svc = new UplinkPrefixService(overlay, fleet);
  return { svc, lines, emit: (text: string) => lines.push(text) };
}

const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT');
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

beforeEach(() => {
  vi.mocked(hubApiSignIn).mockReset();
  vi.mocked(hubApiFetch).mockReset();
});

describe('UplinkPrefixService.configure — finding or creating the containing prefix', () => {
  it('creates the network prefix from the nic cidr in the first zone when nothing contains the uplink ip', async () => {
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix({ id: SIM_PREFIX_ID, prefix: SIM_NET.cidr, role: 'PRIMARY' })] },
      [`POST ${PREFIXES}`]: { code: 201, body: prefix({ id: NEW_PREFIX_ID }) },
      [`GET ${PREFIXES}/${NEW_PREFIX_ID}/dhcp/config`]: { code: 200, body: config() },
      [`PUT ${PREFIXES}/${NEW_PREFIX_ID}/dhcp/config`]: { code: 200, body: converged() },
    });
    const { svc, emit, lines } = makeService({});

    expect(await svc.configure(makeRun(), emit)).toBe(0);
    expect(posts(calls).map((c) => c.body)).toEqual([{ prefix: NETWORK, zoneId: ZONE, status: 'ACTIVE' }]);
    expect(puts(calls).map((c) => c.path)).toEqual([`${PREFIXES}/${NEW_PREFIX_ID}/dhcp/config`]);
    expect(lines.join('')).toContain(NETWORK);
  });

  it('re-lists and adopts the prefix when the create answers 409', async () => {
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: [
        { code: 200, body: [] },
        { code: 200, body: [prefix({ id: RACE_PREFIX_ID })] },
      ],
      [`POST ${PREFIXES}`]: { code: 409, body: { message: 'exists' } },
      [`GET ${PREFIXES}/${RACE_PREFIX_ID}/dhcp/config`]: { code: 200, body: config() },
      [`PUT ${PREFIXES}/${RACE_PREFIX_ID}/dhcp/config`]: { code: 200, body: converged() },
    });
    const { svc, emit } = makeService({});

    expect(await svc.configure(makeRun(), emit)).toBe(0);
    expect(calls.filter((c) => c.method === 'GET' && c.path === PREFIXES)).toHaveLength(2);
    expect(puts(calls).map((c) => c.path)).toEqual([`${PREFIXES}/${RACE_PREFIX_ID}/dhcp/config`]);
  });

  it('refuses with exit 1 when the create answers 409 and the re-list still contains nothing', async () => {
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [] },
      [`POST ${PREFIXES}`]: { code: 409, body: { message: 'exists' } },
    });
    const { svc, emit, lines } = makeService({});

    expect(await svc.configure(makeRun(), emit)).toBe(1);
    expect(puts(calls)).toHaveLength(0);
    expect(lines.join('')).toContain('409');
  });

  it('refuses with exit 1 when nothing contains the uplink ip and the nic reports no netmask', async () => {
    const calls = scriptHub({ [`GET ${PREFIXES}`]: { code: 200, body: [] } });
    const { svc, emit, lines } = makeService({ uplink: { ...UPLINK, cidr: null } });

    expect(await svc.configure(makeRun(), emit)).toBe(1);
    expect(posts(calls)).toHaveLength(0);
    expect(lines.join('')).toContain('ens2');
  });

  it('refuses with exit 1 before dialing the hub when the nic cidr is the sim data-plane network', async () => {
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [] },
      [`POST ${PREFIXES}`]: { code: 201, body: prefix({ id: NEW_PREFIX_ID, prefix: SIM_NET.cidr }) },
    });
    const { svc, emit, lines } = makeService({
      uplink: { iface: 'br0', ip: '192.168.200.9', cidr: '192.168.200.9/24' },
    });

    expect(await svc.configure(makeRun(), emit)).toBe(1);
    expect(hubApiSignIn).not.toHaveBeenCalled();
    expect(posts(calls)).toHaveLength(0);
    expect(lines.join('')).toContain(SIM_NET.cidr);
  });

  it('refuses with exit 1 when the nic reports no netmask and the containing hub prefix is the sim data-plane cidr', async () => {
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix({ id: SIM_PREFIX_ID, prefix: SIM_NET.cidr, role: 'PRIMARY' })] },
    });
    const { svc, emit, lines } = makeService({ uplink: { iface: 'br0', ip: '192.168.200.9', cidr: null } });

    expect(await svc.configure(makeRun(), emit)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(lines.join('')).toContain(SIM_NET.cidr);
  });

  it('refuses with exit 1 when the nic reports no netmask and the containing hub prefix is the sim bmc-plane cidr', async () => {
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix({ id: BMC_PREFIX_ID, prefix: SIM_NET.bmc_cidr, role: 'MANAGEMENT' })] },
    });
    const { svc, emit, lines } = makeService({ uplink: { iface: 'lo', ip: '192.168.105.3', cidr: null } });

    expect(await svc.configure(makeRun(), emit)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(lines.join('')).toContain(SIM_NET.bmc_cidr);
  });

  it('configures a PRIMARY-role uplink prefix that is not a sim cidr', async () => {
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix({ role: 'PRIMARY' })] },
      [`GET ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: { code: 200, body: config() },
      [`PUT ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: { code: 200, body: converged() },
    });
    const { svc, emit } = makeService({});

    expect(await svc.configure(makeRun(), emit)).toBe(0);
    expect(posts(calls)).toHaveLength(0);
    expect(puts(calls)).toHaveLength(1);
  });

  it('prefers the longest mask when two prefixes contain the uplink ip', async () => {
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix({ id: WIDE_PREFIX_ID, prefix: '172.16.0.0/16' }), prefix()] },
      [`GET ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: { code: 200, body: converged() },
    });
    const { svc, emit } = makeService({});

    expect(await svc.configure(makeRun(), emit)).toBe(0);
    expect(calls.map((c) => c.path)).toEqual([PREFIXES, `${PREFIXES}/${PREFIX_ID}/dhcp/config`]);
  });

  it('patches the zone onto a zoneless containing prefix before reading its dhcp config', async () => {
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix({ zoneId: null })] },
      [`PATCH ${PREFIXES}/${PREFIX_ID}`]: { code: 200, body: prefix() },
      [`GET ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: { code: 200, body: converged() },
    });
    const { svc, emit, lines } = makeService({});

    expect(await svc.configure(makeRun(), emit)).toBe(0);
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ zoneId: ZONE }]);
    expect(lines.join('')).toContain(ZONE);
  });

  it('refuses with exit 1 when the zone patch is rejected', async () => {
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix({ zoneId: null })] },
      [`PATCH ${PREFIXES}/${PREFIX_ID}`]: { code: 400, body: { message: 'no such zone' } },
    });
    const { svc, emit, lines } = makeService({});

    expect(await svc.configure(makeRun(), emit)).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(lines.join('')).toContain('no such zone');
  });
});

describe('UplinkPrefixService.configure — the merged dhcp config', () => {
  it('puts a merged body that keeps existing macs, options, ttl and relay ip', async () => {
    const before = config({
      dhcpMode: 'AUTHORITATIVE',
      dhcpLeaseTtlSeconds: 3600,
      dhcpOptions: [{ code: 42, value: '10.0.0.7' }],
      dhcpProxyAllowedMacs: ['aa:bb:cc:dd:ee:09'],
      dhcpRelayAgentIp: '10.0.0.9',
    });
    const after = {
      ...before,
      dhcpMode: 'PROXY',
      ipxeBuildTarget: 'SNPONLY',
      dhcpProxyPeerAuthoritative: true,
      dhcpProxyAllowedMacs: ['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:02', 'aa:bb:cc:dd:ee:09'],
    };
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix()] },
      [`GET ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: { code: 200, body: before },
      [`PUT ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: { code: 200, body: after },
    });
    const { svc, emit, lines } = makeService({
      roster: [vmNode('node1'), bmNode('bm-2', 'AA-BB-CC-DD-EE-02'), bmNode('bm-1', 'aa:bb:cc:dd:ee:01')],
    });

    expect(await svc.configure(makeRun(), emit)).toBe(0);
    expect(puts(calls).map((c) => c.body)).toEqual([after]);
    const log = lines.join('');
    expect(log).toContain('dhcpMode: AUTHORITATIVE → PROXY');
    expect(log).toContain('ipxeBuildTarget: IPXE → SNPONLY');
    expect(log).toContain('dhcpProxyPeerAuthoritative: false → true');
    expect(log).toContain('dhcpProxyAllowedMacs');
    expect(log).not.toContain('dhcpLeaseTtlSeconds:');
  });

  it('colonises a bare-hex roster mac before the put', async () => {
    const after = converged({ dhcpProxyAllowedMacs: ['aa:bb:cc:dd:ee:03'] });
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix()] },
      [`GET ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: { code: 200, body: config() },
      [`PUT ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: { code: 200, body: after },
    });
    const { svc, emit } = makeService({ roster: [bmNode('bm-3', 'AABBCCDDEE03')] });

    expect(await svc.configure(makeRun(), emit)).toBe(0);
    expect(puts(calls).map((c) => c.body)).toEqual([after]);
  });

  it('skips the put and exits 0 when the config is already converged', async () => {
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix()] },
      [`GET ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: { code: 200, body: converged() },
    });
    const { svc, emit, lines } = makeService({});

    expect(await svc.configure(makeRun(), emit)).toBe(0);
    expect(puts(calls)).toHaveLength(0);
    expect(lines.join('')).toContain('nothing to change');
  });

  it('skips the put when the hub lists the same macs in another order', async () => {
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix()] },
      [`GET ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: {
        code: 200,
        body: converged({ dhcpProxyAllowedMacs: ['aa:bb:cc:dd:ee:02', 'aa:bb:cc:dd:ee:01'] }),
      },
    });
    const { svc, emit, lines } = makeService({
      roster: [bmNode('bm-1', 'aa:bb:cc:dd:ee:01'), bmNode('bm-2', 'aa:bb:cc:dd:ee:02')],
    });

    expect(await svc.configure(makeRun(), emit)).toBe(0);
    expect(puts(calls)).toHaveLength(0);
    expect(lines.join('')).toContain('nothing to change');
    expect(lines.join('')).toContain('2 MAC(s)');
  });

  it('refuses with exit 1 when the hub lists a mac the shared regex rejects', async () => {
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix()] },
      [`GET ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: {
        code: 200,
        body: converged({ dhcpProxyAllowedMacs: ['AA:BB:CC:DD:EE:01'] }),
      },
    });
    const { svc, emit, lines } = makeService({});

    expect(await svc.configure(makeRun(), emit)).toBe(1);
    expect(puts(calls)).toHaveLength(0);
    expect(lines.join('')).toContain('reading the DHCP config');
  });

  it('refuses with exit 1 and names the status and body when the put is rejected', async () => {
    scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix()] },
      [`GET ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: { code: 200, body: config() },
      [`PUT ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: { code: 400, body: { message: 'reserved option code' } },
    });
    const { svc, emit, lines } = makeService({});

    expect(await svc.configure(makeRun(), emit)).toBe(1);
    const log = lines.join('');
    expect(log).toContain('400');
    expect(log).toContain('reserved option code');
  });

  it('refuses with exit 1 when the dhcp config does not parse', async () => {
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix()] },
      [`GET ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: { code: 200, body: { dhcpMode: 'PROXY' } },
    });
    const { svc, emit } = makeService({});

    expect(await svc.configure(makeRun(), emit)).toBe(1);
    expect(puts(calls)).toHaveLength(0);
  });

  it('refuses with exit 1 when the put answer does not parse', async () => {
    scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix()] },
      [`GET ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: { code: 200, body: config() },
      [`PUT ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: { code: 200, body: 'ok' },
    });
    const { svc, emit } = makeService({});

    expect(await svc.configure(makeRun(), emit)).toBe(1);
  });

  it('writes nothing once the run was canceled', async () => {
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix()] },
      [`GET ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: { code: 200, body: config() },
    });
    const { svc, emit } = makeService({});

    expect(await svc.configure(makeRun({ cancelled: true }), emit)).toBe(1);
    expect(puts(calls)).toHaveLength(0);
  });
});

describe('UplinkPrefixService.configure — preconditions', () => {
  it('refuses with exit 1 before dialing the hub when the bare-metal plane has no uplink', async () => {
    scriptHub({});
    const { svc, emit, lines } = makeService({ uplink: null });

    expect(await svc.configure(makeRun(), emit)).toBe(1);
    expect(hubApiSignIn).not.toHaveBeenCalled();
    expect(lines.join('')).toContain('uplink');
  });

  it('refuses with exit 1 before dialing the hub when no zone is declared', async () => {
    scriptHub({});
    const { svc, emit } = makeService({ zones: [] });

    expect(await svc.configure(makeRun(), emit)).toBe(1);
    expect(hubApiSignIn).not.toHaveBeenCalled();
  });

  it('refuses with exit 1 when the hub sign-in fails', async () => {
    scriptHub({});
    vi.mocked(hubApiSignIn).mockRejectedValue(new Error('sign-in failed (401)'));
    const { svc, emit, lines } = makeService({});

    expect(await svc.configure(makeRun(), emit)).toBe(1);
    expect(lines.join('')).toContain('sign-in failed (401)');
  });

  it('refuses with exit 1 when the prefix list is rejected or malformed', async () => {
    scriptHub({ [`GET ${PREFIXES}`]: { code: 500, body: { message: 'boom' } } });
    const { svc, emit, lines } = makeService({});
    expect(await svc.configure(makeRun(), emit)).toBe(1);
    expect(lines.join('')).toContain('500');

    scriptHub({ [`GET ${PREFIXES}`]: { code: 200, body: { not: 'a list' } } });
    expect(await svc.configure(makeRun(), emit)).toBe(1);
  });

  it('still configures when the fleet config carries no network block', async () => {
    const calls = scriptHub({
      [`GET ${PREFIXES}`]: { code: 200, body: [prefix()] },
      [`GET ${PREFIXES}/${PREFIX_ID}/dhcp/config`]: { code: 200, body: converged() },
    });
    const { svc, emit } = makeService({ network: null });

    expect(await svc.configure(makeRun(), emit)).toBe(0);
    expect(calls).toHaveLength(2);
  });
});
