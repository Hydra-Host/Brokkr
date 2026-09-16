import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  IPXE_BUILD_FILENAMES,
  assertIpxeBuilds,
  evaluateIpxeBuilds,
  type FileExists,
  type IpxeBuildInput,
  type ReadTextFile,
} from '../ipxe-build-assert.js';
import type { StartupLogger } from '../startup-deps.types.js';

function recordingLogger(): { logger: StartupLogger; errors: string[]; debugs: string[] } {
  const errors: string[] = [];
  const debugs: string[] = [];
  const logger: StartupLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: (message) => {
      errors.push(message);
    },
    debug: (message) => {
      debugs.push(message);
    },
  };
  return { logger, errors, debugs };
}

const DIR = '/opt/brokkr/ipxe-builds';

const SNPONLY = 'snponly.efi';
const IPXE = 'ipxe.efi';
const SNP = 'snp.efi';

function existsFrom(present: ReadonlySet<string>): FileExists {
  return async (path) => present.has(path);
}

function presentWith(architectures: readonly string[], filename: string): Set<string> {
  const present = new Set<string>();
  for (const arch of architectures) {
    present.add(join(DIR, arch, filename));
  }
  return present;
}

const BRIDGE_URL = 'http://192.0.2.10:8000';

const input = (architectures: readonly string[]): IpxeBuildInput => ({
  finalBuildsDir: DIR,
  architectures,
  bridgeUrl: BRIDGE_URL,
});

const matchingStamp: ReadTextFile = async () => JSON.stringify({ chain_base_url: BRIDGE_URL });

describe('evaluateIpxeBuilds', () => {
  it('no finding when only snponly.efi is present for an arch', async () => {
    const arches = ['amd64', 'arm64'];
    const findings = await evaluateIpxeBuilds(input(arches), existsFrom(presentWith(arches, SNPONLY)), matchingStamp);
    expect(findings).toEqual([]);
  });

  it('no finding when only ipxe.efi is present for an arch', async () => {
    const arches = ['amd64', 'arm64'];
    const findings = await evaluateIpxeBuilds(input(arches), existsFrom(presentWith(arches, IPXE)), matchingStamp);
    expect(findings).toEqual([]);
  });

  it('no finding when only snp.efi is present for an arch', async () => {
    const arches = ['amd64', 'arm64'];
    const findings = await evaluateIpxeBuilds(input(arches), existsFrom(presentWith(arches, SNP)), matchingStamp);
    expect(findings).toEqual([]);
  });

  it('one finding for an arch with none of the three target binaries', async () => {
    const arches = ['amd64', 'arm64'];
    const present = presentWith(['amd64'], SNP);
    const findings = await evaluateIpxeBuilds(input(arches), existsFrom(present), matchingStamp);
    expect(findings.map((f) => f.code)).toEqual(['PXE-01']);
    expect(findings[0]?.message).toContain(join(DIR, 'arm64'));
    expect(IPXE_BUILD_FILENAMES.every((f) => findings[0]?.message.includes(f))).toBe(true);
  });

  it('reports every arch when the builds dir is empty', async () => {
    const findings = await evaluateIpxeBuilds(input(['amd64', 'arm64']), existsFrom(new Set()), matchingStamp);
    expect(findings.map((f) => f.code)).toEqual(['PXE-01', 'PXE-01']);
    expect(findings[0]?.message).toContain(join(DIR, 'amd64'));
    expect(findings[1]?.message).toContain(join(DIR, 'arm64'));
  });
});

describe('assertIpxeBuilds', () => {
  it('logs LOUD (error) per arch with no valid binary but does not throw by default', async () => {
    const { logger, errors } = recordingLogger();
    await expect(
      assertIpxeBuilds(input(['amd64', 'arm64']), existsFrom(new Set()), matchingStamp, logger),
    ).resolves.toHaveLength(2);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('PXE-01');
    expect(errors.some((e) => e.includes('arch=amd64') && IPXE_BUILD_FILENAMES.every((f) => e.includes(f)))).toBe(true);
    expect(errors.some((e) => e.includes('arch=arm64'))).toBe(true);
    expect(errors.every((e) => e.includes('DISCOVERY_ARCHITECTURES'))).toBe(true);
  });

  it('throws under strict when an arch has none of the valid target binaries', async () => {
    const { logger } = recordingLogger();
    await expect(
      assertIpxeBuilds(input(['amd64']), existsFrom(new Set()), matchingStamp, logger, { strict: true }),
    ).rejects.toThrow(/iPXE build assertion failed/);
  });

  it('does not throw under strict when each arch has at least one valid binary', async () => {
    const { logger, errors } = recordingLogger();
    const arches = ['amd64', 'arm64'];
    const present = new Set<string>([join(DIR, 'amd64', IPXE), join(DIR, 'arm64', SNP)]);
    await assertIpxeBuilds(input(arches), existsFrom(present), matchingStamp, logger, { strict: true });
    expect(errors).toEqual([]);
  });

  it('with TFTP disabled, downgrades to debug and never errors or throws', async () => {
    const { logger, errors, debugs } = recordingLogger();
    await expect(
      assertIpxeBuilds(input(['amd64', 'arm64']), existsFrom(new Set()), matchingStamp, logger, {
        strict: true,
        tftpEnabled: false,
      }),
    ).resolves.toEqual([]);
    expect(errors).toEqual([]);
    expect(debugs).toHaveLength(1);
    expect(debugs[0]).toContain('TFTP is disabled');
  });

  it('skips entirely when no architectures are served', async () => {
    const { logger, errors } = recordingLogger();
    let called = false;
    await assertIpxeBuilds(
      input([]),
      async () => {
        called = true;
        return false;
      },
      matchingStamp,
      logger,
      { strict: true },
    );
    expect(called).toBe(false);
    expect(errors).toEqual([]);
  });
});
