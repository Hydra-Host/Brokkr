import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  IPXE_CHAIN_STAMP_FILENAME,
  assertIpxeBuilds,
  evaluateIpxeBuilds,
  type IpxeBuildInput,
  type ReadTextFile,
} from '../ipxe-build-assert.js';
import type { StartupLogger } from '../startup-deps.types.js';

const DIR = '/opt/brokkr/ipxe-builds';
const BRIDGE_URL = 'http://192.0.2.10:8000';
const STAMP_PATH = join(DIR, IPXE_CHAIN_STAMP_FILENAME);

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

const buildsPresent = async (): Promise<boolean> => true;

function stampReader(contents: string | null): ReadTextFile {
  return async (path) => (path === STAMP_PATH ? contents : null);
}

function stampFor(chainBaseUrl: string): ReadTextFile {
  return stampReader(JSON.stringify({ chain_base_url: chainBaseUrl, built_at: 1757462400 }));
}

const input = (bridgeUrl = BRIDGE_URL): IpxeBuildInput => ({
  finalBuildsDir: DIR,
  architectures: ['amd64'],
  bridgeUrl,
});

describe('evaluateIpxeBuilds bake stamp', () => {
  it('reports nothing when the baked chain host matches BRIDGE_URL', async () => {
    const findings = await evaluateIpxeBuilds(input(), buildsPresent, stampFor('http://192.0.2.10:8000/api/chain'));
    expect(findings).toEqual([]);
  });

  it('reports PXE-108 when the stamp is absent', async () => {
    const findings = await evaluateIpxeBuilds(input(), buildsPresent, stampReader(null));
    expect(findings.map((f) => f.code)).toEqual(['PXE-108']);
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.message).toContain(STAMP_PATH);
  });

  it('reports PXE-108 when the stamp carries no usable chain_base_url', async () => {
    const findings = await evaluateIpxeBuilds(input(), buildsPresent, stampReader('{"built_at": 1}'));
    expect(findings.map((f) => f.code)).toEqual(['PXE-108']);
  });

  it('reports PXE-109 naming both hosts when the bake targets another host', async () => {
    const findings = await evaluateIpxeBuilds(input(), buildsPresent, stampFor('http://brokkr.lan:8000/api/chain'));
    expect(findings.map((f) => f.code)).toEqual(['PXE-109']);
    expect(findings[0]?.message).toContain('brokkr.lan');
    expect(findings[0]?.message).toContain('192.0.2.10');
  });

  it('reports PXE-109 alongside PXE-01 when the builds are missing too', async () => {
    const findings = await evaluateIpxeBuilds(input(), async () => false, stampFor('http://brokkr.lan:8000/api/chain'));
    expect(findings.map((f) => f.code)).toEqual(['PXE-01', 'PXE-109']);
  });

  it('reports PXE-107 rather than passing when BRIDGE_URL cannot be parsed', async () => {
    const findings = await evaluateIpxeBuilds(
      input('brokkr.lan:8000'),
      buildsPresent,
      stampFor('http://192.0.2.10:8000/api/chain'),
    );
    expect(findings.map((f) => f.code)).toEqual(['PXE-107']);
    expect(findings[0]?.severity).toBe('warn');
  });
});

describe('assertIpxeBuilds bake stamp', () => {
  it('reports nothing and never throws when TFTP is disabled, whatever the stamp says', async () => {
    const { logger, errors, debugs } = recordingLogger();
    await expect(
      assertIpxeBuilds(input(), async () => false, stampReader(null), logger, {
        strict: true,
        tftpEnabled: false,
      }),
    ).resolves.toEqual([]);
    expect(errors).toEqual([]);
    expect(debugs).toHaveLength(1);
    expect(debugs[0]).toContain('TFTP is disabled');
  });

  it('throws under strict when TFTP is enabled and the bake targets another host', async () => {
    const { logger, errors } = recordingLogger();
    await expect(
      assertIpxeBuilds(input(), buildsPresent, stampFor('http://brokkr.lan:8000/api/chain'), logger, {
        strict: true,
        tftpEnabled: true,
      }),
    ).rejects.toThrow(/iPXE build assertion failed \(PXE-109\)/);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('[PXE-109]');
  });

  it('does not throw under strict on an unevaluable BRIDGE_URL, which is a warn', async () => {
    const { logger, errors } = recordingLogger();
    await expect(
      assertIpxeBuilds(input('brokkr.lan:8000'), buildsPresent, stampReader(null), logger, {
        strict: true,
        tftpEnabled: true,
      }),
    ).resolves.toHaveLength(1);
    expect(errors).toEqual([]);
  });
});
