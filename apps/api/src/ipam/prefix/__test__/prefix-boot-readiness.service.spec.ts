import type { PrefixDhcpConfig } from '@repo/api-client';
import { BOOT_CODES } from '@repo/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HUB_BOOT_CHECKS, PrefixBootReadinessService } from '../prefix-boot-readiness.service';

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

describe('PrefixBootReadinessService', () => {
  const prefixRepository = { getDhcpConfig: vi.fn(), resolveBootIdentity: vi.fn() };
  const contextService = { requirePermission: vi.fn(), organizationId: 'org-1' };
  const service = new PrefixBootReadinessService(prefixRepository, contextService);

  const checkCodes = async (): Promise<string[]> => {
    const report = await service.check('prefix-1', { mac: PXE_MAC, bmcAddress: BMC_ADDRESS });
    return report.findings.map((finding) => finding.code);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prefixRepository.getDhcpConfig.mockResolvedValue(READY_CONFIG);
    prefixRepository.resolveBootIdentity.mockResolvedValue({ pxeDeviceId: 'device-1', bmcDeviceId: 'device-1' });
  });

  it('reports PXE-102 when the prefix builds no DHCP subnet', async () => {
    prefixRepository.getDhcpConfig.mockResolvedValue({ ...READY_CONFIG, dhcpMode: null });
    await expect(checkCodes()).resolves.toEqual(['PXE-102']);
  });

  it('reports PXE-102 when the DHCP mode is explicitly OFF', async () => {
    prefixRepository.getDhcpConfig.mockResolvedValue({ ...READY_CONFIG, dhcpMode: 'OFF' });
    await expect(checkCodes()).resolves.toEqual(['PXE-102']);
  });

  it('reports PXE-103 when the prefix offers no iPXE build target', async () => {
    prefixRepository.getDhcpConfig.mockResolvedValue({ ...READY_CONFIG, ipxeBuildTarget: null });
    await expect(checkCodes()).resolves.toEqual(['PXE-103']);
  });

  it('reports PXE-104 when the proxy allowlist excludes the MAC', async () => {
    prefixRepository.getDhcpConfig.mockResolvedValue({ ...READY_CONFIG, dhcpProxyAllowedMacs: [] });
    await expect(checkCodes()).resolves.toEqual(['PXE-104']);
  });

  it('reports PXE-106 when the MAC and the BMC address resolve to different devices', async () => {
    prefixRepository.resolveBootIdentity.mockResolvedValue({ pxeDeviceId: 'device-1', bmcDeviceId: 'device-2' });
    await expect(checkCodes()).resolves.toEqual(['PXE-106']);
  });

  it('names an unregistered PXE MAC instead of blaming two devices', async () => {
    prefixRepository.resolveBootIdentity.mockResolvedValue({ pxeDeviceId: null, bmcDeviceId: 'device-1' });

    const report = await service.check('prefix-1', { mac: PXE_MAC, bmcAddress: BMC_ADDRESS });

    expect(report.findings.map((finding) => finding.code)).toEqual(['PXE-106']);
    expect(report.findings[0].message).toContain(`No hub device carries the PXE MAC ${PXE_MAC}`);
    expect(report.findings[0].message).not.toContain('different hub devices');
  });

  it('names an unregistered BMC address instead of blaming two devices', async () => {
    prefixRepository.resolveBootIdentity.mockResolvedValue({ pxeDeviceId: 'device-1', bmcDeviceId: null });

    const report = await service.check('prefix-1', { mac: PXE_MAC, bmcAddress: BMC_ADDRESS });

    expect(report.findings[0].message).toContain(`No hub device carries the BMC address ${BMC_ADDRESS}`);
    expect(report.findings[0].message).not.toContain('different hub devices');
  });

  it('does not report PXE-106 when neither address resolves to a device', async () => {
    prefixRepository.resolveBootIdentity.mockResolvedValue({ pxeDeviceId: null, bmcDeviceId: null });
    await expect(checkCodes()).resolves.toEqual([]);
  });

  it('carries the registry severity on every finding', async () => {
    prefixRepository.getDhcpConfig.mockResolvedValue({ ...READY_CONFIG, dhcpMode: null, ipxeBuildTarget: null });
    prefixRepository.resolveBootIdentity.mockResolvedValue({ pxeDeviceId: 'device-1', bmcDeviceId: 'device-2' });
    const report = await service.check('prefix-1', { mac: PXE_MAC, bmcAddress: BMC_ADDRESS });
    expect(report.findings.length).toBeGreaterThan(0);
    for (const finding of report.findings) expect(finding.severity).toBe(BOOT_CODES[finding.code].severity);
  });

  it('orders findings by code, as the response schema promises', async () => {
    prefixRepository.getDhcpConfig.mockResolvedValue({ ...READY_CONFIG, dhcpMode: null, ipxeBuildTarget: null });
    prefixRepository.resolveBootIdentity.mockResolvedValue({ pxeDeviceId: 'device-1', bmcDeviceId: 'device-2' });
    const codes = await checkCodes();
    expect(codes.length).toBeGreaterThan(1);
    expect(codes).toEqual([...codes].sort());
  });

  it('reports nothing for a fully configured prefix', async () => {
    await expect(checkCodes()).resolves.toEqual([]);
  });

  it('runs every check the table declares', async () => {
    prefixRepository.resolveBootIdentity.mockResolvedValue({ pxeDeviceId: 'device-1', bmcDeviceId: 'device-2' });

    prefixRepository.getDhcpConfig.mockResolvedValue({ ...READY_CONFIG, dhcpMode: null, ipxeBuildTarget: null });
    const withoutDhcp = await checkCodes();

    prefixRepository.getDhcpConfig.mockResolvedValue({ ...READY_CONFIG, dhcpProxyAllowedMacs: [] });
    const withProxyRefusal = await checkCodes();

    const observed = [...new Set([...withoutDhcp, ...withProxyRefusal])].sort();
    expect(observed).toEqual(Object.keys(HUB_BOOT_CHECKS).sort());
  });
});
