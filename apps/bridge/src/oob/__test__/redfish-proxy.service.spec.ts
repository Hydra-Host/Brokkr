import http from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRedfishProxyService } from '../redfish-proxy.service';

const ENV_KEYS = ['BROKKR_ENV', 'HH_ENV', 'ENVIRONMENT', 'LOCAL_SIMULATION_ENABLED', 'REDFISH_TLS_VERIFY'];
const savedEnv: Record<string, string | undefined> = {};

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

describe('RedfishProxyService defaultRequester TLS policy', () => {
  it('does NOT verify TLS certificates by default for https targets', async () => {
    const capture: { options: https.RequestOptions | null } = { options: null };
    const spy = spyHttpsRequest(capture);

    const service = createRedfishProxyService('job-1');
    const result = await service.executeRedfishRequest(
      'https://10.0.0.5:443/redfish/v1',
      'GET',
      { Accept: 'application/json' },
      'root',
      'calvin',
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(capture.options).not.toBeNull();
    expect((capture.options as unknown as https.RequestOptions).rejectUnauthorized).toBe(false);
    expect(result.status).toBe(200);
  });

  it('verifies TLS certificates when REDFISH_TLS_VERIFY=true is opted in', async () => {
    process.env.REDFISH_TLS_VERIFY = 'true';
    const capture: { options: https.RequestOptions | null } = { options: null };
    const spy = spyHttpsRequest(capture);

    const service = createRedfishProxyService('job-1');
    await service.executeRedfishRequest(
      'https://10.0.0.5:443/redfish/v1',
      'GET',
      { Accept: 'application/json' },
      'root',
      'calvin',
    );

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

    const service = createRedfishProxyService('job-1');
    await service.executeRedfishRequest('http://10.0.0.5:8443/redfish/v1', 'GET', {}, 'root', 'calvin');

    expect(spy).toHaveBeenCalledTimes(1);
    expect('rejectUnauthorized' in (capturedOptions as unknown as http.RequestOptions)).toBe(false);
  });
});
