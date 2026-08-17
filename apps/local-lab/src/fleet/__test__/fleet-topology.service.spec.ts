import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FleetTopologyService } from '../fleet-topology.service';

const { nicState } = vi.hoisted(() => ({
  nicState: { value: {} as Record<string, { family: string; address: string; internal: boolean }[]> },
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, networkInterfaces: () => nicState.value };
});

describe('FleetTopologyService.bakedChainUrl — D3 bake-stamp read', () => {
  const SAVED = process.env.LOCAL_IPXE_BUILDS_DIR;
  let dir: string;

  const bakedChainUrl = (svc: FleetTopologyService): string | null =>
    (svc as unknown as { bakedChainUrl(): string | null }).bakedChainUrl();

  const svc = () => new FleetTopologyService({} as never, {} as never, {} as never);
  const writeStamp = (contents: string): void => writeFileSync(join(dir, '.chain-stamp.json'), contents);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lab-chainstamp-'));
    process.env.LOCAL_IPXE_BUILDS_DIR = dir;
  });
  afterEach(() => {
    if (SAVED === undefined) delete process.env.LOCAL_IPXE_BUILDS_DIR;
    else process.env.LOCAL_IPXE_BUILDS_DIR = SAVED;
  });

  it('returns chain_base_url from a valid stamp', () => {
    writeStamp(JSON.stringify({ chain_base_url: 'http://198.51.100.14:8000', built_at: 1 }));
    expect(bakedChainUrl(svc())).toBe('http://198.51.100.14:8000');
  });

  it('returns null when the stamp file is missing', () => {
    expect(bakedChainUrl(svc())).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    writeStamp('{ not json');
    expect(bakedChainUrl(svc())).toBeNull();
  });

  it('returns null when chain_base_url is not a string', () => {
    writeStamp(JSON.stringify({ chain_base_url: 42 }));
    expect(bakedChainUrl(svc())).toBeNull();
  });

  it('returns null when chain_base_url is absent', () => {
    writeStamp(JSON.stringify({ built_at: 1 }));
    expect(bakedChainUrl(svc())).toBeNull();
  });
});

describe('FleetTopologyService.lanIp — fleet-subnet exclusions', () => {
  const lanIpOf = (network: { cidr?: string; bmc_cidr?: string }): string =>
    (
      new FleetTopologyService(
        {} as never,
        { fleetConfig: () => ({ network, defaults: {}, nodes: {} }) } as never,
        {} as never,
      ) as unknown as { lanIp(): string }
    ).lanIp();

  const nic = (address: string) => [{ family: 'IPv4', address, internal: false }];

  afterEach(() => {
    nicState.value = {};
  });

  it('excludes slot-0 data-plane and BMC addresses', () => {
    nicState.value = { en0: nic('192.168.200.10'), en1: nic('192.168.105.7'), en2: nic('192.168.1.42') };
    expect(lanIpOf({ cidr: '192.168.200.0/24', bmc_cidr: '192.168.105.0/24' })).toBe('192.168.1.42');
  });

  it('excludes slot-2 data-plane and BMC addresses', () => {
    nicState.value = { en0: nic('192.168.107.10'), en1: nic('192.168.202.5'), en2: nic('192.168.1.42') };
    expect(lanIpOf({ cidr: '192.168.202.0/24', bmc_cidr: '192.168.107.0/24' })).toBe('192.168.1.42');
  });
});
