import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CallStackEntry, JsonRecord } from '../vendor/base/base.js';
import { RedfishDevice } from '../vendor/base/base.js';
import { RedfishBiosHandler } from '../vendor/base/bios.js';

interface FetchCall {
  method: string;
  endpoint: string;
  payload: JsonRecord;
  headers?: Record<string, string>;
}

interface HandlerHarness {
  device: RedfishDevice;
  handler: RedfishBiosHandler;
  queue: (response: JsonRecord, headers?: Record<string, string>) => void;
  calls: FetchCall[];
}

const BOOLEAN_ATTR: JsonRecord = {
  AttributeName: 'Hyperthreading',
  Type: 'Boolean',
  ReadOnly: false,
  ResetRequired: true,
};
const INTEGER_ATTR: JsonRecord = {
  AttributeName: 'MemTestLoops',
  Type: 'Integer',
  ReadOnly: false,
  ResetRequired: false,
  LowerBound: 0,
  UpperBound: 10,
  ScalarIncrement: 1,
};
const ENUM_BOOTMODE: JsonRecord = {
  AttributeName: 'BootMode',
  Type: 'Enumeration',
  ReadOnly: false,
  ResetRequired: true,
  Value: [
    { ValueName: 'Uefi', ValueDisplayName: 'UEFI' },
    { ValueName: 'Bios', ValueDisplayName: 'Legacy' },
  ],
};
const ENUM_SECUREBOOT: JsonRecord = {
  AttributeName: 'SecureBoot',
  Type: 'Enumeration',
  ReadOnly: false,
  ResetRequired: true,
  Value: [
    { ValueName: 'Enabled', ValueDisplayName: 'Enabled' },
    { ValueName: 'Disabled', ValueDisplayName: 'Disabled' },
  ],
};
const ENUM_TPM: JsonRecord = {
  AttributeName: 'TpmSecurity',
  Type: 'Enumeration',
  ReadOnly: false,
  ResetRequired: true,
  Value: [
    { ValueName: 'On', ValueDisplayName: 'On' },
    { ValueName: 'Off', ValueDisplayName: 'Off' },
  ],
};
const STRING_ATTR: JsonRecord = {
  AttributeName: 'AssetTag',
  Type: 'String',
  ReadOnly: false,
  ResetRequired: false,
  MinLength: 0,
  MaxLength: 32,
  ValueExpression: '^[A-Za-z0-9-]*$',
};
const READONLY_ATTR: JsonRecord = {
  AttributeName: 'SystemMfgDate',
  Type: 'String',
  ReadOnly: true,
  ResetRequired: false,
  MinLength: 0,
  MaxLength: 32,
  ValueExpression: null,
};
const IMMUTABLE_ATTR: JsonRecord = {
  AttributeName: 'PlatformSerialNumber',
  Type: 'String',
  ReadOnly: false,
  Immutable: true,
  ResetRequired: false,
  MinLength: 0,
  MaxLength: 32,
  ValueExpression: null,
};
const BAD_TYPE_ATTR: JsonRecord = {
  AttributeName: 'MysteryAttr',
  Type: 'Object',
  ReadOnly: false,
  ResetRequired: false,
};

function fullRegistry(): Record<string, JsonRecord> {
  return {
    Hyperthreading: { ...BOOLEAN_ATTR },
    MemTestLoops: { ...INTEGER_ATTR },
    BootMode: { ...ENUM_BOOTMODE },
    SecureBoot: { ...ENUM_SECUREBOOT },
    TpmSecurity: { ...ENUM_TPM },
    AssetTag: { ...STRING_ATTR },
    SystemMfgDate: { ...READONLY_ATTR },
    PlatformSerialNumber: { ...IMMUTABLE_ATTR },
    MysteryAttr: { ...BAD_TYPE_ATTR },
  };
}

function successResponse(): JsonRecord {
  return {
    '@Message.ExtendedInfo': [
      { Message: 'The request completed successfully.', Resolution: 'No response action is required.' },
    ],
  };
}

function errorResponse(message: string): JsonRecord {
  return { error: { '@Message.ExtendedInfo': [{ Message: message, Resolution: 'Fix it.', MessageArgs: [] }] } };
}

function retryResponse(): JsonRecord {
  return {
    error: {
      '@Message.ExtendedInfo': [
        {
          Message: 'Service busy.',
          Resolution: 'Wait for the indicated retry duration and retry the operation.',
          MessageArgs: ['7'],
        },
      ],
    },
  };
}

interface BuildOptions {
  vendor?: string;
  controller?: string;
  model?: string;
  registry?: Record<string, JsonRecord>;
  biosPatchEndpoint?: string;
  biosGetEndpoint?: string;
  params?: JsonRecord;
  pending?: JsonRecord;
  biosRetryAttempts?: number;
}

function buildHarness(opts: BuildOptions = {}): HandlerHarness {
  const device = new RedfishDevice('job-test', 'dev-1', '10.0.0.1', 'root', 'calvin');
  device.vendor = opts.vendor ?? 'dell';
  device.controller = opts.controller ?? 'idrac9';
  device.model = opts.model ?? 'r7615';
  device.registry = opts.registry ?? fullRegistry();
  device.biosPatchEndpoint = opts.biosPatchEndpoint ?? '/redfish/v1/Systems/System.Embedded.1/Bios/Settings';
  device.biosGetEndpoint = opts.biosGetEndpoint ?? '/redfish/v1/Systems/System.Embedded.1/Bios';
  device.biosParams = opts.params ?? {};
  device.biosPendingParams = opts.pending ?? {};
  device.biosRetryAttempts = opts.biosRetryAttempts ?? 3;

  const handler = new RedfishBiosHandler(device, 'job-test');
  const queued: { response: JsonRecord; headers: Record<string, string> }[] = [];
  const calls: FetchCall[] = [];

  vi.spyOn(handler, 'fetch').mockImplementation(async (method, endpoint, payload, headers) => {
    calls.push({ method, endpoint, payload, headers });
    const next = queued.shift() ?? { response: successResponse(), headers: {} };
    const entry: CallStackEntry = {
      method,
      endpoint,
      request: payload,
      response: next.response,
      responseHeaders: next.headers,
      status: 200,
    };
    device.callStack.push(entry);
    return next.response;
  });

  return {
    device,
    handler,
    queue: (response, headers = {}) => queued.push({ response, headers }),
    calls,
  };
}

beforeEach(() => {
  delete process.env.LOCAL_SIMULATION_ENABLED;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('setBiosParam guards', () => {
  it('missing patch endpoint returns null', async () => {
    const h = buildHarness({ biosPatchEndpoint: '' });
    const result = await h.handler.setBiosParam('BootMode', 'Uefi');
    expect(result).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('unknown key with registry returns null', async () => {
    const h = buildHarness();
    const result = await h.handler.setBiosParam('CompletelyMadeUpKey', 'X');
    expect(result).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('single similar prefix match falls through and patches with the caller key', async () => {
    const h = buildHarness();
    h.queue(successResponse());
    const result = await h.handler.setBiosParam('Hyperthread', true);
    expect(result).toBe(true);
    expect(h.calls[0]?.payload).toEqual({ Attributes: { Hyperthread: true } });
  });

  it('ambiguous prefix returns null', async () => {
    const registry = fullRegistry();
    registry['TpmSomething'] = { ...ENUM_TPM, AttributeName: 'TpmSomething' };
    const h = buildHarness({ registry });
    const result = await h.handler.setBiosParam('Tpm', 'On');
    expect(result).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('readonly attribute short-circuits true', async () => {
    const h = buildHarness();
    const result = await h.handler.setBiosParam('SystemMfgDate', '2024-01-01');
    expect(result).toBe(true);
    expect(h.calls).toEqual([]);
  });

  it('immutable attribute short-circuits true', async () => {
    const h = buildHarness();
    const result = await h.handler.setBiosParam('PlatformSerialNumber', 'SN-1234');
    expect(result).toBe(true);
    expect(h.calls).toEqual([]);
  });

  it('unknown type returns null', async () => {
    const h = buildHarness();
    const result = await h.handler.setBiosParam('MysteryAttr', 'x');
    expect(result).toBeNull();
    expect(h.calls).toEqual([]);
  });
});

describe('boolean coercion', () => {
  it.each([
    ['true', true],
    ['True', true],
    ['yes', true],
    ['on', true],
    ['1', true],
    ['false', false],
    ['FALSE', false],
    ['no', false],
    ['off', false],
    ['0', false],
  ])('coerces %s to %s', async (raw, expected) => {
    const h = buildHarness();
    h.queue(successResponse());
    const result = await h.handler.setBiosParam('Hyperthreading', raw);
    expect(result).toBe(true);
    expect(h.calls[0]?.payload).toEqual({ Attributes: { Hyperthreading: expected } });
  });

  it('int 1 is true', async () => {
    const h = buildHarness();
    h.queue(successResponse());
    await h.handler.setBiosParam('Hyperthreading', 1);
    expect(h.calls[0]?.payload).toEqual({ Attributes: { Hyperthreading: true } });
  });

  it('int 0 also coerces to true', async () => {
    const h = buildHarness();
    h.queue(successResponse());
    await h.handler.setBiosParam('Hyperthreading', 0);
    expect(h.calls[0]?.payload).toEqual({ Attributes: { Hyperthreading: true } });
  });
});

describe('integer validation', () => {
  it('in-range int accepted', async () => {
    const h = buildHarness();
    h.queue(successResponse());
    const result = await h.handler.setBiosParam('MemTestLoops', 3);
    expect(result).toBe(true);
    expect(h.calls[0]?.payload).toEqual({ Attributes: { MemTestLoops: 3 } });
  });

  it('digit string coerced', async () => {
    const h = buildHarness();
    h.queue(successResponse());
    await h.handler.setBiosParam('MemTestLoops', '5');
    expect(h.calls[0]?.payload).toEqual({ Attributes: { MemTestLoops: 5 } });
  });

  it('non-digit string rejected', async () => {
    const h = buildHarness();
    const result = await h.handler.setBiosParam('MemTestLoops', 'five');
    expect(result).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('float with fractional part rejected', async () => {
    const h = buildHarness();
    const result = await h.handler.setBiosParam('MemTestLoops', 3.5);
    expect(result).toBeNull();
  });

  it('below lower bound rejected', async () => {
    const h = buildHarness();
    const result = await h.handler.setBiosParam('MemTestLoops', -1);
    expect(result).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('above upper bound rejected', async () => {
    const h = buildHarness();
    const result = await h.handler.setBiosParam('MemTestLoops', 9999);
    expect(result).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('scalar increment violation rejected', async () => {
    const registry = fullRegistry();
    registry['MemTestLoops'] = { ...INTEGER_ATTR, ScalarIncrement: 2 };
    const h = buildHarness({ registry });
    const result = await h.handler.setBiosParam('MemTestLoops', 3);
    expect(result).toBeNull();
    expect(h.calls).toEqual([]);
  });
});

describe('enumeration validation', () => {
  it.each([
    ['BootMode', 'Uefi'],
    ['SecureBoot', 'Enabled'],
    ['TpmSecurity', 'On'],
  ])('accepts valid value %s=%s', async (key, value) => {
    const h = buildHarness();
    h.queue(successResponse());
    const result = await h.handler.setBiosParam(key, value);
    expect(result).toBe(true);
    expect(h.calls[0]?.payload).toEqual({ Attributes: { [key]: value } });
  });

  it('invalid enum value rejected', async () => {
    const h = buildHarness();
    const result = await h.handler.setBiosParam('BootMode', 'QuantumMode');
    expect(result).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('supermicro accepts ValueDisplayName', async () => {
    const h = buildHarness({ vendor: 'supermicro', controller: 'aspeed', model: 'superserver' });
    h.queue(successResponse());
    const result = await h.handler.setBiosParam('BootMode', 'UEFI');
    expect(result).toBe(true);
    expect(h.calls[0]?.payload).toEqual({ Attributes: { BootMode: 'UEFI' } });
  });

  it('non-supermicro rejects display name', async () => {
    const h = buildHarness({ vendor: 'dell' });
    const result = await h.handler.setBiosParam('BootMode', 'UEFI');
    expect(result).toBeNull();
    expect(h.calls).toEqual([]);
  });
});

describe('string validation', () => {
  it('string within limits accepted', async () => {
    const h = buildHarness();
    h.queue(successResponse());
    const result = await h.handler.setBiosParam('AssetTag', 'ABC-001');
    expect(result).toBe(true);
    expect(h.calls[0]?.payload).toEqual({ Attributes: { AssetTag: 'ABC-001' } });
  });

  it('string too long rejected', async () => {
    const h = buildHarness();
    const result = await h.handler.setBiosParam('AssetTag', 'x'.repeat(33));
    expect(result).toBeNull();
  });

  it('string too short rejected', async () => {
    const registry = fullRegistry();
    registry['AssetTag'] = { ...STRING_ATTR, MinLength: 4 };
    const h = buildHarness({ registry });
    const result = await h.handler.setBiosParam('AssetTag', 'x');
    expect(result).toBeNull();
  });

  it('string failing value expression rejected', async () => {
    const h = buildHarness();
    const result = await h.handler.setBiosParam('AssetTag', 'BAD_TAG');
    expect(result).toBeNull();
  });

  it('null value expression skips regex', async () => {
    const registry = fullRegistry();
    registry['FreeText'] = {
      AttributeName: 'FreeText',
      Type: 'String',
      ReadOnly: false,
      ResetRequired: false,
      MinLength: 0,
      MaxLength: 100,
      ValueExpression: null,
    };
    const h = buildHarness({ registry });
    h.queue(successResponse());
    const result = await h.handler.setBiosParam('FreeText', 'hello world');
    expect(result).toBe(true);
  });
});

describe('already-set short-circuits', () => {
  it('already pending returns true without fetch', async () => {
    const h = buildHarness({ pending: { BootMode: 'Uefi' } });
    const result = await h.handler.setBiosParam('BootMode', 'Uefi');
    expect(result).toBe(true);
    expect(h.calls).toEqual([]);
  });

  it('already set returns true without fetch', async () => {
    const h = buildHarness({ params: { BootMode: 'Uefi' } });
    const result = await h.handler.setBiosParam('BootMode', 'Uefi');
    expect(result).toBe(true);
    expect(h.calls).toEqual([]);
  });

  it('nested parent already pending', async () => {
    const h = buildHarness({ pending: { SystemBiosSettings: { BootMode: 'Uefi' } } });
    const result = await h.handler.setBiosParam('BootMode', 'Uefi', 'SystemBiosSettings');
    expect(result).toBe(true);
    expect(h.calls).toEqual([]);
  });
});

describe('parent-key nesting', () => {
  it('nests payload under parent_key', async () => {
    const h = buildHarness();
    h.queue(successResponse());
    const result = await h.handler.setBiosParam('BootMode', 'Uefi', 'SystemBiosSettings');
    expect(result).toBe(true);
    expect(h.calls[0]?.payload).toEqual({ Attributes: { SystemBiosSettings: { BootMode: 'Uefi' } } });
  });
});

describe('aivres etag', () => {
  it('aivres fetches ETag and sends If-Match', async () => {
    const h = buildHarness({ vendor: 'aivres', controller: 'ast2600', model: 'kr6288' });
    h.queue({}, { etag: 'W/"abc123"' });
    h.queue(successResponse());
    const result = await h.handler.setBiosParam('BootMode', 'Uefi');
    expect(result).toBe(true);
    expect(h.calls[0]?.method).toBe('GET');
    expect(h.calls[0]?.endpoint).toBe(h.device.biosGetEndpoint);
    expect(h.calls[1]?.method).toBe('PATCH');
    expect(h.calls[1]?.headers).toEqual({ 'If-Match': 'W/"abc123"' });
  });

  it('aivres without ETag omits If-Match', async () => {
    const h = buildHarness({ vendor: 'aivres', controller: 'ast2600', model: 'kr6288' });
    h.queue({}, {});
    h.queue(successResponse());
    const result = await h.handler.setBiosParam('BootMode', 'Uefi');
    expect(result).toBe(true);
    expect(h.calls[1]?.headers).toEqual({});
  });
});

describe('retry on busy', () => {
  it('retries then succeeds with 15s fallback sleep', async () => {
    const sleepSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const h = buildHarness({ biosRetryAttempts: 3 });
    h.queue(retryResponse());
    h.queue(successResponse());
    const result = await h.handler.setBiosParam('BootMode', 'Uefi');
    expect(result).toBe(true);
    const patchCalls = h.calls.filter((c) => c.method === 'PATCH');
    expect(patchCalls.length).toBe(2);
    const fifteenSecondCall = sleepSpy.mock.calls.find((args) => args[1] === 15000);
    expect(fifteenSecondCall).toBeDefined();
    sleepSpy.mockRestore();
  });

  it('exhausts retries and returns null', async () => {
    const sleepSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const h = buildHarness({ biosRetryAttempts: 2 });
    h.queue(retryResponse());
    h.queue(retryResponse());
    h.queue(retryResponse());
    const result = await h.handler.setBiosParam('BootMode', 'Uefi');
    expect(result).toBeNull();
    sleepSpy.mockRestore();
  });
});

describe('result paths', () => {
  it('success with ResetRequired marks pending and reboot', async () => {
    const h = buildHarness();
    h.queue(successResponse());
    const result = await h.handler.setBiosParam('BootMode', 'Uefi');
    expect(result).toBe(true);
    expect(h.device.rebootNeeded).toBe(true);
    expect(h.device.biosPendingParams).toEqual({ BootMode: 'Uefi' });
    expect('BootMode' in h.device.biosParams).toBe(false);
  });

  it('success with ResetRequired nested creates parent', async () => {
    const h = buildHarness();
    h.queue(successResponse());
    const result = await h.handler.setBiosParam('BootMode', 'Uefi', 'SystemBiosSettings');
    expect(result).toBe(true);
    expect(h.device.biosPendingParams).toEqual({ SystemBiosSettings: { BootMode: 'Uefi' } });
  });

  it('success without ResetRequired updates live params', async () => {
    const h = buildHarness();
    h.queue(successResponse());
    const result = await h.handler.setBiosParam('MemTestLoops', 5);
    expect(result).toBe(true);
    expect(h.device.rebootNeeded).toBe(false);
    expect(h.device.biosParams).toEqual({ MemTestLoops: 5 });
  });

  it('readonly-dependency warning treated as success without recording', async () => {
    const h = buildHarness();
    h.queue({
      '@Message.ExtendedInfo': [
        {
          Message: 'Unable to modify the attribute because the attribute is read-only and depends on other attributes.',
          Resolution: 'Modify the dependencies first.',
        },
      ],
    });
    const result = await h.handler.setBiosParam('BootMode', 'Uefi');
    expect(result).toBe(true);
    expect(h.device.biosPendingParams).toEqual({});
  });

  it('no messages returns null', async () => {
    const h = buildHarness();
    h.queue({});
    const result = await h.handler.setBiosParam('BootMode', 'Uefi');
    expect(result).toBeNull();
  });

  it('other error message returns null', async () => {
    const h = buildHarness();
    h.queue(errorResponse('Invalid attribute value.'));
    const result = await h.handler.setBiosParam('BootMode', 'Uefi');
    expect(result).toBeNull();
  });

  it('alt success phrasing "completed successfully" still passes', async () => {
    const h = buildHarness();
    h.queue({ '@Message.ExtendedInfo': [{ Message: 'The operation completed successfully.', Resolution: 'None.' }] });
    const result = await h.handler.setBiosParam('BootMode', 'Uefi');
    expect(result).toBe(true);
  });
});

describe('registry-less fallback', () => {
  it('no registry skips validation and marks reboot', async () => {
    const h = buildHarness({ registry: {} });
    h.queue(successResponse());
    const result = await h.handler.setBiosParam('SomeRandomKey', 'whatever');
    expect(result).toBe(true);
    expect(h.device.rebootNeeded).toBe(true);
    expect(h.device.biosParams).toEqual({});
    expect(h.device.biosPendingParams).toEqual({});
    expect(h.calls[0]?.payload).toEqual({ Attributes: { SomeRandomKey: 'whatever' } });
  });
});

describe('handler init', () => {
  it('inherits device and jobId', () => {
    const device = new RedfishDevice('j', '1', '1.2.3.4');
    const handler = new RedfishBiosHandler(device, 'j');
    expect(handler.device).toBe(device);
    expect(handler.jobId).toBe('j');
  });
});
