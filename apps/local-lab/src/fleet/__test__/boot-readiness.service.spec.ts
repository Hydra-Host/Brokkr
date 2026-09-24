import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotFoundException } from '@nestjs/common';

import {
  FleetVerifyReportSchema,
  type BareMetalNode,
  type BootTrail,
  type FleetPlanes,
} from '@repo/local-lab-contract';
import {
  BootReadinessService,
  composeBootReadiness,
  type BootReadinessSources,
  type BootReadinessTransport,
  type HubReadinessSession,
} from '../boot-readiness.service';
import { resolveRoster, type RosterNode } from '../fleet-roster';
import { containingPrefix, type HubPrefix } from '../hub-prefix';

const node = (name: string, pxeMac: string | null, bmcIp: string | null = null): RosterNode => ({
  name,
  kind: 'baremetal',
  deviceId: `device-${name}`,
  pxeMac,
  bmcIp,
  zone: null,
});

const vmNode = (name: string, pxeMac: string | null): RosterNode => ({ ...node(name, pxeMac), kind: 'vm' });

const UPLINK = { iface: 'ens2', ip: '172.16.12.60', cidr: '172.16.12.60/22' };

const sources = (over: Partial<BootReadinessSources> = {}): BootReadinessSources => ({
  planes: { vm: false, baremetal: true },
  roster: [node('bm-1', 'aa:bb:cc:dd:ee:01')],
  bridges: [{ proc: 'spoke', port: 8000 }],
  uplink: UPLINK,
  zoneLabel: 'sim-zone',
  simCidrs: [],
  bmArch: { 'bm-1': 'amd64', 'bm-2': 'amd64', 'bm-3': 'amd64' },
  ...over,
});

const cleanBridge = { findings: [], counts: { error: 0, warn: 0, unevaluated: 0 } };

const files = (present: boolean) =>
  ['vmlinuz', 'initrd.img', 'brokkr-discovery.iso'].map((name) => ({ name, present, sizeBytes: 1024, mtimeMs: 0 }));
const inventory = (...entries: { flavor: string; arch: string; present?: boolean }[]) => ({
  architectures: entries.map((e) => ({ flavor: e.flavor, arch: e.arch, files: files(e.present ?? true) })),
});
const bothFlavors = inventory({ flavor: 'light', arch: 'amd64' }, { flavor: 'full', arch: 'amd64' });

const hubSession = (
  routes: Record<string, { code: number; body: unknown }>,
  seen?: string[],
): (() => Promise<HubReadinessSession>) => {
  const session: HubReadinessSession = {
    get: (path) => {
      seen?.push(path);
      return Promise.resolve(routes[path] ?? { code: 404, body: null });
    },
  };
  return () => Promise.resolve(session);
};

const PREFIXES = '/api/v1/ipam/prefixes';
const UPLINK_ID = '11111111-1111-4111-8111-111111111111';
const SIM_ID = '22222222-2222-4222-8222-222222222222';
const WIDE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const ZONE_ID = '55555555-5555-4555-8555-555555555555';
const READINESS = `${PREFIXES}/${UPLINK_ID}/boot-readiness?mac=aa%3Abb%3Acc%3Add%3Aee%3A01`;
const READINESS_2 = `${PREFIXES}/${UPLINK_ID}/boot-readiness?mac=aa%3Abb%3Acc%3Add%3Aee%3A02`;
const DHCP_CONFIG = `${PREFIXES}/${UPLINK_ID}/dhcp/config`;
const P_UPLINK: HubPrefix = { id: UPLINK_ID, prefix: '172.16.12.0/22', role: null, zoneId: ZONE_ID };
const P_PRIMARY: HubPrefix = { id: SIM_ID, prefix: '192.168.200.0/24', role: 'PRIMARY', zoneId: ZONE_ID };
const PROXY_PEER = { dhcpMode: 'PROXY', dhcpProxyPeerAuthoritative: true };

const AT_MS = Date.UTC(2026, 8, 10, 12, 0, 0);
const offered: BootTrail = {
  pxe: { outcome: 'offered', atMs: AT_MS },
  chainReached: true,
  chainAtMs: AT_MS,
  readError: null,
};
const silent: BootTrail = { pxe: null, chainReached: false, chainAtMs: null, readError: null };
const decided = (outcome: 'refused-allowlist' | 'no-subnet'): BootTrail => ({
  pxe: { outcome, atMs: AT_MS },
  chainReached: false,
  chainAtMs: null,
  readError: null,
});

const trails =
  (byMac: Record<string, BootTrail>): ((mac: string) => Promise<BootTrail>) =>
  (mac) =>
    Promise.resolve(byMac[mac] ?? offered);

const transport = (over: Partial<BootReadinessTransport> = {}): BootReadinessTransport => ({
  bridge: () => Promise.resolve(cleanBridge),
  hub: hubSession({
    [PREFIXES]: { code: 200, body: [P_PRIMARY, P_UPLINK] },
    [DHCP_CONFIG]: { code: 200, body: PROXY_PEER },
    [READINESS]: { code: 200, body: { findings: [] } },
    [READINESS_2]: { code: 200, body: { findings: [] } },
  }),
  trail: () => Promise.resolve(offered),
  inventory: () => Promise.resolve(bothFlavors),
  ...over,
});

describe('composeBootReadiness', () => {
  it('reports healthy when the bridge and the hub both come back clean', async () => {
    const report = await composeBootReadiness(sources(), transport());

    expect(FleetVerifyReportSchema.parse(report)).toEqual(report);
    expect(report.findings).toEqual([]);
    expect(report.status).toBe('healthy');
    expect(report.summary).toEqual({ checked: 1, ok: 1, findings: 0 });
  });

  it('reports PXE-107 rather than a pass when a bridge cannot be reached', async () => {
    const report = await composeBootReadiness(
      sources(),
      transport({ bridge: () => Promise.reject(new Error('ECONNREFUSED')) }),
    );

    expect(report.status).toBe('findings');
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].node).toBeNull();
    expect(report.findings[0].kind).toBe('boot-readiness');
    expect(report.findings[0].healable).toBe(false);
    expect(report.findings[0].detail).toContain('PXE-107 (warn)');
    expect(report.findings[0].detail).toContain('spoke');
  });

  it('surfaces a hub PXE-102 for a prefix that serves no dhcp', async () => {
    const report = await composeBootReadiness(
      sources(),
      transport({
        hub: hubSession({
          [PREFIXES]: { code: 200, body: [P_UPLINK] },
          [DHCP_CONFIG]: { code: 200, body: PROXY_PEER },
          [READINESS]: {
            code: 200,
            body: { findings: [{ code: 'PXE-102', severity: 'error', message: 'This prefix serves no DHCP.' }] },
          },
        }),
      }),
    );

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].node).toBe('bm-1');
    expect(report.findings[0].detail).toBe('PXE-102 (error): This prefix serves no DHCP.');
    expect(report.summary).toEqual({ checked: 1, ok: 0, findings: 1 });
  });

  it('carries the hub code and prefix id on each node finding', async () => {
    const path = `${PREFIXES}/${OTHER_ID}/boot-readiness?mac=aa%3Abb%3Acc%3Add%3Aee%3A01`;
    const report = await composeBootReadiness(
      sources(),
      transport({
        bridge: () =>
          Promise.resolve({
            findings: [{ code: 'PXE-06', severity: 'error' }],
            counts: { error: 1, warn: 0, unevaluated: 0 },
          }),
        hub: hubSession({
          [PREFIXES]: { code: 200, body: [{ ...P_UPLINK, id: OTHER_ID }] },
          [`${PREFIXES}/${OTHER_ID}/dhcp/config`]: { code: 200, body: PROXY_PEER },
          [path]: { code: 200, body: { findings: [{ code: 'PXE-102', severity: 'error', message: 'no dhcp' }] } },
        }),
      }),
    );

    expect(report.findings.map((f) => [f.node, f.code, f.ref])).toEqual([
      ['bm-1', 'PXE-102', OTHER_ID],
      [null, 'PXE-06', null],
    ]);
  });

  it('surfaces a hub PXE-104 and sends the bmc address when the roster carries one', async () => {
    const seen: string[] = [];
    const path = `${READINESS}&bmcAddress=10.10.0.5`;
    const report = await composeBootReadiness(
      sources({ roster: [node('bm-1', 'aa:bb:cc:dd:ee:01', '10.10.0.5')] }),
      transport({
        hub: hubSession(
          {
            [PREFIXES]: { code: 200, body: [P_UPLINK] },
            [DHCP_CONFIG]: { code: 200, body: PROXY_PEER },
            [path]: {
              code: 200,
              body: { findings: [{ code: 'PXE-104', severity: 'error', message: 'The proxy allowlist is empty.' }] },
            },
          },
          seen,
        ),
      }),
    );

    expect(seen).toContain(path);
    expect(report.findings.map((f) => f.detail)).toEqual(['PXE-104 (error): The proxy allowlist is empty.']);
  });

  it('orders node-level findings before fleet-level ones', async () => {
    const report = await composeBootReadiness(
      sources(),
      transport({
        bridge: () =>
          Promise.resolve({
            findings: [{ code: 'PXE-06', severity: 'error' }],
            counts: { error: 1, warn: 0, unevaluated: 0 },
          }),
        hub: hubSession({
          [PREFIXES]: { code: 200, body: [P_UPLINK] },
          [DHCP_CONFIG]: { code: 200, body: PROXY_PEER },
          [READINESS]: {
            code: 200,
            body: { findings: [{ code: 'PXE-102', severity: 'error', message: 'This prefix serves no DHCP.' }] },
          },
        }),
      }),
    );

    expect(report.findings.map((f) => f.node)).toEqual(['bm-1', null]);
  });

  it('reports one fleet-level PXE-107 and runs no node check when the hub is unreachable', async () => {
    const report = await composeBootReadiness(
      sources({ roster: [node('bm-1', 'aa:bb:cc:dd:ee:01'), node('bm-2', 'aa:bb:cc:dd:ee:02')] }),
      transport({ hub: () => Promise.reject(new Error('sign-in failed (401)')) }),
    );

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].node).toBeNull();
    expect(report.findings[0].detail).toContain('PXE-107 (warn)');
    expect(report.summary).toEqual({ checked: 0, ok: 0, findings: 1 });
  });

  it('reports PXE-107 rather than throwing when a hub request fails mid-flight', async () => {
    const report = await composeBootReadiness(
      sources({ roster: [node('bm-1', 'aa:bb:cc:dd:ee:01')] }),
      transport({ hub: () => Promise.resolve({ get: () => Promise.reject(new Error('ECONNRESET')) }) }),
    );

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].detail).toContain('PXE-107');
    expect(report.findings[0].detail).toContain('ECONNRESET');
    expect(report.summary).toEqual({ checked: 0, ok: 0, findings: 1 });
  });

  it('reports PXE-107 rather than a pass when the bridge payload does not parse', async () => {
    const report = await composeBootReadiness(sources(), transport({ bridge: () => Promise.resolve({ findings: 3 }) }));

    expect(report.findings.map((f) => f.detail.slice(0, 15))).toEqual(['PXE-107 (warn):']);
  });

  it('runs no hub check for a vm roster and still asks every bridge', async () => {
    const seen: string[] = [];
    const report = await composeBootReadiness(
      sources({
        planes: { vm: true, baremetal: false },
        roster: [node('node1', null)],
        bridges: [{ proc: 'spoke', port: 8000 }],
      }),
      transport({
        hub: hubSession({ [PREFIXES]: { code: 200, body: [P_PRIMARY] } }, seen),
      }),
    );

    expect(seen).toEqual([]);
    expect(report.planes).toEqual({ vm: true, baremetal: false });
    expect(report.findings).toEqual([]);
    expect(report.summary).toEqual({ checked: 0, ok: 0, findings: 0 });
  });

  it('reports the planes the sources carry', async () => {
    const report = await composeBootReadiness(
      sources({ planes: { vm: true, baremetal: true }, roster: [node('node1', null)] }),
      transport({ hub: hubSession({ [PREFIXES]: { code: 200, body: [P_PRIMARY] } }) }),
    );

    expect(report.planes).toEqual({ vm: true, baremetal: true });
  });

  it('restricts node-level checks to the named node and still asks every bridge', async () => {
    const seen: string[] = [];
    const report = await composeBootReadiness(
      sources({ roster: [node('bm-1', 'aa:bb:cc:dd:ee:01'), node('bm-2', 'aa:bb:cc:dd:ee:02')] }),
      transport({
        hub: hubSession(
          {
            [PREFIXES]: { code: 200, body: [P_UPLINK] },
            [DHCP_CONFIG]: { code: 200, body: PROXY_PEER },
            [READINESS]: { code: 200, body: { findings: [] } },
          },
          seen,
        ),
      }),
      'bm-1',
    );

    expect(seen).toEqual([PREFIXES, DHCP_CONFIG, READINESS]);
    expect(report.summary.checked).toBe(1);
  });

  it('reports a fleet-level PXE-107 when the hub holds no primary prefix for a vm node', async () => {
    const report = await composeBootReadiness(
      sources({ roster: [vmNode('vm-1', 'aa:bb:cc:dd:ee:01')] }),
      transport({ hub: hubSession({ [PREFIXES]: { code: 200, body: [{ ...P_PRIMARY, role: 'MANAGEMENT' }] } }) }),
    );

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].node).toBeNull();
    expect(report.findings[0].detail).toContain('PRIMARY');
  });

  it('flags a refused machine with PXE-110 and a silent one with PXE-111', async () => {
    const report = await composeBootReadiness(
      sources({ roster: [node('bm-1', 'aa:bb:cc:dd:ee:01'), node('bm-2', 'aa:bb:cc:dd:ee:02')] }),
      transport({ trail: trails({ 'aa:bb:cc:dd:ee:01': decided('refused-allowlist'), 'aa:bb:cc:dd:ee:02': silent }) }),
    );

    expect(report.findings.map((f) => [f.node, f.code, f.ref])).toEqual([
      ['bm-1', 'PXE-110', null],
      ['bm-2', 'PXE-111', null],
    ]);
    expect(report.findings[0].detail).toBe(
      `PXE-110 (error): The bridge refused the PXE request from bm-1 at ${new Date(AT_MS).toISOString()}: its MAC is not in the proxy allowlist.`,
    );
    expect(report.findings[1].detail).toBe(
      'PXE-111 (warn): No PXE request from bm-2 has reached the bridge since a network boot was expected at 1970-01-01T00:00:00.000Z.',
    );
    expect(report.summary).toEqual({ checked: 2, ok: 0, findings: 2 });
  });

  it('flags a machine the bridge had no subnet for with PXE-102', async () => {
    const report = await composeBootReadiness(
      sources(),
      transport({ trail: () => Promise.resolve(decided('no-subnet')) }),
    );

    expect(report.findings.map((f) => [f.node, f.code])).toEqual([['bm-1', 'PXE-102']]);
    expect(report.findings[0].detail).toContain('(error)');
    expect(report.findings[0].detail).toContain(new Date(AT_MS).toISOString());
  });

  it('emits no trail finding for a machine the bridge offered to', async () => {
    const seen: string[] = [];
    const report = await composeBootReadiness(
      sources(),
      transport({
        trail: (mac) => {
          seen.push(mac);
          return Promise.resolve({ ...offered, chainReached: false });
        },
      }),
    );

    expect(seen).toEqual(['aa:bb:cc:dd:ee:01']);
    expect(report.findings).toEqual([]);
    expect(report.summary).toEqual({ checked: 1, ok: 1, findings: 0 });
  });

  it('reports a node-level PXE-107 when the trail cannot be read', async () => {
    const report = await composeBootReadiness(
      sources(),
      transport({
        trail: () => Promise.resolve({ pxe: null, chainReached: false, chainAtMs: null, readError: 'ECONNREFUSED' }),
      }),
    );

    expect(report.findings.map((f) => [f.node, f.code])).toEqual([['bm-1', 'PXE-107']]);
    expect(report.findings[0].detail).toContain('PXE-107 (warn)');
    expect(report.findings[0].detail).toContain('ECONNREFUSED');
  });

  it('keeps ok at zero when the hub is unreachable and only the trail flags a machine', async () => {
    const report = await composeBootReadiness(
      sources(),
      transport({ hub: () => Promise.reject(new Error('sign-in failed (401)')), trail: () => Promise.resolve(silent) }),
    );

    expect(report.findings.map((f) => [f.node, f.code])).toEqual([
      ['bm-1', 'PXE-111'],
      [null, 'PXE-107'],
    ]);
    expect(report.summary).toEqual({ checked: 0, ok: 0, findings: 2 });
  });

  it('reports a node-level PXE-107 when the hub rejects the readiness query', async () => {
    const report = await composeBootReadiness(
      sources(),
      transport({
        hub: hubSession({
          [PREFIXES]: { code: 200, body: [P_UPLINK] },
          [DHCP_CONFIG]: { code: 200, body: PROXY_PEER },
          [READINESS]: { code: 400, body: { message: 'bad mac' } },
        }),
      }),
    );

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].node).toBe('bm-1');
    expect(report.findings[0].detail).toContain('PXE-107 (warn)');
    expect(report.findings[0].detail).toContain('400');
  });
});

describe('composeBootReadiness — the prefix containing the bare-metal uplink', () => {
  const READINESS_SIM = `${PREFIXES}/${SIM_ID}/boot-readiness?mac=aa%3Abb%3Acc%3Add%3Aee%3A01`;

  it('selects the hub prefix containing the uplink ip for a bare-metal node and ignores the PRIMARY prefix', async () => {
    const seen: string[] = [];
    const report = await composeBootReadiness(
      sources(),
      transport({
        hub: hubSession(
          {
            [PREFIXES]: { code: 200, body: [P_PRIMARY, P_UPLINK] },
            [DHCP_CONFIG]: { code: 200, body: PROXY_PEER },
            [READINESS]: { code: 200, body: { findings: [] } },
          },
          seen,
        ),
      }),
    );

    expect(seen).toEqual([PREFIXES, DHCP_CONFIG, READINESS]);
    expect(seen).not.toContain(READINESS_SIM);
    expect(report.findings).toEqual([]);
    expect(report.summary).toEqual({ checked: 1, ok: 1, findings: 0 });
  });

  it('prefers the longest mask when two prefixes contain the uplink ip', async () => {
    const seen: string[] = [];
    const wide: HubPrefix = { id: WIDE_ID, prefix: '172.16.0.0/16', role: null, zoneId: ZONE_ID };
    await composeBootReadiness(
      sources(),
      transport({
        hub: hubSession(
          {
            [PREFIXES]: { code: 200, body: [wide, P_UPLINK] },
            [DHCP_CONFIG]: { code: 200, body: PROXY_PEER },
            [READINESS]: { code: 200, body: { findings: [] } },
          },
          seen,
        ),
      }),
    );

    expect(seen).toEqual([PREFIXES, DHCP_CONFIG, READINESS]);
    expect(containingPrefix([P_UPLINK, wide], UPLINK.ip)).toEqual(P_UPLINK);
    expect(containingPrefix([P_PRIMARY], UPLINK.ip)).toBeNull();
  });

  it('reports a node-level PXE-102 naming the NIC cidr and zone when no prefix contains the uplink ip', async () => {
    const seen: string[] = [];
    const report = await composeBootReadiness(
      sources({ roster: [node('bm-1', 'aa:bb:cc:dd:ee:01'), node('bm-2', 'aa:bb:cc:dd:ee:02')] }),
      transport({ hub: hubSession({ [PREFIXES]: { code: 200, body: [P_PRIMARY] } }, seen) }),
    );

    expect(seen).toEqual([PREFIXES]);
    expect(report.findings.map((f) => [f.node, f.code, f.ref])).toEqual([
      ['bm-1', 'PXE-102', null],
      ['bm-2', 'PXE-102', null],
    ]);
    expect(report.findings[0].detail).toBe(
      'PXE-102 (error): No hub prefix contains the uplink IP 172.16.12.60 (ens2). Create 172.16.12.0/22 in zone sim-zone under IPAM → Prefixes, or run "Configure uplink prefix in hub".',
    );
    expect(report.summary).toEqual({ checked: 0, ok: 0, findings: 2 });
  });

  it('reports a node-level PXE-102 when the containing prefix is the simulator own network', async () => {
    const report = await composeBootReadiness(
      sources({ simCidrs: ['172.16.12.0/22'] }),
      transport({ hub: hubSession({ [PREFIXES]: { code: 200, body: [P_UPLINK, P_PRIMARY] } }) }),
    );

    expect(report.findings.map((f) => [f.node, f.code, f.ref])).toEqual([['bm-1', 'PXE-102', UPLINK_ID]]);
    expect(report.findings[0].detail).toContain("is the simulator's own network");
    expect(report.summary).toEqual({ checked: 0, ok: 0, findings: 1 });
  });

  it('reports a node-level PXE-102 with the prefix id when the containing prefix has no zone', async () => {
    const seen: string[] = [];
    const report = await composeBootReadiness(
      sources(),
      transport({
        hub: hubSession(
          {
            [PREFIXES]: { code: 200, body: [{ ...P_UPLINK, zoneId: null }] },
            [DHCP_CONFIG]: { code: 200, body: PROXY_PEER },
            [READINESS]: { code: 200, body: { findings: [] } },
          },
          seen,
        ),
      }),
    );

    expect(seen).toContain(READINESS);
    expect(report.findings.map((f) => [f.node, f.code, f.ref])).toEqual([['bm-1', 'PXE-102', UPLINK_ID]]);
    expect(report.findings[0].detail).toContain('172.16.12.0/22');
    expect(report.findings[0].detail).toContain('sim-zone');
    expect(report.summary).toEqual({ checked: 1, ok: 0, findings: 1 });
  });

  it('reports PXE-112 when the containing prefix is AUTHORITATIVE', async () => {
    const report = await composeBootReadiness(
      sources(),
      transport({
        hub: hubSession({
          [PREFIXES]: { code: 200, body: [P_UPLINK] },
          [DHCP_CONFIG]: { code: 200, body: { dhcpMode: 'AUTHORITATIVE', dhcpProxyPeerAuthoritative: false } },
          [READINESS]: { code: 200, body: { findings: [] } },
        }),
      }),
    );

    expect(report.findings.map((f) => [f.node, f.code, f.ref])).toEqual([['bm-1', 'PXE-112', UPLINK_ID]]);
    expect(report.findings[0].detail).toContain('PXE-112 (error)');
    expect(report.findings[0].detail).toContain('172.16.12.0/22');
  });

  it('reports PXE-04 when the containing prefix is PROXY without a peer authoritative', async () => {
    const report = await composeBootReadiness(
      sources(),
      transport({
        hub: hubSession({
          [PREFIXES]: { code: 200, body: [P_UPLINK] },
          [DHCP_CONFIG]: { code: 200, body: { dhcpMode: 'PROXY', dhcpProxyPeerAuthoritative: false } },
          [READINESS]: { code: 200, body: { findings: [] } },
        }),
      }),
    );

    expect(report.findings.map((f) => [f.node, f.code, f.ref])).toEqual([['bm-1', 'PXE-04', UPLINK_ID]]);
    expect(report.findings[0].detail).toContain('PXE-04 (warn)');
  });

  it('emits no lab finding for a PROXY peer-authoritative prefix and still carries hub findings with the uplink prefix id', async () => {
    const report = await composeBootReadiness(
      sources(),
      transport({
        hub: hubSession({
          [PREFIXES]: { code: 200, body: [P_PRIMARY, P_UPLINK] },
          [DHCP_CONFIG]: { code: 200, body: PROXY_PEER },
          [READINESS]: {
            code: 200,
            body: { findings: [{ code: 'PXE-104', severity: 'error', message: 'The proxy allowlist is empty.' }] },
          },
        }),
      }),
    );

    expect(report.findings.map((f) => [f.node, f.code, f.ref])).toEqual([['bm-1', 'PXE-104', UPLINK_ID]]);
  });

  it('reports node-level PXE-107 when the dhcp config route fails and still runs the hub readiness route', async () => {
    const seen: string[] = [];
    const report = await composeBootReadiness(
      sources(),
      transport({
        hub: hubSession(
          {
            [PREFIXES]: { code: 200, body: [P_UPLINK] },
            [DHCP_CONFIG]: { code: 500, body: { message: 'boom' } },
            [READINESS]: { code: 200, body: { findings: [] } },
          },
          seen,
        ),
      }),
    );

    expect(seen).toEqual([PREFIXES, DHCP_CONFIG, READINESS]);
    expect(report.findings.map((f) => [f.node, f.code, f.ref])).toEqual([['bm-1', 'PXE-107', UPLINK_ID]]);
    expect(report.findings[0].detail).toContain('500');
    expect(report.summary).toEqual({ checked: 1, ok: 0, findings: 1 });
  });

  it('reports PXE-107 for bare-metal nodes when the uplink has no ipv4', async () => {
    const seen: string[] = [];
    const report = await composeBootReadiness(
      sources({ uplink: null }),
      transport({ hub: hubSession({ [PREFIXES]: { code: 200, body: [P_UPLINK] } }, seen) }),
    );

    expect(seen).toEqual([PREFIXES]);
    expect(report.findings.map((f) => [f.node, f.code])).toEqual([['bm-1', 'PXE-107']]);
    expect(report.findings[0].detail).toContain('PXE-107 (warn)');
    expect(report.summary).toEqual({ checked: 0, ok: 0, findings: 1 });
  });

  it('keeps the PRIMARY-role rule for a vm node with a pxe mac', async () => {
    const seen: string[] = [];
    const report = await composeBootReadiness(
      sources({
        planes: { vm: true, baremetal: true },
        roster: [vmNode('vm-1', 'aa:bb:cc:dd:ee:01'), node('bm-2', 'aa:bb:cc:dd:ee:02')],
      }),
      transport({
        hub: hubSession(
          {
            [PREFIXES]: { code: 200, body: [P_PRIMARY, P_UPLINK] },
            [DHCP_CONFIG]: { code: 200, body: PROXY_PEER },
            [READINESS_SIM]: { code: 200, body: { findings: [] } },
            [READINESS_2]: { code: 200, body: { findings: [] } },
          },
          seen,
        ),
      }),
    );

    expect(seen).toContain(READINESS_SIM);
    expect(seen).toContain(READINESS_2);
    expect(seen).not.toContain(READINESS);
    expect(seen.filter((p) => p === DHCP_CONFIG)).toHaveLength(1);
    expect(report.findings).toEqual([]);
    expect(report.summary).toEqual({ checked: 2, ok: 2, findings: 0 });
  });

  it('counts ok over the nodes the hub checked when bare-metal nodes fail before the hub route', async () => {
    const report = await composeBootReadiness(
      sources({
        planes: { vm: true, baremetal: true },
        roster: [
          vmNode('vm-1', 'aa:bb:cc:dd:ee:01'),
          node('bm-2', 'aa:bb:cc:dd:ee:02'),
          node('bm-3', 'aa:bb:cc:dd:ee:03'),
        ],
      }),
      transport({
        hub: hubSession({
          [PREFIXES]: { code: 200, body: [P_PRIMARY] },
          [READINESS_SIM]: { code: 200, body: { findings: [] } },
        }),
      }),
    );

    expect(report.findings.map((f) => [f.node, f.code])).toEqual([
      ['bm-2', 'PXE-102'],
      ['bm-3', 'PXE-102'],
    ]);
    expect(report.summary).toEqual({ checked: 1, ok: 1, findings: 2 });
  });

  it('reads the dhcp config once for many bare-metal nodes', async () => {
    const seen: string[] = [];
    const macs = ['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:02', 'aa:bb:cc:dd:ee:03'];
    const routes: Record<string, { code: number; body: unknown }> = {
      [PREFIXES]: { code: 200, body: [P_UPLINK] },
      [DHCP_CONFIG]: { code: 200, body: PROXY_PEER },
    };
    for (const mac of macs)
      routes[`${PREFIXES}/${UPLINK_ID}/boot-readiness?mac=${encodeURIComponent(mac)}`] = { code: 200, body: { findings: [] } };
    const report = await composeBootReadiness(
      sources({ roster: macs.map((mac, i) => node(`bm-${i + 1}`, mac)) }),
      transport({ hub: hubSession(routes, seen) }),
    );

    expect(seen.filter((p) => p === DHCP_CONFIG)).toHaveLength(1);
    expect(seen.filter((p) => p.includes('/boot-readiness'))).toHaveLength(3);
    expect(report.summary).toEqual({ checked: 3, ok: 3, findings: 0 });
  });
});

describe('BootReadinessService live transport', () => {
  const hubResponse = (body: unknown) => ({
    status: 200,
    headers: { getSetCookie: () => [] },
    text: () => Promise.resolve(JSON.stringify(body)),
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes an abort signal on every hub request the live transport makes', async () => {
    const liveFetch = vi.fn<
      (url: string | URL | Request, init?: RequestInit) => Promise<ReturnType<typeof hubResponse>>
    >((url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith(PREFIXES)) return Promise.resolve(hubResponse([P_UPLINK]));
      if (path.endsWith('/dhcp/config')) return Promise.resolve(hubResponse(PROXY_PEER));
      return Promise.resolve(hubResponse({ findings: [] }));
    });
    vi.stubGlobal('fetch', liveFetch);
    const service = new BootReadinessService(
      { roster: () => [node('bm-1', 'aa:bb:cc:dd:ee:01')] },
      {
        planes: () => ({ vm: false, baremetal: true }),
        labBridges: () => [],
        bmUplink: () => UPLINK,
        fleetZones: () => ['sim-zone'],
        fleetConfig: () => null,
        baremetalConfig: () => ({ nics: [], arch: 'amd64', nodes: { 'bm-1': {} } }),
      },
      { read: () => Promise.resolve(offered) },
    );

    await service.getBootReadiness();

    expect(liveFetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/auth/sign-in/email',
      '/api/v1/organizations/00000000-0000-0000-0000-000000000000/set-active',
      PREFIXES,
      DHCP_CONFIG,
      `${PREFIXES}/${UPLINK_ID}/boot-readiness`,
    ]);
    for (const [, init] of liveFetch.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes an abort signal on the bridge inventory read the live transport makes', async () => {
    const bridgeResponse = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
    const liveFetch = vi.fn<
      (
        url: string | URL | Request,
        init?: RequestInit,
      ) => Promise<ReturnType<typeof hubResponse> | ReturnType<typeof bridgeResponse>>
    >((url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/discovery/inventory') return Promise.resolve(bridgeResponse(bothFlavors));
      if (path === '/api/boot-readiness') return Promise.resolve(bridgeResponse(cleanBridge));
      if (path.endsWith(PREFIXES)) return Promise.resolve(hubResponse([P_UPLINK]));
      if (path.endsWith('/dhcp/config')) return Promise.resolve(hubResponse(PROXY_PEER));
      return Promise.resolve(hubResponse({ findings: [] }));
    });
    vi.stubGlobal('fetch', liveFetch);
    const service = new BootReadinessService(
      { roster: () => [node('bm-1', 'aa:bb:cc:dd:ee:01')] },
      {
        planes: () => ({ vm: false, baremetal: true }),
        labBridges: () => [{ proc: 'spoke', zone: 'sim-zone', replica: 0, port: 8000, grpc: 9082 }],
        bmUplink: () => UPLINK,
        fleetZones: () => ['sim-zone'],
        fleetConfig: () => null,
        baremetalConfig: () => ({ nics: [], arch: 'amd64', nodes: { 'bm-1': {} } }),
      },
      { read: () => Promise.resolve(offered) },
    );

    const report = await service.getBootReadiness();

    expect(liveFetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toContain('/api/discovery/inventory');
    for (const [, init] of liveFetch.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(report.findings).toEqual([]);
  });
});

describe('composeBootReadiness — the full discovery image for a bare-metal machine', () => {
  it('reports PXE-113 per bare-metal node when no bridge serves the full image for its arch', async () => {
    const report = await composeBootReadiness(
      sources({ roster: [node('bm-1', 'aa:bb:cc:dd:ee:01'), node('bm-2', 'aa:bb:cc:dd:ee:02')] }),
      transport({ inventory: () => Promise.resolve(inventory({ flavor: 'light', arch: 'amd64' })) }),
    );

    expect(report.findings.map((f) => [f.node, f.code])).toEqual([
      ['bm-1', 'PXE-113'],
      ['bm-2', 'PXE-113'],
    ]);
    expect(report.findings[0].detail).toContain('PXE-113 (error)');
    expect(report.findings[0].detail).toContain('amd64');
    expect(report.summary).toEqual({ checked: 2, ok: 0, findings: 2 });
  });

  it('emits no PXE-113 when a bridge serves a complete full tree for the machine arch', async () => {
    const report = await composeBootReadiness(
      sources({ bmArch: { 'bm-1': 'arm64' } }),
      transport({
        inventory: () =>
          Promise.resolve(inventory({ flavor: 'light', arch: 'amd64' }, { flavor: 'full', arch: 'arm64' })),
      }),
    );

    expect(report.findings).toEqual([]);
  });

  it('reports PXE-113 when the full tree is present but a file is missing', async () => {
    const report = await composeBootReadiness(
      sources(),
      transport({
        inventory: () => Promise.resolve(inventory({ flavor: 'full', arch: 'amd64', present: false })),
      }),
    );

    expect(report.findings.map((f) => [f.node, f.code])).toEqual([['bm-1', 'PXE-113']]);
  });

  it('reports pxe-113 when the full tree lists no files at all', async () => {
    const report = await composeBootReadiness(
      sources(),
      transport({
        inventory: () => Promise.resolve({ architectures: [{ flavor: 'full', arch: 'amd64', files: [] }] }),
      }),
    );

    expect(report.findings.map((f) => [f.node, f.code])).toEqual([['bm-1', 'PXE-113']]);
  });

  it('accepts the full tree from any declared bridge', async () => {
    const asked: string[] = [];
    const report = await composeBootReadiness(
      sources({
        bridges: [
          { proc: 'spoke', port: 8000 },
          { proc: 'spoke-2', port: 8001 },
        ],
      }),
      transport({
        inventory: (target) => {
          asked.push(target.proc);
          return Promise.resolve(
            target.proc === 'spoke-2' ? bothFlavors : inventory({ flavor: 'light', arch: 'amd64' }),
          );
        },
      }),
    );

    expect(asked.sort()).toEqual(['spoke', 'spoke-2']);
    expect(report.findings).toEqual([]);
  });

  it('reports a node-level PXE-107 when no bridge inventory can be read', async () => {
    const report = await composeBootReadiness(
      sources(),
      transport({ inventory: () => Promise.reject(new Error('ECONNREFUSED')) }),
    );

    expect(report.findings.map((f) => [f.node, f.code])).toEqual([['bm-1', 'PXE-107']]);
    expect(report.findings[0].detail).toContain('inventory');
    expect(report.findings[0].detail).toContain('ECONNREFUSED');
  });

  it('reports a node-level PXE-107 when the inventory payload cannot be read', async () => {
    const report = await composeBootReadiness(
      sources(),
      transport({ inventory: () => Promise.resolve({ architectures: [{ arch: 'amd64' }] }) }),
    );

    expect(report.findings.map((f) => [f.node, f.code])).toEqual([['bm-1', 'PXE-107']]);
  });

  it('reports a node-level PXE-107 when the machine has no configured architecture', async () => {
    const report = await composeBootReadiness(sources({ bmArch: {} }), transport());

    expect(report.findings.map((f) => [f.node, f.code])).toEqual([['bm-1', 'PXE-107']]);
    expect(report.findings[0].detail).toContain('architecture');
  });

  it('runs no inventory check for a vm roster', async () => {
    const inventorySpy = vi.fn(() => Promise.resolve(bothFlavors));
    const report = await composeBootReadiness(
      sources({ planes: { vm: true, baremetal: false }, roster: [vmNode('vm-1', null)] }),
      transport({ inventory: inventorySpy }),
    );

    expect(inventorySpy).not.toHaveBeenCalled();
    expect(report.findings).toEqual([]);
  });
});

describe('BootReadinessService.forMachine', () => {
  const bmNode: BareMetalNode = {
    name: 'bm-1',
    bmc_ip: '10.10.0.5',
    bmc_mac: 'aa:bb:cc:dd:ee:01',
    pxe_mac: 'AA-BB-CC-DD-EE-02',
    arch: null,
    system_id: null,
  };

  const service = (planes: FleetPlanes, seen: string[]): BootReadinessService =>
    new BootReadinessService(
      {
        roster: () =>
          resolveRoster({
            vmNodeNames: () => (planes.vm ? ['node1'] : []),
            baremetalNodes: () => (planes.baremetal ? [bmNode] : []),
          }),
      },
      {
        planes: () => planes,
        labBridges: () => [],
        bmUplink: () => UPLINK,
        fleetZones: () => ['sim-zone'],
        fleetConfig: () => null,
        baremetalConfig: () => ({ nics: [], arch: 'amd64', nodes: { 'bm-1': { arch: 'arm64' } } }),
      },
      { read: () => Promise.reject(new Error('the reader must not be reached when a transport is injected')) },
      transport({
        trail: (mac) => {
          seen.push(mac);
          return Promise.resolve(decided('refused-allowlist'));
        },
      }),
    );

  it('returns the trail for the machine pxe mac as the roster carries it', async () => {
    const seen: string[] = [];

    expect(await service({ vm: false, baremetal: true }, seen).forMachine('bm-1')).toEqual(
      decided('refused-allowlist'),
    );
    expect(seen).toEqual(['AA-BB-CC-DD-EE-02']);
  });

  it('answers 404 for a machine the roster does not hold', async () => {
    await expect(service({ vm: false, baremetal: true }, []).forMachine('bm-9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('answers 404 for a machine with no pxe mac', async () => {
    const seen: string[] = [];

    await expect(service({ vm: true, baremetal: false }, seen).forMachine('node1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(seen).toEqual([]);
  });
});
