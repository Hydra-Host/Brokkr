import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  REQUIRED_DISCOVERY_FILES,
  assertDiscoveryImages,
  evaluateDiscoveryImages,
  type DiscoveryImageInput,
  type FileExists,
} from '../discovery-image-assert.js';
import type { StartupLogger } from '../startup-deps.types.js';

function recordingLogger(): { logger: StartupLogger; errors: string[] } {
  const errors: string[] = [];
  const logger: StartupLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: (message) => {
      errors.push(message);
    },
    debug: () => undefined,
  };
  return { logger, errors };
}

const DIR = '/var/lib/brokkr/brokkr-live';

function existsFrom(present: ReadonlySet<string>): FileExists {
  return async (path) => present.has(path);
}

function allPresent(architectures: readonly string[]): Set<string> {
  const present = new Set<string>();
  for (const arch of architectures) {
    for (const file of REQUIRED_DISCOVERY_FILES) {
      present.add(join(DIR, 'full', arch, file));
    }
  }
  return present;
}

const input = (architectures: readonly string[]): DiscoveryImageInput => ({
  discoveryDir: DIR,
  flavors: ['full'],
  architectures,
});

describe('evaluateDiscoveryImages', () => {
  it('no findings when every required file exists for every arch', async () => {
    const arches = ['amd64', 'arm64'];
    const findings = await evaluateDiscoveryImages(input(arches), existsFrom(allPresent(arches)));
    expect(findings).toEqual([]);
  });

  it('reports the exact missing files for an arch', async () => {
    const arches = ['amd64'];
    const present = allPresent(arches);
    present.delete(join(DIR, 'full', 'amd64', 'brokkr-discovery.iso'));
    const findings = await evaluateDiscoveryImages(input(arches), existsFrom(present));
    expect(findings.map((f) => f.code)).toEqual(['PXE-06']);
    expect(findings[0]?.message).toContain('arch=amd64 is missing brokkr-discovery.iso');
  });

  it('reports a fully-missing arch dir as all files missing', async () => {
    const findings = await evaluateDiscoveryImages(input(['arm64']), existsFrom(new Set()));
    expect(findings.map((f) => f.code)).toEqual(['PXE-06']);
    expect(findings[0]?.message).toContain(REQUIRED_DISCOVERY_FILES.join(', '));
  });

  it('reports each configured flavor separately and names the flavor', async () => {
    const present = allPresent(['amd64']);
    const findings = await evaluateDiscoveryImages(
      { discoveryDir: DIR, flavors: ['light', 'full'], architectures: ['amd64'] },
      existsFrom(present),
    );
    expect(findings.map((f) => f.code)).toEqual(['PXE-06']);
    expect(findings[0]?.message).toContain('flavor=light arch=amd64 is missing');
    expect(findings[0]?.message).toContain(join(DIR, 'light', 'amd64'));
  });
});

describe('assertDiscoveryImages', () => {
  it('logs LOUD (error) per arch with missing files but does not throw by default', async () => {
    const { logger, errors } = recordingLogger();
    await expect(assertDiscoveryImages(input(['amd64', 'arm64']), existsFrom(new Set()), logger)).resolves.toHaveLength(
      2,
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('PXE-06');
    expect(errors.some((e) => e.includes('arch=amd64'))).toBe(true);
    expect(errors.some((e) => e.includes('arch=arm64'))).toBe(true);
  });

  it('throws under strict when an image is missing', async () => {
    const { logger } = recordingLogger();
    await expect(
      assertDiscoveryImages(input(['amd64']), existsFrom(new Set()), logger, { strict: true }),
    ).rejects.toThrow(/Discovery image assertion failed/);
  });

  it('is a no-op (no log, no throw) when all images exist', async () => {
    const { logger, errors } = recordingLogger();
    const arches = ['amd64'];
    await assertDiscoveryImages(input(arches), existsFrom(allPresent(arches)), logger, { strict: true });
    expect(errors).toEqual([]);
  });

  it('skips entirely when no architectures are configured', async () => {
    const { logger, errors } = recordingLogger();
    let called = false;
    await assertDiscoveryImages(
      input([]),
      async () => {
        called = true;
        return false;
      },
      logger,
      { strict: true },
    );
    expect(called).toBe(false);
    expect(errors).toEqual([]);
  });
});
