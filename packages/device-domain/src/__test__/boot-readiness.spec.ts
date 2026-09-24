import type { DeviceBootTrail, PrefixDhcpConfig } from '@repo/api-client';
import { BOOT_CODES } from '@repo/utils';
import { describe, expect, it } from 'vitest';
import { deviceBootReadiness, HUB_BOOT_CHECKS, prefixBootFindings } from '../boot-readiness';
import type { BootIdentity } from '../prefix-boot-queries';

const DEVICE = '22222222-2222-2222-2222-222222222222';
const ZONE = '11111111-1111-1111-1111-111111111111';
const PREFIX = '33333333-3333-3333-3333-333333333333';
const PXE_MAC = 'aa:bb:cc:dd:ee:ff';
const BMC_ADDRESS = '10.0.2.10';

const READY_CONFIG: PrefixDhcpConfig = {
  dhcpMode: 'PROXY',
  dhcpLeaseTtlSeconds: null,
  ipxeBuildTarget: 'IPXE',
  dhcpOptions: [],
  dhcpProxyAllowedMacs: [PXE_MAC],
  dhcpProxyPeerAuthoritative: true,
  dhcpRelayAgentIp: null,
};

const SAME_DEVICE: BootIdentity = { pxeDeviceId: 'device-1', bmcDeviceId: 'device-1' };
const QUERY = { mac: PXE_MAC, bmcAddress: BMC_ADDRESS };

const codes = (
  config: PrefixDhcpConfig,
  identity: BootIdentity | null = SAME_DEVICE,
  allowlist: readonly string[] = [PXE_MAC],
): string[] => prefixBootFindings(config, identity, QUERY, allowlist).map((finding) => finding.code);

describe('prefixBootFindings', () => {
  it('reports PXE-102 when the prefix builds no DHCP subnet', () => {
    expect(codes({ ...READY_CONFIG, dhcpMode: null })).toEqual(['PXE-102']);
  });

  it('reports PXE-102 when the DHCP mode is explicitly OFF', () => {
    expect(codes({ ...READY_CONFIG, dhcpMode: 'OFF' })).toEqual(['PXE-102']);
  });

  it('reports PXE-103 when the prefix offers no iPXE build target', () => {
    expect(codes({ ...READY_CONFIG, ipxeBuildTarget: null })).toEqual(['PXE-103']);
  });

  it('passes PXE-104 when only a reservation admits the mac', () => {
    expect(
      prefixBootFindings({ ...READY_CONFIG, dhcpProxyAllowedMacs: [] }, SAME_DEVICE, QUERY, [PXE_MAC]).map(
        (f) => f.code,
      ),
    ).toEqual([]);
  });

  it('compares the mac in canonical form', () => {
    const upper = { mac: PXE_MAC.toUpperCase(), bmcAddress: BMC_ADDRESS };
    expect(prefixBootFindings(READY_CONFIG, SAME_DEVICE, upper, [PXE_MAC]).map((f) => f.code)).toEqual([]);
  });

  it('reports PXE-104 when the effective allowlist excludes the mac', () => {
    expect(prefixBootFindings(READY_CONFIG, SAME_DEVICE, QUERY, ['80:61:5f:15:4a:29']).map((f) => f.code)).toEqual([
      'PXE-104',
    ]);
  });

  it('reports PXE-106 when the MAC and the BMC address resolve to different devices', () => {
    expect(codes(READY_CONFIG, { pxeDeviceId: 'device-1', bmcDeviceId: 'device-2' })).toEqual(['PXE-106']);
  });

  it('names an unregistered PXE MAC instead of blaming two devices', () => {
    const [finding] = prefixBootFindings(READY_CONFIG, { pxeDeviceId: null, bmcDeviceId: 'device-1' }, QUERY, [
      PXE_MAC,
    ]);
    expect(finding.code).toBe('PXE-106');
    expect(finding.message).toContain(`No hub device carries the PXE MAC ${PXE_MAC}`);
    expect(finding.message).not.toContain('different hub devices');
  });

  it('names an unregistered BMC address instead of blaming two devices', () => {
    const [finding] = prefixBootFindings(READY_CONFIG, { pxeDeviceId: 'device-1', bmcDeviceId: null }, QUERY, [
      PXE_MAC,
    ]);
    expect(finding.message).toContain(`No hub device carries the BMC address ${BMC_ADDRESS}`);
    expect(finding.message).not.toContain('different hub devices');
  });

  it('does not report PXE-106 when neither address resolves to a device', () => {
    expect(codes(READY_CONFIG, { pxeDeviceId: null, bmcDeviceId: null })).toEqual([]);
  });

  it('skips the identity check when no identity was resolved', () => {
    expect(codes(READY_CONFIG, null)).toEqual([]);
  });

  it('carries the registry severity on every finding', () => {
    const findings = prefixBootFindings(
      { ...READY_CONFIG, dhcpMode: null, ipxeBuildTarget: null },
      { pxeDeviceId: 'device-1', bmcDeviceId: 'device-2' },
      QUERY,
      [PXE_MAC],
    );
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) expect(finding.severity).toBe(BOOT_CODES[finding.code].severity);
  });

  it('orders findings by code, as the response schema promises', () => {
    const observed = codes(
      { ...READY_CONFIG, dhcpMode: null, ipxeBuildTarget: null },
      { pxeDeviceId: 'device-1', bmcDeviceId: 'device-2' },
    );
    expect(observed.length).toBeGreaterThan(1);
    expect(observed).toEqual([...observed].sort());
  });

  it('reports nothing for a fully configured prefix', () => {
    expect(codes(READY_CONFIG)).toEqual([]);
  });

  it('runs every check the table declares', () => {
    const split = { pxeDeviceId: 'device-1', bmcDeviceId: 'device-2' };
    const withoutDhcp = codes({ ...READY_CONFIG, dhcpMode: null, ipxeBuildTarget: null }, split);
    const withProxyRefusal = codes(READY_CONFIG, split, []);
    const observed = [...new Set([...withoutDhcp, ...withProxyRefusal])].sort();
    expect(observed).toEqual(Object.keys(HUB_BOOT_CHECKS).sort());
  });
});

const trail = (over: Partial<DeviceBootTrail> = {}): DeviceBootTrail => ({
  deviceId: DEVICE,
  pxeMac: PXE_MAC,
  pxeInterface: 'eth0',
  pxeMacSource: 'address',
  candidateMacs: [],
  zoneId: ZONE,
  trail: {
    pxe: { outcome: 'offered', atMs: 1789560131000 },
    chainReached: true,
    chainAtMs: null,
    chainDeviceMismatch: false,
    readError: null,
  },
  bootExpected: { expected: false, since: null, reason: 'none' },
  readAt: '2026-09-16T12:00:00.000Z',
  ...over,
});

const evaluate = (over: Partial<Parameters<typeof deviceBootReadiness>[0]> = {}) =>
  deviceBootReadiness({
    deviceId: DEVICE,
    subject: 'gpu-node-07',
    bmcAddress: null,
    trail: trail(),
    selected: { id: PREFIX, selection: 'containing' },
    prefixFindings: [],
    ...over,
  });

describe('deviceBootReadiness', () => {
  it('merges hub prefix findings with the prefix id and tags the source', () => {
    const out = evaluate({ prefixFindings: [{ code: 'PXE-104', severity: 'error', message: 'excluded' }] });
    expect(out.findings).toEqual([
      { code: 'PXE-104', severity: 'error', message: 'excluded', source: 'hub-prefix', prefixId: PREFIX },
    ]);
    expect(out.prefixId).toBe(PREFIX);
    expect(out.prefixSelection).toBe('containing');
    expect(out.evaluated).toEqual({ hubPrefix: true, bootTrail: true, bootedWithoutDhcp: false });
  });

  it('carries the chosen interface and why it was chosen through from the trail', () => {
    const out = evaluate({ trail: trail({ pxeInterface: 'ens4047f0np0', pxeMacSource: 'marker' }) });
    expect(out).toMatchObject({ pxeMac: PXE_MAC, pxeInterface: 'ens4047f0np0', pxeMacSource: 'marker' });
  });

  it('reports PXE-107 and hubPrefix false when no prefix is selected', () => {
    const out = evaluate({ selected: null, prefixFindings: null });
    expect(out.findings.map((f) => f.code)).toEqual(['PXE-107']);
    expect(out.evaluated.hubPrefix).toBe(false);
    expect(out.prefixId).toBeNull();
    expect(out.prefixSelection).toBe('none');
  });

  it('adds the trail finding when a boot is expected and the trail is silent', () => {
    const out = evaluate({
      trail: trail({
        trail: { pxe: null, chainReached: false, chainAtMs: null, chainDeviceMismatch: false, readError: null },
        bootExpected: { expected: true, since: '2026-09-16T11:00:00.000Z', reason: 'active-job' },
      }),
    });
    expect(out.findings.map((f) => [f.code, f.source])).toEqual([['PXE-111', 'boot-trail']]);
  });

  it('reports one PXE-107 from the trail when the device has no data MAC', () => {
    const out = evaluate({
      selected: null,
      prefixFindings: null,
      trail: trail({
        pxeMac: null,
        zoneId: null,
        trail: {
          pxe: null,
          chainReached: null,
          chainAtMs: null,
          chainDeviceMismatch: false,
          readError: 'no data interface with a MAC',
        },
      }),
    });
    expect(out.findings.map((f) => [f.code, f.source])).toEqual([['PXE-107', 'boot-trail']]);
    expect(out.evaluated).toEqual({ hubPrefix: false, bootTrail: false, bootedWithoutDhcp: false });
  });

  it('reports one PXE-107 from the trail when the zone could not be resolved', () => {
    const out = evaluate({
      selected: null,
      prefixFindings: null,
      trail: trail({
        zoneId: null,
        trail: {
          pxe: null,
          chainReached: null,
          chainAtMs: null,
          chainDeviceMismatch: false,
          readError: 'device is not assigned to a zone',
        },
      }),
    });
    expect(out.findings.map((f) => [f.code, f.source])).toEqual([['PXE-107', 'boot-trail']]);
    expect(out.evaluated).toEqual({ hubPrefix: false, bootTrail: false, bootedWithoutDhcp: false });
  });

  it('flags a boot that reached the chain without a bridge decision and raises no trail finding', () => {
    const out = evaluate({
      trail: trail({
        trail: {
          pxe: null,
          chainReached: true,
          chainAtMs: Date.parse('2026-09-16T11:05:00.000Z'),
          chainDeviceMismatch: false,
          readError: null,
        },
        bootExpected: { expected: true, since: '2026-09-16T11:00:00.000Z', reason: 'active-job' },
      }),
    });
    expect(out.evaluated.bootedWithoutDhcp).toBe(true);
    expect(out.findings).toEqual([]);
  });

  it('keeps a chain proven only by the pending marker as silence', () => {
    const out = evaluate({
      trail: trail({
        trail: { pxe: null, chainReached: true, chainAtMs: null, chainDeviceMismatch: false, readError: null },
        bootExpected: { expected: true, since: '2026-09-16T11:00:00.000Z', reason: 'active-job' },
      }),
    });
    expect(out.evaluated.bootedWithoutDhcp).toBe(false);
    expect(out.findings.map((f) => f.code)).toEqual(['PXE-111']);
  });

  it('marks the trail unevaluated when redis was unreadable', () => {
    const out = evaluate({
      trail: trail({
        trail: {
          pxe: null,
          chainReached: null,
          chainAtMs: null,
          chainDeviceMismatch: false,
          readError: 'ECONNREFUSED',
        },
      }),
    });
    expect(out.evaluated.bootTrail).toBe(false);
    expect(out.findings.map((f) => f.code)).toEqual(['PXE-107']);
  });

  it('sorts merged findings by code and carries the bmc address through', () => {
    const out = evaluate({
      bmcAddress: BMC_ADDRESS,
      prefixFindings: [
        { code: 'PXE-106', severity: 'error', message: 'split' },
        { code: 'PXE-102', severity: 'error', message: 'no dhcp' },
      ],
    });
    expect(out.bmcAddress).toBe(BMC_ADDRESS);
    expect(out.findings.map((f) => f.code)).toEqual(['PXE-102', 'PXE-106']);
  });
});
