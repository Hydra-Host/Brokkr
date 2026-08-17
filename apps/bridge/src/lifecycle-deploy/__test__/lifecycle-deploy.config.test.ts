import { afterEach, describe, expect, it } from 'vitest';

import { getDeploymentConfig, getDocaRepoUrl, resetDeploymentConfigForTests } from '../lifecycle-deploy.config.js';

const DOCA_VERSION = '3.3.0';

afterEach(() => {
  resetDeploymentConfigForTests();
});

describe('DeploymentConfig', () => {
  it('exposes ubuntu/server/pxe defaults', () => {
    const config = getDeploymentConfig();
    expect(config.defaultDistro).toBe('ubuntu');
    expect(config.defaultVariant).toBe('server');
    expect(config.defaultBootDevice).toBe('pxe');
  });

  it('returns the cached instance on subsequent calls', () => {
    const a = getDeploymentConfig();
    const b = getDeploymentConfig();
    expect(a).toBe(b);
  });
});

describe('getDocaRepoUrl', () => {
  it.each([
    ['ubuntu22.04', 'amd64', 'x86_64'],
    ['ubuntu22.04', 'arm64', 'arm64-sbsa'],
    ['ubuntu24.04', 'amd64', 'x86_64'],
    ['ubuntu24.04', 'arm64', 'arm64-sbsa'],
    ['ubuntu25.10', 'amd64', 'x86_64'],
    ['ubuntu25.10', 'arm64', 'arm64-sbsa'],
  ])('supported (%s, %s) returns expected URL', (osCodename, curtinArch, expectedArch) => {
    expect(getDocaRepoUrl(osCodename, curtinArch)).toBe(
      `https://linux.mellanox.com/public/repo/doca/${DOCA_VERSION}/${osCodename}/${expectedArch}/`,
    );
  });

  it.each([
    ['ubuntu26.04', 'amd64'],
    ['ubuntu26.04', 'arm64'],
  ])('ubuntu26.04 (%s/%s) raises — no published repo', (osCodename, curtinArch) => {
    expect(() => getDocaRepoUrl(osCodename, curtinArch)).toThrow(/no published repo/);
  });

  it('unknown codename raises', () => {
    expect(() => getDocaRepoUrl('debian12', 'amd64')).toThrow(/no published repo/);
  });

  it('unsupported curtin arch raises with mapping message', () => {
    expect(() => getDocaRepoUrl('ubuntu24.04', 'riscv64')).toThrow(/No DOCA repo arch mapping/);
  });

  it('unsupported curtin arch error uses single-quoted repr', () => {
    expect(() => getDocaRepoUrl('ubuntu24.04', 'riscv64')).toThrow(
      "No DOCA repo arch mapping for curtin arch 'riscv64'",
    );
  });

  it('error message for unsupported combo lists the full supported set', () => {
    try {
      getDocaRepoUrl('ubuntu26.04', 'amd64');
      expect.fail('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('supported:');
      expect(msg).toContain('ubuntu24.04');
    }
  });

  it('error message uses sorted tuple repr', () => {
    try {
      getDocaRepoUrl('ubuntu26.04', 'amd64');
      expect.fail('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(
        "[('ubuntu22.04', 'aarch64'), ('ubuntu22.04', 'arm64-sbsa'), ('ubuntu22.04', 'x86_64'), " +
          "('ubuntu24.04', 'aarch64'), ('ubuntu24.04', 'arm64-sbsa'), ('ubuntu24.04', 'x86_64'), " +
          "('ubuntu25.10', 'arm64-sbsa'), ('ubuntu25.10', 'x86_64')]",
      );
    }
  });
});
