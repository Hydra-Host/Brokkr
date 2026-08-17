import { describe, expect, it } from 'vitest';
import { createLabContext } from './client.js';
import { call, err, failOnError, ok } from './shared.js';
import { stubApi } from './testkit.js';

describe('ok', () => {
  it('json-stringifies data into text content', () => {
    expect(ok({ a: 1 })).toEqual({ content: [{ type: 'text', text: '{"a":1}' }] });
  });

  it('defaults to a success marker', () => {
    expect(ok()).toEqual({ content: [{ type: 'text', text: '{"success":true}' }] });
  });
});

describe('err', () => {
  it('unwraps Error messages and stringifies non-errors', () => {
    expect(err(new Error('boom')).content[0]?.text).toBe('boom');
    expect(err('nope').content[0]?.text).toBe('nope');
    expect(err(new Error('x')).isError).toBe(true);
  });
});

describe('failOnError', () => {
  it('returns the 200 body untouched', () => {
    const res = { status: 200, body: { value: 1 } };
    expect(() => failOnError(res, 'route')).not.toThrow();
  });

  it('throws the contract error field for non-200 responses', () => {
    expect(() => failOnError({ status: 409, body: { error: 'lane busy' } }, 'startStackRun')).toThrow(
      'startStackRun: lane busy',
    );
  });

  it('falls back to the status code for unshaped bodies', () => {
    expect(() => failOnError({ status: 500, body: null }, 'getStatus')).toThrow('getStatus: HTTP 500');
  });
});

describe('call', () => {
  it('wraps the handler result in ok()', async () => {
    const ctx = createLabContext({
      baseUrl: 'http://lab.test',
      api: stubApi({ 'GET /api/status': { status: 200, body: { v: 1 } } }),
    });
    const result = await call(ctx, async (client) => {
      const res = await client.getStatus({});
      failOnError(res, 'getStatus');
      return res.body;
    });
    expect(result).toEqual({ content: [{ type: 'text', text: '{"v":1}' }] });
  });

  it('converts thrown errors into isError results', async () => {
    const ctx = createLabContext({ baseUrl: 'http://lab.test', api: stubApi({}) });
    const result = await call(ctx, async () => {
      throw new Error('kaput');
    });
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'kaput' }] });
  });
});
