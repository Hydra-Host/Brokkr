import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BOOT_CODES, type BootFinding } from '@repo/utils';
import { evaluateChainReachability, type ChainReachabilityInput } from '../chain-reachability-assert.js';
import { evaluateDiscoveryImages, type DiscoveryImageInput } from '../discovery-image-assert.js';
import { evaluateIpxeBuilds, type IpxeBuildInput } from '../ipxe-build-assert.js';

const SEVERITIES: readonly string[] = ['error', 'warn', 'info'];

function expectBootFindings(findings: readonly BootFinding[], expectedCodes: readonly string[]): void {
  expect(findings.map((finding) => finding.code)).toEqual(expectedCodes);
  for (const finding of findings) {
    expect(Object.keys(finding).sort()).toEqual(['code', 'message', 'severity']);
    expect(Object.keys(BOOT_CODES)).toContain(finding.code);
    expect(SEVERITIES).toContain(finding.severity);
    expect(finding.message.length).toBeGreaterThan(0);
  }
}

function chainInput(overrides: Partial<ChainReachabilityInput> = {}): ChainReachabilityInput {
  return {
    bridgeUrl: 'https://brokkr.lan',
    listenHost: '0.0.0.0',
    dnsEnabled: true,
    dnsAdvertised: true,
    tlsTerminated: true,
    dhcpMode: 'AUTHORITATIVE',
    ...overrides,
  };
}

const IPXE_DIR = '/opt/brokkr/ipxe-builds';
const DISCOVERY_DIR = '/var/lib/brokkr/brokkr-live';

const IPXE_BRIDGE_URL = 'http://192.0.2.10:8000';
const ipxeStamp = async (): Promise<string> => JSON.stringify({ chain_base_url: IPXE_BRIDGE_URL });

const ipxeInput: IpxeBuildInput = {
  finalBuildsDir: IPXE_DIR,
  architectures: ['amd64', 'arm64'],
  bridgeUrl: IPXE_BRIDGE_URL,
};
const discoveryInput: DiscoveryImageInput = {
  discoveryDir: DISCOVERY_DIR,
  flavors: ['full'],
  architectures: ['amd64'],
};

describe('boot findings', () => {
  it('evaluateChainReachability returns registry-coded findings', () => {
    expect(evaluateChainReachability(chainInput())).toEqual([]);
    expectBootFindings(evaluateChainReachability(chainInput({ bridgeUrl: 'not a url' })), ['PXE-02']);
    expectBootFindings(evaluateChainReachability(chainInput({ dnsAdvertised: false, tlsTerminated: false })), [
      'PXE-07',
      'PXE-02',
    ]);
  });

  it('evaluateIpxeBuilds returns registry-coded findings', async () => {
    expect(await evaluateIpxeBuilds(ipxeInput, async () => true, ipxeStamp)).toEqual([]);
    const findings = await evaluateIpxeBuilds(ipxeInput, async () => false, ipxeStamp);
    expectBootFindings(findings, ['PXE-01', 'PXE-01']);
    expect(findings[0]?.message).toContain(join(IPXE_DIR, 'amd64'));
  });

  it('evaluateDiscoveryImages returns registry-coded findings', async () => {
    expect(await evaluateDiscoveryImages(discoveryInput, async () => true)).toEqual([]);
    const findings = await evaluateDiscoveryImages(discoveryInput, async () => false);
    expectBootFindings(findings, ['PXE-06']);
    expect(findings[0]?.message).toContain(join(DISCOVERY_DIR, 'full', 'amd64'));
  });
});
