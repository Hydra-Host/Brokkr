import { describe, expect, it } from 'vitest';

import { buildNetworkConfig } from '../network.config';

describe('buildNetworkConfig — defaults', () => {
  it('uses default values when env is empty', () => {
    const config = buildNetworkConfig({});
    expect(config.maxConcurrentScans).toBe(10);
    expect(config.defaultScanTimeout).toBe(60);
    expect(config.ipmiTimeoutMs).toBe(750);
    expect(config.ipmiPort).toBe(623);
    expect(config.redfishTimeoutMs).toBe(4000);
    expect(config.nmapMinParallelism).toBe(100);
    expect(config.nmapMinRate).toBe(256);
    expect(config.nmapMaxRetries).toBe(1);
    expect(config.nmapPrivileged).toBe(true);
  });
});

describe('buildNetworkConfig — nmap privilege gate', () => {
  it('defaults to unprivileged under the local sim', () => {
    expect(buildNetworkConfig({ LOCAL_SIMULATION_ENABLED: 'true' }).nmapPrivileged).toBe(false);
  });

  it('explicit NETWORK_NMAP_PRIVILEGED wins over the sim default', () => {
    expect(
      buildNetworkConfig({ LOCAL_SIMULATION_ENABLED: 'true', NETWORK_NMAP_PRIVILEGED: 'true' }).nmapPrivileged,
    ).toBe(true);
    expect(buildNetworkConfig({ NETWORK_NMAP_PRIVILEGED: 'false' }).nmapPrivileged).toBe(false);
  });
});

describe('buildNetworkConfig — overrides', () => {
  it('coerces numeric env strings for every NETWORK_* override', () => {
    const config = buildNetworkConfig({
      NETWORK_MAX_CONCURRENT_SCANS: '20',
      NETWORK_DEFAULT_SCAN_TIMEOUT: '120',
      NETWORK_IPMI_TIMEOUT_MS: '250',
      NETWORK_IPMI_PORT: '6230',
      NETWORK_REDFISH_TIMEOUT_MS: '4000',
      NETWORK_NMAP_PARALLELISM: '200',
      NETWORK_NMAP_RATE: '512',
      NETWORK_NMAP_RETRIES: '3',
    });
    expect(config.maxConcurrentScans).toBe(20);
    expect(config.defaultScanTimeout).toBe(120);
    expect(config.ipmiTimeoutMs).toBe(250);
    expect(config.ipmiPort).toBe(6230);
    expect(config.redfishTimeoutMs).toBe(4000);
    expect(config.nmapMinParallelism).toBe(200);
    expect(config.nmapMinRate).toBe(512);
    expect(config.nmapMaxRetries).toBe(3);
  });

  it('rejects empty-string env values', () => {
    expect(() => buildNetworkConfig({ NETWORK_MAX_CONCURRENT_SCANS: '' })).toThrow();
  });

  it('rejects non-numeric env values', () => {
    expect(() => buildNetworkConfig({ NETWORK_IPMI_PORT: 'abc' })).toThrow();
  });

  it('rejects float-shaped strings', () => {
    expect(() => buildNetworkConfig({ NETWORK_DEFAULT_SCAN_TIMEOUT: '60.0' })).toThrow();
  });

  it('rejects hex-prefixed strings', () => {
    expect(() => buildNetworkConfig({ NETWORK_NMAP_RATE: '0x10' })).toThrow();
  });

  it('rejects exponent-shaped strings', () => {
    expect(() => buildNetworkConfig({ NETWORK_NMAP_PARALLELISM: '1e3' })).toThrow();
  });

  it('accepts underscore digit grouping', () => {
    const config = buildNetworkConfig({ NETWORK_NMAP_RATE: '1_000' });
    expect(config.nmapMinRate).toBe(1000);
  });

  it('accepts surrounding whitespace and leading sign', () => {
    const config = buildNetworkConfig({
      NETWORK_IPMI_TIMEOUT_MS: ' 150 ',
      NETWORK_NMAP_RETRIES: '+2',
    });
    expect(config.ipmiTimeoutMs).toBe(150);
    expect(config.nmapMaxRetries).toBe(2);
  });
});
