import { describe, expect, it, vi } from 'vitest';

import { SnmpError, type Varbind, type WalkResult } from '../../../snmp';
import { SnmpMonitoringError, SnmpMonitoringService, createSnmpMonitoringService } from '../snmp.service';

function svc(): SnmpMonitoringService {
  return new SnmpMonitoringService('test');
}

function patchClient(
  service: SnmpMonitoringService,
  overrides: Partial<{ get: () => Promise<Varbind[]>; walk: () => Promise<WalkResult> }>,
): void {
  const client = (service as unknown as { client: Record<string, unknown> }).client;
  if (overrides.get) client.get = overrides.get;
  if (overrides.walk) client.walk = overrides.walk;
}

describe('SnmpMonitoringService validation', () => {
  it('validate ip strips whitespace and returns canonical', () => {
    const s = svc();
    expect(s.validateIpAddress('10.0.0.1')).toBe('10.0.0.1');
    expect(s.validateIpAddress('  192.168.1.1  ')).toBe('192.168.1.1');
  });

  it('validate ip invalid throws', () => {
    expect(() => svc().validateIpAddress('not-an-ip')).toThrow();
  });

  it('validate oid valid and leading-dot strip', () => {
    const s = svc();
    expect(s.validateOid('1.3.6.1.2.1')).toBe('1.3.6.1.2.1');
    expect(s.validateOid('.1.3.6.1.2.1')).toBe('1.3.6.1.2.1');
  });

  it('validate oid invalid throws', () => {
    expect(() => svc().validateOid('not.an.oid.abc')).toThrow();
  });

  it('validate port valid (int and numeric string)', () => {
    const s = svc();
    expect(s.validatePort(161)).toBe(161);
    expect(s.validatePort('161')).toBe(161);
  });

  it('validate port invalid', () => {
    const s = svc();
    expect(() => s.validatePort(0)).toThrow();
    expect(() => s.validatePort(70000)).toThrow();
    expect(() => s.validatePort('abc')).toThrow();
  });

  it('validate snmp params v2c', () => {
    const result = svc().validateSnmpParams({ version: '2c', community: 'public' });
    expect(result.version).toBe('2c');
    expect((result as { community?: string }).community).toBe('public');
  });

  it('v2c missing community throws', () => {
    expect(() => svc().validateSnmpParams({ version: '2c' })).toThrow(/community/i);
  });

  it('v3 defaults security_level to authPriv', () => {
    const result = svc().validateSnmpParams({
      version: '3',
      username: 'user',
      auth_protocol: 'SHA',
      auth_passphrase: 'auth',
      priv_protocol: 'DES',
      priv_passphrase: 'priv',
    });
    expect((result as { security_level?: string }).security_level).toBe('authPriv');
  });

  it('v3 missing username throws', () => {
    expect(() => svc().validateSnmpParams({ version: '3' })).toThrow(/username/i);
  });

  it('unsupported version throws', () => {
    expect(() => svc().validateSnmpParams({ version: '4' })).toThrow(/not supported|supported/i);
  });
});

describe('executeSnmpGet response shaping', () => {
  it('success returns success shape with target+data', async () => {
    const s = svc();
    const varbinds: Varbind[] = [{ oid: '1.3.6.1.2.1.1.1.0', type: 'Integer32', value: 42 }];
    patchClient(s, { get: vi.fn(async () => varbinds) });
    const result = await s.executeSnmpGet('10.0.0.1', 161, ['1.3.6.1.2.1.1.1.0'], {
      version: '2c',
      community: 'public',
    });
    expect(result.result).toBe('success');
    expect(result.target).toBe('10.0.0.1');
    if (result.result === 'success' || result.result === 'partial') {
      expect(result.data.length).toBe(1);
      expect(result.data[0].value).toBe(42);
    }
  });

  it('validation error wrapped in SnmpMonitoringError', async () => {
    await expect(
      svc().executeSnmpGet('not-an-ip', 161, ['1.3.6.1.2.1.1.1.0'], {
        version: '2c',
        community: 'public',
      }),
    ).rejects.toBeInstanceOf(SnmpMonitoringError);
  });

  it('client error returns failure shape', async () => {
    const s = svc();
    patchClient(s, {
      get: vi.fn(async () => {
        throw new SnmpError('timeout');
      }),
    });
    const result = await s.executeSnmpGet('10.0.0.1', 161, ['1.3.6.1.2.1.1.1.0'], {
      version: '2c',
      community: 'public',
    });
    expect(result.result).toBe('failure');
    if (result.result === 'failure') expect(result.error).toContain('timeout');
  });
});

describe('executeSnmpWalk response shaping with truncation', () => {
  it('success no truncation', async () => {
    const s = svc();
    const varbinds: Varbind[] = [{ oid: '1.3.6.1.2.1.1.1.0', type: 'Integer32', value: 1 }];
    patchClient(s, {
      walk: vi.fn(async () => ({ varbinds, truncated: false, truncationReason: null, hadError: false })),
    });
    const result = await s.executeSnmpWalk('10.0.0.1', 161, '1.3.6.1.2.1.1', {
      version: '2c',
      community: 'public',
    });
    expect(result.result).toBe('success');
    if (result.result === 'success') {
      expect((result as { truncated?: boolean }).truncated).toBeFalsy();
    }
  });

  it('truncated by max_results stays success', async () => {
    const s = svc();
    const varbinds: Varbind[] = Array.from({ length: 5 }, (_, i) => ({
      oid: `1.3.6.1.2.1.1.${i}.0`,
      type: 'Integer32',
      value: i,
    }));
    patchClient(s, {
      walk: vi.fn(async () => ({
        varbinds,
        truncated: true,
        truncationReason: 'Reached max_results limit (5)',
        hadError: false,
      })),
    });
    const result = await s.executeSnmpWalk('10.0.0.1', 161, '1.3.6.1.2.1.1', { version: '2c', community: 'public' }, 5);
    expect(result.result).toBe('success');
    if (result.result === 'success' || result.result === 'partial') {
      expect((result as { truncated?: boolean }).truncated).toBe(true);
      expect((result as { truncation_reason?: string | null }).truncation_reason).toContain('max_results');
    }
  });

  it('walk error returns partial', async () => {
    const s = svc();
    const varbinds: Varbind[] = [{ oid: '1.3.6.1.2.1.1.1.0', type: 'Integer32', value: 1 }];
    patchClient(s, {
      walk: vi.fn(async () => ({
        varbinds,
        truncated: true,
        truncationReason: 'Walk error after 1 results: timeout',
        hadError: true,
      })),
    });
    const result = await s.executeSnmpWalk('10.0.0.1', 161, '1.3.6.1.2.1.1', {
      version: '2c',
      community: 'public',
    });
    expect(result.result).toBe('partial');
    if (result.result === 'partial') {
      expect((result as { truncated?: boolean }).truncated).toBe(true);
      const reason = (result as { truncation_reason?: string | null }).truncation_reason ?? '';
      expect(reason.toLowerCase()).toContain('error');
    }
  });
});

describe('createSnmpMonitoringService', () => {
  it('returns service with jobId', () => {
    const s = createSnmpMonitoringService('job-1');
    expect(s).toBeInstanceOf(SnmpMonitoringService);
    expect(s.jobId).toBe('job-1');
  });
});
