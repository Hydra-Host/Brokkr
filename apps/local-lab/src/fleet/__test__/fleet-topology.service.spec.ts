import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FleetTopologyService } from '../fleet-topology.service';

const svc = () => new FleetTopologyService({} as never, {} as never, {} as never);

describe('FleetTopologyService.bakedChainUrl — D3 bake-stamp read', () => {
  const SAVED = process.env.LOCAL_IPXE_BUILDS_DIR;
  let dir: string;

  const bakedChainUrl = (svc: FleetTopologyService): string | null =>
    (svc as unknown as { bakedChainUrl(): string | null }).bakedChainUrl();

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

describe('FleetTopologyService.isIpxeBakedFor — bake completeness', () => {
  const SAVED = process.env.LOCAL_IPXE_BUILDS_DIR;
  const CHAIN = 'http://198.51.100.14:8000';
  let dir: string;

  const writeStamp = (url: string): void =>
    writeFileSync(join(dir, '.chain-stamp.json'), JSON.stringify({ chain_base_url: url }));
  const writeBinaries = (arches: string[]): void => {
    for (const arch of arches) {
      mkdirSync(join(dir, arch), { recursive: true });
      writeFileSync(join(dir, arch, 'snponly.efi'), 'efi');
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lab-ipxe-builds-'));
    process.env.LOCAL_IPXE_BUILDS_DIR = dir;
  });
  afterEach(() => {
    if (SAVED === undefined) delete process.env.LOCAL_IPXE_BUILDS_DIR;
    else process.env.LOCAL_IPXE_BUILDS_DIR = SAVED;
  });

  it('is baked when every arch binary exists and the stamp names the chain url', () => {
    writeBinaries(['amd64', 'arm64']);
    writeStamp(CHAIN);
    expect(svc().isIpxeBakedFor(CHAIN)).toBe(true);
  });

  it('is not baked when one arch binary is missing', () => {
    writeBinaries(['amd64']);
    writeStamp(CHAIN);
    expect(svc().isIpxeBakedFor(CHAIN)).toBe(false);
  });

  it('is not baked when the stamp names another chain url', () => {
    writeBinaries(['amd64', 'arm64']);
    writeStamp('http://198.51.100.99:8000');
    expect(svc().isIpxeBakedFor(CHAIN)).toBe(false);
  });

  it('is not baked when the stamp is missing', () => {
    writeBinaries(['amd64', 'arm64']);
    expect(svc().isIpxeBakedFor(CHAIN)).toBe(false);
  });
});

describe('FleetTopologyService.hostFacts — host-info shape', () => {
  const hostFacts = () =>
    new FleetTopologyService(
      {} as never,
      { fleetConfig: () => ({ network: { cidr: '192.168.200.0/24' }, defaults: {}, nodes: {} }) } as never,
      {} as never,
    ).hostFacts();

  it('exposes exactly os, arch and passthrough support, with no lan ip', () => {
    expect(Object.keys(hostFacts()).sort()).toEqual(['arch', 'os', 'passthroughSupported']);
  });

  it('omits the lan ip field entirely', () => {
    expect(hostFacts()).not.toHaveProperty('lanIp');
  });
});
