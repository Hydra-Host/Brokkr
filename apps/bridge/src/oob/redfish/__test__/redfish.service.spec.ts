import { describe, expect, it, vi } from 'vitest';

import { RedfishError, RedfishProxyService } from '../../redfish-proxy.service.js';

const VALID_PAYLOAD_BASE = {
  bmc_ip: '172.16.28.70',
  username: 'admin',
  password: 'secret123',
  endpoint: '/redfish/v1/Systems/1',
};

describe('RedfishProxyService.validatePayload — method case-insensitivity', () => {
  it.each(['get', 'GET', 'Get'])('accepts method %s', async (method) => {
    const service = new RedfishProxyService('test-job');
    await expect(service.validatePayload({ ...VALID_PAYLOAD_BASE, method })).resolves.toBeUndefined();
  });

  it.each(['post', 'POST', 'patch', 'PATCH', 'put', 'PUT'])(
    'accepts mutating method %s when payload is present',
    async (method) => {
      const service = new RedfishProxyService('test-job');
      await expect(
        service.validatePayload({ ...VALID_PAYLOAD_BASE, method, payload: { test: 'data' } }),
      ).resolves.toBeUndefined();
    },
  );
});

describe('RedfishProxyService.buildRequestUrl — edge cases', () => {
  it('preserves query strings on the endpoint', async () => {
    const service = new RedfishProxyService('test-job');
    const url = await service.buildRequestUrl('192.168.1.100', {
      endpoint: '/redfish/v1/Systems/1?$select=PowerState',
      protocol: 'https',
      port: 443,
    });
    expect(url).toBe('https://192.168.1.100:443/redfish/v1/Systems/1?$select=PowerState');
  });

  it('renders IPv6 addresses verbatim', async () => {
    const service = new RedfishProxyService('test-job');
    const url = await service.buildRequestUrl('2001:db8::1', {
      endpoint: '/redfish/v1/Systems/1',
      protocol: 'https',
      port: 443,
    });
    expect(url).toBe('https://2001:db8::1:443/redfish/v1/Systems/1');
  });
});

describe('RedfishProxyService.prepareResponseHeaders — edge cases', () => {
  it('adds default content type to an empty header map', async () => {
    const service = new RedfishProxyService('test-job');
    const headers = await service.prepareResponseHeaders({});
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('treats case-different content-type as missing and adds the default', async () => {
    const service = new RedfishProxyService('test-job');
    const headers = await service.prepareResponseHeaders({ 'content-type': 'application/xml', etag: '"123"' });
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['content-type']).toBe('application/xml');
  });
});

describe('RedfishProxyService.performRedfishOperation — concurrency + payload size', () => {
  it('handles five concurrent operations independently', async () => {
    const requester = vi.fn(async () => ({
      status: 200,
      body: Buffer.from('{"success":true}', 'utf8'),
      headers: { 'Content-Type': 'application/json' },
    }));
    const service = new RedfishProxyService('test-job', { requester });

    const payloads = Array.from({ length: 5 }, (_, i) => ({
      ...VALID_PAYLOAD_BASE,
      bmc_ip: `172.16.28.${i}`,
      endpoint: `/redfish/v1/Systems/${i}`,
      method: 'GET',
    }));

    const results = await Promise.all(payloads.map((p) => service.performRedfishOperation(p)));

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(requester).toHaveBeenCalledTimes(5);
  });

  it('passes a large payload through to the requester unchanged', async () => {
    const largeData = { data: 'x'.repeat(10000), array: Array.from({ length: 1000 }, (_, i) => i) };
    let observedBody: string | null | undefined;
    const requester = async (params: { body: string | null }) => {
      observedBody = params.body;
      return { status: 200, body: Buffer.from('{}', 'utf8'), headers: {} };
    };
    const service = new RedfishProxyService('test-job', { requester });

    await service.performRedfishOperation({
      ...VALID_PAYLOAD_BASE,
      endpoint: '/redfish/v1/Systems/1/Actions/CustomAction',
      method: 'POST',
      payload: largeData,
    });

    expect(observedBody).toBe(JSON.stringify(largeData));
  });

  it('accepts unicode credentials at validate without mangling', async () => {
    const service = new RedfishProxyService('test-job');
    await expect(
      service.validatePayload({
        ...VALID_PAYLOAD_BASE,
        username: 'admin-ñoñó',
        password: 'pássword-测试',
        method: 'GET',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('RedfishProxyService.executeRedfishRequest — error wrapping', () => {
  it('wraps a generic requester throw in RedfishError', async () => {
    const requester = async () => {
      throw new Error('Unexpected error');
    };
    const service = new RedfishProxyService('test-job', { requester });

    await expect(service.executeRedfishRequest('https://10.0.0.1:443/x', 'GET', {}, 'u', 'p')).rejects.toThrow(
      RedfishError,
    );
  });

  it('strips Content-Encoding and Content-Length from the response headers', async () => {
    const requester = async () => ({
      status: 200,
      body: Buffer.from('{}', 'utf8'),
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': '2', ETag: '"1"' },
    });
    const service = new RedfishProxyService('test-job', { requester });
    const out = await service.executeRedfishRequest('https://10.0.0.1:443/x', 'GET', {}, 'u', 'p');
    expect(out.headers).toEqual({ 'Content-Type': 'application/json', ETag: '"1"' });
  });
});
