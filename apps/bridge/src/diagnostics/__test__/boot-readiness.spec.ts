import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BootFinding } from '@repo/utils';
import type { DhcpStandbyHealth } from '../../dhcp/dhcp-manager.service.js';
import { getIpxeConfig, resetIpxeConfigForTests } from '../../ipxe/ipxe.config.js';
import { resetTftpConfigForTests } from '../../tftp/tftp.config.js';
import { BootReadinessController } from '../boot-readiness.controller.js';
import {
  bootReadinessResponseSchema,
  buildLiveBootReadinessChecks,
  countBootFindings,
  evaluateBootReadiness,
  type BootReadinessCheck,
  type BootReadinessLiveDeps,
} from '../boot-readiness.js';

function check(name: string, result: readonly BootFinding[] | null): BootReadinessCheck {
  return { name, run: async () => result };
}

function health(overrides: Partial<DhcpStandbyHealth> = {}): DhcpStandbyHealth {
  return {
    isLeader: true,
    hydrated: true,
    answering: true,
    pxePortBound: true,
    claimFailureCount: 0,
    lastClaimError: null,
    hydrateStalledSince: null,
    primaryInterface: null,
    ...overrides,
  };
}

const IPXE_MISSING: BootFinding = { code: 'PXE-01', severity: 'error', message: 'no efi binary under /opt/brokkr' };
const CHAIN_WARN: BootFinding = { code: 'PXE-07', severity: 'warn', message: 'dns off' };
const UNEVALUATED: BootFinding = { code: 'PXE-107', severity: 'warn', message: 'atoms unreadable' };

describe('evaluateBootReadiness', () => {
  it('reports no findings and zero counts when every check is clear', async () => {
    const report = await evaluateBootReadiness([check('a', []), check('b', []), check('c', [])]);

    expect(report.findings).toEqual([]);
    expect(report.counts).toEqual({ error: 0, warn: 0, unevaluated: 0 });
  });

  it('reports PXE-107 and increments unevaluated when a subject is unreachable', async () => {
    const report = await evaluateBootReadiness([check('a', null), check('b', [])]);

    expect(report.findings).toEqual([{ code: 'PXE-107', severity: 'warn' }]);
    expect(report.counts.unevaluated).toBe(1);
    expect(report.counts.error).toBe(0);
  });

  it('reports PXE-107 rather than a pass when a check throws', async () => {
    const report = await evaluateBootReadiness([
      { name: 'boom', run: () => Promise.reject(new Error('ENOENT /opt/brokkr/ipxe-builds')) },
    ]);

    expect(report.findings.map((f) => f.code)).toEqual(['PXE-107']);
    expect(report.counts.unevaluated).toBe(1);
  });

  it('counts each finding by its own severity, not the registry default', async () => {
    const report = await evaluateBootReadiness([check('a', [IPXE_MISSING, CHAIN_WARN])]);

    expect(report.counts).toEqual({ error: 1, warn: 1, unevaluated: 0 });
  });

  it('drops the message so no path or address reaches the wire', async () => {
    const report = await evaluateBootReadiness([check('a', [IPXE_MISSING])]);

    expect(report.findings).toEqual([{ code: 'PXE-01', severity: 'error' }]);
  });
});

describe('countBootFindings', () => {
  it('counts error, warn and unevaluated over a finding list', () => {
    expect(countBootFindings([IPXE_MISSING, CHAIN_WARN, UNEVALUATED])).toEqual({ error: 1, warn: 2, unevaluated: 1 });
  });
});

describe('buildLiveBootReadinessChecks', () => {
  const env = { ...process.env };

  function deps(overrides: Partial<BootReadinessLiveDeps> = {}): BootReadinessLiveDeps {
    return {
      dhcp: { readAll: async () => ({ ok: true, configs: new Map() }) },
      dns: { readZoneConfig: async () => ({ ok: false, reason: 'missing' }) },
      fileExists: async () => true,
      readTextFile: async () => JSON.stringify({ chain_base_url: getIpxeConfig().bridgeUrl }),
      ...overrides,
    };
  }

  async function runNamed(checks: readonly BootReadinessCheck[], name: string): Promise<readonly BootFinding[] | null> {
    const found = checks.find((c) => c.name === name);
    if (found === undefined) throw new Error(`no check named ${name}`);
    return found.run();
  }

  beforeEach(() => {
    resetIpxeConfigForTests();
    resetTftpConfigForTests();
  });

  afterEach(() => {
    process.env = { ...env };
    resetIpxeConfigForTests();
  });

  it('builds the three startup evaluators and the dhcp answering check', () => {
    expect(buildLiveBootReadinessChecks(deps()).map((c) => c.name)).toEqual([
      'chain_reachability',
      'ipxe_builds',
      'discovery_images',
      'dhcp_answering',
    ]);
  });

  it('marks the chain check unevaluated when the DHCP atoms cannot be read', async () => {
    const checks = buildLiveBootReadinessChecks(deps({ dhcp: { readAll: async () => ({ ok: false }) } }));

    await expect(runNamed(checks, 'chain_reachability')).resolves.toBeNull();
  });

  it('marks the chain check unevaluated when the DNS zone atom read errors', async () => {
    const checks = buildLiveBootReadinessChecks(
      deps({ dns: { readZoneConfig: async () => ({ ok: false, reason: 'error' }) } }),
    );

    await expect(runNamed(checks, 'chain_reachability')).resolves.toBeNull();
  });

  it('treats an absent DNS zone atom as DNS off, not as unevaluated', async () => {
    process.env.BRIDGE_URL = 'http://10.0.1.2:8000';

    await expect(runNamed(buildLiveBootReadinessChecks(deps()), 'chain_reachability')).resolves.toEqual([]);
  });

  it('suppresses the resolver check when every configured prefix is PROXY', async () => {
    process.env.BRIDGE_URL = 'https://brokkr.lan';
    process.env.BRIDGE_TLS_TERMINATED = 'true';
    const configs = new Map([['p1', { mode: 'PROXY' as const }]]);

    const checks = buildLiveBootReadinessChecks(deps({ dhcp: { readAll: async () => ({ ok: true, configs }) } }));

    await expect(runNamed(checks, 'chain_reachability')).resolves.toEqual([]);
  });

  it('applies the resolver check when any prefix is AUTHORITATIVE', async () => {
    process.env.BRIDGE_URL = 'https://brokkr.lan';
    process.env.BRIDGE_TLS_TERMINATED = 'true';
    const configs = new Map([
      ['p1', { mode: 'PROXY' as const }],
      ['p2', { mode: 'AUTHORITATIVE' as const }],
    ]);

    const checks = buildLiveBootReadinessChecks(deps({ dhcp: { readAll: async () => ({ ok: true, configs }) } }));
    const findings = await runNamed(checks, 'chain_reachability');

    expect(findings?.map((f) => f.code)).toEqual(['PXE-07']);
  });

  it('reports no iPXE or discovery finding while every required file is present', async () => {
    const checks = buildLiveBootReadinessChecks(deps());

    await expect(runNamed(checks, 'ipxe_builds')).resolves.toEqual([]);
    await expect(runNamed(checks, 'discovery_images')).resolves.toEqual([]);
  });

  it('reports PXE-108 while the bake stamp is absent', async () => {
    process.env.BRIDGE_URL = 'http://10.0.1.2:8000';
    resetIpxeConfigForTests();

    const checks = buildLiveBootReadinessChecks(deps({ readTextFile: async () => null }));

    expect((await runNamed(checks, 'ipxe_builds'))?.map((f) => f.code)).toEqual(['PXE-108']);
  });

  it('reports PXE-109 while the bake names a different host than BRIDGE_URL', async () => {
    process.env.BRIDGE_URL = 'http://10.0.1.2:8000';
    resetIpxeConfigForTests();

    const checks = buildLiveBootReadinessChecks(
      deps({ readTextFile: async () => JSON.stringify({ chain_base_url: 'http://brokkr.lan:8000/api/chain' }) }),
    );

    expect((await runNamed(checks, 'ipxe_builds'))?.map((f) => f.code)).toEqual(['PXE-109']);
  });

  it('skips the ipxe check while tftp is off, matching the startup assert', async () => {
    process.env.TFTP_ENABLED = 'false';
    resetTftpConfigForTests();

    const checks = buildLiveBootReadinessChecks(
      deps({ fileExists: async () => false, readTextFile: async () => null }),
    );

    await expect(runNamed(checks, 'ipxe_builds')).resolves.toEqual([]);
  });

  it('reports the iPXE and discovery codes while the files are absent', async () => {
    const checks = buildLiveBootReadinessChecks(deps({ fileExists: async () => false }));

    const ipxe = await runNamed(checks, 'ipxe_builds');
    const discovery = await runNamed(checks, 'discovery_images');

    expect(new Set(ipxe?.map((f) => f.code))).toEqual(new Set(['PXE-01']));
    expect(new Set(discovery?.map((f) => f.code))).toEqual(new Set(['PXE-06']));
  });

  it('emits PXE-105 when a serving mode is configured and the engine is not answering', async () => {
    const configs = new Map([['p1', { mode: 'PROXY' as const }]]);
    const checks = buildLiveBootReadinessChecks(
      deps({
        dhcp: { readAll: async () => ({ ok: true, configs }) },
        standby: () => health({ answering: false, pxePortBound: false }),
      }),
    );

    const findings = await runNamed(checks, 'dhcp_answering');

    expect(findings?.map((f) => f.code)).toEqual(['PXE-105', 'PXE-105']);
  });

  it('reports the dhcp answering check clear when the engine answers and the pxe socket is bound', async () => {
    const configs = new Map([['p1', { mode: 'PROXY' as const }]]);
    const checks = buildLiveBootReadinessChecks(
      deps({
        dhcp: { readAll: async () => ({ ok: true, configs }) },
        standby: () => health({ answering: true, pxePortBound: true }),
      }),
    );

    await expect(runNamed(checks, 'dhcp_answering')).resolves.toEqual([]);
  });

  it('emits PXE-107 when the standby snapshot is null', async () => {
    const configs = new Map([['p1', { mode: 'PROXY' as const }]]);
    const checks = buildLiveBootReadinessChecks(
      deps({ dhcp: { readAll: async () => ({ ok: true, configs }) }, standby: () => null }),
    );

    const findings = await runNamed(checks, 'dhcp_answering');

    expect(findings?.map((f) => f.code)).toEqual(['PXE-107']);
  });

  it('skips the dhcp answering check when every atom is OFF', async () => {
    const configs = new Map([['p1', { mode: 'OFF' as const }]]);
    const checks = buildLiveBootReadinessChecks(
      deps({
        dhcp: { readAll: async () => ({ ok: true, configs }) },
        standby: () => health({ answering: false, pxePortBound: false }),
      }),
    );

    await expect(runNamed(checks, 'dhcp_answering')).resolves.toEqual([]);
  });

  it('does not require the pxe socket when no atom is PROXY', async () => {
    const configs = new Map([['p1', { mode: 'AUTHORITATIVE' as const }]]);
    const checks = buildLiveBootReadinessChecks(
      deps({
        dhcp: { readAll: async () => ({ ok: true, configs }) },
        standby: () => health({ answering: true, pxePortBound: false }),
      }),
    );

    await expect(runNamed(checks, 'dhcp_answering')).resolves.toEqual([]);
  });

  it('marks the dhcp answering check unevaluated when the DHCP atoms cannot be read', async () => {
    const checks = buildLiveBootReadinessChecks(deps({ dhcp: { readAll: async () => ({ ok: false }) } }));

    await expect(runNamed(checks, 'dhcp_answering')).resolves.toBeNull();
  });

  it('reads the dhcp atoms once for every check in one evaluation', async () => {
    const readAll = vi.fn(async () => ({ ok: true, configs: new Map() }));

    await evaluateBootReadiness(buildLiveBootReadinessChecks(deps({ dhcp: { readAll } })));

    expect(readAll).toHaveBeenCalledTimes(1);
  });
});

describe('BootReadinessController', () => {
  let sent: unknown;
  let status: number;

  const reply = {
    status(code: number) {
      status = code;
      return this;
    },
    send(body: unknown) {
      sent = body;
      return this;
    },
  };
  const req = { headers: {}, query: {} };

  beforeEach(() => {
    sent = undefined;
    status = 0;
  });

  it('serves codes, severities and counts', async () => {
    const controller = new BootReadinessController(() => [check('a', [IPXE_MISSING, CHAIN_WARN])]);

    await controller.bootReadiness(req as never, reply as never);

    expect(status).toBe(200);
    expect(sent).toEqual({
      findings: [
        { code: 'PXE-01', severity: 'error' },
        { code: 'PXE-07', severity: 'warn' },
      ],
      counts: { error: 1, warn: 1, unevaluated: 0 },
    });
  });

  it('sends no key named mac, ip, address or message', async () => {
    const controller = new BootReadinessController(() => [check('a', [IPXE_MISSING]), check('b', null)]);

    await controller.bootReadiness(req as never, reply as never);

    expect(sent).toEqual({
      findings: [
        { code: 'PXE-01', severity: 'error' },
        { code: 'PXE-107', severity: 'warn' },
      ],
      counts: { error: 1, warn: 1, unevaluated: 1 },
    });
  });

  it('answers 500 with no detail when the check factory throws', async () => {
    const controller = new BootReadinessController(() => {
      throw new Error('redis down at internal-host.example.com:6379');
    });

    await controller.bootReadiness(req as never, reply as never);

    expect(status).toBe(500);
    expect(sent).toEqual({ error: 'Internal server error' });
  });
});

describe('bootReadinessResponseSchema', () => {
  it('strips a message that reached a finding', () => {
    const parsed = bootReadinessResponseSchema.parse({
      findings: [{ code: 'PXE-01', severity: 'error', message: 'leak' }],
      counts: { error: 1, warn: 0, unevaluated: 0 },
    });

    expect(parsed).toEqual({
      findings: [{ code: 'PXE-01', severity: 'error' }],
      counts: { error: 1, warn: 0, unevaluated: 0 },
    });
  });

  it('rejects an unknown severity', () => {
    expect(() =>
      bootReadinessResponseSchema.parse({
        findings: [{ code: 'PXE-01', severity: 'fatal' }],
        counts: { error: 1, warn: 0, unevaluated: 0 },
      }),
    ).toThrow();
  });
});
