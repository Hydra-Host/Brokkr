import http from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';

import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RedfishHttpResponse, RedfishRequestParams } from '../vendor/base/base.js';
import {
  defaultRedfishRequester,
  extractNestedValue,
  logger,
  RedfishBaseHandler,
  RedfishDevice,
} from '../vendor/base/base.js';

const ENV_KEYS = [
  'BROKKR_ENV',
  'HH_ENV',
  'ENVIRONMENT',
  'LOCAL_SIMULATION_ENABLED',
  'SIM_REDFISH_PORT',
  'REDFISH_TLS_VERIFY',
];
const savedEnv: Record<string, string | undefined> = {};

function jsonResponse(body: unknown, init: Partial<RedfishHttpResponse> = {}): RedfishHttpResponse {
  return { status: 200, text: JSON.stringify(body), headers: {}, ...init };
}

type RequesterMock = Mock<(params: RedfishRequestParams) => Promise<RedfishHttpResponse>>;

function makeRequester(): RequesterMock {
  return vi.fn<(params: RedfishRequestParams) => Promise<RedfishHttpResponse>>();
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe('RedfishDevice sim-port selection', () => {
  it.each([
    [undefined, undefined, 'https', 443],
    ['false', undefined, 'https', 443],
    ['False', '9999', 'https', 443],
    ['true', undefined, 'http', 8443],
    ['True', '9999', 'http', 9999],
  ])('LOCAL_SIMULATION_ENABLED=%s SIM_REDFISH_PORT=%s -> %s:%d', (simEnabled, simPort, protocol, port) => {
    if (simEnabled !== undefined) process.env.LOCAL_SIMULATION_ENABLED = simEnabled;
    if (simPort !== undefined) process.env.SIM_REDFISH_PORT = simPort;
    const device = new RedfishDevice('job-1', 'dev-1', '1.2.3.4', 'root', 'calvin');
    expect(device.protocol).toBe(protocol);
    expect(device.port).toBe(port);
  });

  it('uses the sim port in request URLs', async () => {
    process.env.LOCAL_SIMULATION_ENABLED = 'true';
    process.env.SIM_REDFISH_PORT = '9001';
    const device = new RedfishDevice('job-1', 'dev-1', '1.2.3.4', 'root', 'calvin');
    const requester = makeRequester().mockResolvedValueOnce(jsonResponse({ ok: true }));
    const handler = new RedfishBaseHandler(device, 'job-1', requester);

    await handler.fetch('GET', '/redfish', {});

    expect(requester).toHaveBeenCalledTimes(1);
    expect(requester.mock.calls[0]?.[0]?.url).toBe('http://1.2.3.4:9001/redfish');
  });
});

describe('RedfishBaseHandler.fetch', () => {
  function makeHandler(requester: RequesterMock): RedfishBaseHandler {
    const device = new RedfishDevice('job-1', 'dev-1', '10.0.0.5', 'root', 'calvin');
    return new RedfishBaseHandler(device, 'job-1', requester);
  }

  it('passes credentials and standard headers on GET without a body', async () => {
    const requester = makeRequester().mockResolvedValueOnce(jsonResponse({ v1: '/redfish/v1' }));
    const handler = makeHandler(requester);

    const result = await handler.fetch('GET', '/redfish', {});

    const params = requester.mock.calls[0]?.[0] as RedfishRequestParams;
    expect(params.url).toBe('https://10.0.0.5:443/redfish');
    expect(params.username).toBe('root');
    expect(params.password).toBe('calvin');
    expect(params.headers.Accept).toBe('application/json');
    expect(params.headers['Accept-Encoding']).toBe('identity');
    expect(params.headers['Content-Type']).toBe('application/json');
    expect(params.body).toBeNull();
    expect(result).toEqual({ v1: '/redfish/v1' });

    const entry = handler.device.callStack[0];
    expect(entry?.status).toBe(200);
    expect(entry?.response).toEqual({ v1: '/redfish/v1' });
  });

  it('serializes a non-empty payload as the JSON body', async () => {
    const requester = makeRequester().mockResolvedValueOnce(jsonResponse({}));
    const handler = makeHandler(requester);

    await handler.fetch('POST', '/redfish/v1/Systems/1/Actions/Reset', { ResetType: 'On' });

    const params = requester.mock.calls[0]?.[0] as RedfishRequestParams;
    expect(params.method).toBe('POST');
    expect(params.body).toBe(JSON.stringify({ ResetType: 'On' }));
  });

  it('masks credential fields in the debug curl line (Lenovo account PATCH)', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const requester = makeRequester().mockResolvedValueOnce(jsonResponse({}));
    const handler = makeHandler(requester);

    await handler.fetch('PATCH', '/redfish/v1/AccountService/Accounts/2', {
      Password: 'sup3rs3cret',
      PasswordChangeRequired: false,
    });

    const line = debugSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain('sup3rs3cret');
    expect(line).toContain('********');
    expect(line).toContain('PasswordChangeRequired');
    expect(requester.mock.calls[0]?.[0]?.body).toContain('sup3rs3cret');
  });

  it('merges caller headers with the standard set', async () => {
    const requester = makeRequester().mockResolvedValueOnce(jsonResponse({}));
    const handler = makeHandler(requester);

    await handler.fetch('PATCH', '/redfish/v1/Bios/SD', { Attributes: { A: 1 } }, { 'If-Match': 'W/"abc"' });

    const params = requester.mock.calls[0]?.[0] as RedfishRequestParams;
    expect(params.headers['If-Match']).toBe('W/"abc"');
    expect(params.headers.Accept).toBe('application/json');
  });

  it('captures response headers on JSON responses', async () => {
    const requester = makeRequester().mockResolvedValueOnce(jsonResponse({ ok: 1 }, { headers: { etag: 'W/"123"' } }));
    const handler = makeHandler(requester);

    await handler.fetch('GET', '/redfish/v1/Bios', {});

    const entry = handler.device.callStack[0];
    expect(entry?.responseHeaders['etag']).toBe('W/"123"');
  });

  it('wraps XML responses as {xml}', async () => {
    const requester = makeRequester().mockResolvedValueOnce({
      status: 200,
      text: '<?xml version="1.0"?><a/>',
      headers: {},
    });
    const handler = makeHandler(requester);

    const result = await handler.fetch('GET', '/redfish', {});

    expect(result).toEqual({ xml: '<?xml version="1.0"?><a/>' });
  });

  it('wraps non-JSON, non-XML responses as {unknown}', async () => {
    const requester = makeRequester().mockResolvedValueOnce({ status: 200, text: 'not json', headers: {} });
    const handler = makeHandler(requester);

    const result = await handler.fetch('GET', '/redfish', {});

    expect(result).toEqual({ unknown: 'not json' });
  });

  it('returns {} on connection errors and leaves status null', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:443'), { code: 'ECONNREFUSED' });
    const requester = makeRequester().mockRejectedValueOnce(err);
    const handler = makeHandler(requester);

    const result = await handler.fetch('GET', '/redfish', {});

    expect(result).toEqual({});
    expect(handler.device.callStack[0]?.status).toBeNull();
  });

  it('returns {} on timeout', async () => {
    const requester = makeRequester().mockRejectedValueOnce(
      new DOMException('The operation timed out', 'TimeoutError'),
    );
    const handler = makeHandler(requester);

    const result = await handler.fetch('GET', '/redfish', {}, undefined, 1);

    expect(result).toEqual({});
  });
});

describe('defaultRedfishRequester', () => {
  function spyHttpsRequest(capture: { options: https.RequestOptions | null }) {
    const fakeImpl = (
      options: https.RequestOptions,
      callback?: (res: http.IncomingMessage) => void,
    ): http.ClientRequest => {
      capture.options = options;
      const res = new PassThrough() as unknown as http.IncomingMessage & PassThrough;
      res.statusCode = 200;
      res.headers = { 'content-type': 'application/json' };
      queueMicrotask(() => {
        callback?.(res);
        res.end(Buffer.from('{"ok":true}', 'utf8'));
      });
      return { on: vi.fn(), write: vi.fn(), end: vi.fn() } as unknown as http.ClientRequest;
    };
    return vi.spyOn(https, 'request').mockImplementation(fakeImpl as typeof https.request);
  }

  it('does NOT verify TLS certificates by default for https targets', async () => {
    const capture: { options: https.RequestOptions | null } = { options: null };
    const spy = spyHttpsRequest(capture);

    const response = await defaultRedfishRequester({
      url: 'https://10.0.0.5:443/redfish',
      method: 'GET',
      headers: { Accept: 'application/json' },
      username: 'root',
      password: 'calvin',
      body: null,
      timeoutS: 1,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(capture.options).not.toBeNull();
    expect((capture.options as unknown as https.RequestOptions).rejectUnauthorized).toBe(false);
    const headers = (capture.options as unknown as https.RequestOptions).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('root:calvin').toString('base64')}`);
    expect(response.status).toBe(200);
    expect(response.text).toBe('{"ok":true}');
    expect(response.headers['content-type']).toBe('application/json');
  });

  it('verifies TLS certificates when REDFISH_TLS_VERIFY=true is opted in', async () => {
    process.env.REDFISH_TLS_VERIFY = 'true';
    const capture: { options: https.RequestOptions | null } = { options: null };
    const spy = spyHttpsRequest(capture);

    await defaultRedfishRequester({
      url: 'https://10.0.0.5:443/redfish',
      method: 'GET',
      headers: { Accept: 'application/json' },
      username: 'root',
      password: 'calvin',
      body: null,
      timeoutS: 1,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect((capture.options as unknown as https.RequestOptions).rejectUnauthorized).toBe(true);
  });

  it('does not set rejectUnauthorized for plain http targets', async () => {
    let capturedOptions: http.RequestOptions | null = null;
    const fakeImpl = (
      options: http.RequestOptions,
      callback?: (res: http.IncomingMessage) => void,
    ): http.ClientRequest => {
      capturedOptions = options;
      const res = new PassThrough() as unknown as http.IncomingMessage & PassThrough;
      res.statusCode = 200;
      res.headers = {};
      queueMicrotask(() => {
        callback?.(res);
        res.end(Buffer.from('{}', 'utf8'));
      });
      return { on: vi.fn(), write: vi.fn(), end: vi.fn() } as unknown as http.ClientRequest;
    };
    const spy = vi.spyOn(http, 'request').mockImplementation(fakeImpl as typeof http.request);

    const response = await defaultRedfishRequester({
      url: 'http://10.0.0.5:8443/redfish',
      method: 'GET',
      headers: {},
      username: 'root',
      password: 'calvin',
      body: null,
      timeoutS: 1,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect('rejectUnauthorized' in (capturedOptions as unknown as http.RequestOptions)).toBe(false);
    expect(response.status).toBe(200);
  });
});

describe('extractNestedValue', () => {
  const obj = {
    Members: [{ '@odata.id': '/redfish/v1/Systems/1' }],
    Status: { Health: 'OK' },
    error: { '@Message.ExtendedInfo': [{ Message: 'nope' }] },
  };

  it('traverses records and array indices', () => {
    expect(extractNestedValue(obj, 'Members_0_@odata.id')).toBe('/redfish/v1/Systems/1');
    expect(extractNestedValue(obj, 'Status_Health')).toBe('OK');
    expect(extractNestedValue(obj, 'error_@Message.ExtendedInfo_0_Message')).toBe('nope');
  });

  it('returns the default on misses', () => {
    expect(extractNestedValue(obj, 'Members_5_@odata.id')).toBeNull();
    expect(extractNestedValue(obj, 'Missing_Key', '_', 'fallback')).toBe('fallback');
    expect(extractNestedValue(null, 'a_b', '_', 'fallback')).toBe('fallback');
    expect(extractNestedValue(obj, '', '_', 'fallback')).toBe('fallback');
  });

  it('supports custom separators', () => {
    expect(extractNestedValue(obj, 'Status.Health', '.')).toBe('OK');
  });
});
