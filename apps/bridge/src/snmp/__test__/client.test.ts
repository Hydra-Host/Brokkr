import * as snmp from 'net-snmp';
import { describe, expect, it, vi } from 'vitest';

import { SnmpParams } from '../auth.js';
import { SnmpClient, SnmpError } from '../client.js';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  acquire: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
}));

vi.mock('../engine.js', () => ({
  getSnmpEngine: () => ({ createSession: mocks.createSession, acquire: mocks.acquire }),
}));

const V2C_PARAMS: SnmpParams = { version: '2c', community: 'public' };

function octetVarbind(oid: string, text: string): snmp.Varbind {
  return { oid, type: snmp.ObjectType.OctetString, value: Buffer.from(text) };
}

function withSession(handlers: { get?: any; subtree?: any }) {
  return { get: handlers.get, subtree: handlers.subtree, close: vi.fn() };
}

describe('SnmpClient.get', () => {
  it('decodes returned varbinds', async () => {
    mocks.createSession.mockReturnValueOnce(
      withSession({
        get: (_oids: string[], cb: (error: Error | null, varbinds?: snmp.Varbind[]) => void) => {
          cb(null, [
            octetVarbind('1.3.6.1.2.1.1.1.0', 'sysDescr'),
            { oid: '1.3.6.1.2.1.1.3.0', type: snmp.ObjectType.TimeTicks, value: 99 },
          ]);
        },
      }),
    );

    const client = new SnmpClient('job-1');
    const result = await client.get('10.0.0.9', 161, ['1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.3.0'], V2C_PARAMS);

    expect(result).toEqual([
      { oid: '1.3.6.1.2.1.1.1.0', type: 'OctetString', value: 'sysDescr' },
      { oid: '1.3.6.1.2.1.1.3.0', type: 'TimeTicks', value: 99 },
    ]);
  });

  it('rejects with SnmpError on a session error', async () => {
    mocks.createSession.mockReturnValueOnce(
      withSession({
        get: (_oids: string[], cb: (error: Error | null, varbinds?: snmp.Varbind[]) => void) => {
          cb(new Error('Request timed out'));
        },
      }),
    );

    const client = new SnmpClient('job-1');
    await expect(client.get('10.0.0.9', 161, ['1.3.6.1.2.1.1.1.0'], V2C_PARAMS)).rejects.toThrow(SnmpError);
  });

  it('decodes per-varbind error sentinels without rejecting', async () => {
    mocks.createSession.mockReturnValueOnce(
      withSession({
        get: (_oids: string[], cb: (error: Error | null, varbinds?: snmp.Varbind[]) => void) => {
          cb(null, [{ oid: '1.3.6.1.2.1.99.0', type: snmp.ObjectType.NoSuchObject, value: null }]);
        },
      }),
    );

    const client = new SnmpClient('job-1');
    const result = await client.get('10.0.0.9', 161, ['1.3.6.1.2.1.99.0'], V2C_PARAMS);
    expect(result).toHaveLength(1);
    expect(result[0].oid).toBe('1.3.6.1.2.1.99.0');
  });

  it('rejects with SnmpError on invalid auth params before any I/O', async () => {
    const client = new SnmpClient('job-1');
    await expect(client.get('10.0.0.9', 161, ['1.3.6.1.2.1.1.1.0'], { version: '4' })).rejects.toThrow(
      "Unsupported SNMP version: '4' (expected 1, 2c, or 3)",
    );
  });
});

describe('SnmpClient.walk', () => {
  function subtreeHandler(batches: snmp.Varbind[][], finalError: Error | null = null) {
    return (
      _oid: string,
      _maxRepetitions: number,
      feedCb: (varbinds: snmp.Varbind[]) => boolean | undefined,
      doneCb: (error: Error | null) => void,
    ) => {
      for (const batch of batches) {
        if (feedCb(batch) === true) {
          doneCb(null);
          return;
        }
      }
      doneCb(finalError);
    };
  }

  it('collects decoded varbinds across batches', async () => {
    mocks.createSession.mockReturnValueOnce(
      withSession({
        subtree: subtreeHandler([
          [octetVarbind('1.3.6.1.2.1.1.9.1.1', 'a')],
          [octetVarbind('1.3.6.1.2.1.1.9.1.2', 'b')],
        ]),
      }),
    );

    const client = new SnmpClient('job-1');
    const result = await client.walk('10.0.0.9', 161, '1.3.6.1.2.1.1.9', V2C_PARAMS);

    expect(result.varbinds.map((vb) => vb.value)).toEqual(['a', 'b']);
    expect(result.truncated).toBe(false);
    expect(result.truncationReason).toBeNull();
    expect(result.hadError).toBe(false);
  });

  it('treats EndOfMibView as a natural end-of-walk', async () => {
    mocks.createSession.mockReturnValueOnce(
      withSession({
        subtree: subtreeHandler([
          [
            octetVarbind('1.3.6.1.2.1.1.9.1.1', 'a'),
            { oid: '1.3.6.1.2.1.1.9.1.2', type: snmp.ObjectType.EndOfMibView, value: null },
          ],
        ]),
      }),
    );

    const client = new SnmpClient('job-1');
    const result = await client.walk('10.0.0.9', 161, '1.3.6.1.2.1.1.9', V2C_PARAMS);

    expect(result.varbinds).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(result.hadError).toBe(false);
  });

  it('truncates at the requested max_results cap', async () => {
    mocks.createSession.mockReturnValueOnce(
      withSession({
        subtree: subtreeHandler([
          [octetVarbind('1.0.1', 'a'), octetVarbind('1.0.2', 'b')],
          [octetVarbind('1.0.3', 'c'), octetVarbind('1.0.4', 'd')],
        ]),
      }),
    );

    const client = new SnmpClient('job-1');
    const result = await client.walk('10.0.0.9', 161, '1.0', V2C_PARAMS, 3);

    expect(result.varbinds).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe('Reached max_results limit (3)');
    expect(result.hadError).toBe(false);
  });

  it('caps the requested max_results at the configured maximum', async () => {
    const big = Array.from({ length: 1001 }, (_, i) => octetVarbind(`1.0.${i}`, `v${i}`));
    mocks.createSession.mockReturnValueOnce(withSession({ subtree: subtreeHandler([big]) }));

    const client = new SnmpClient('job-1');
    const result = await client.walk('10.0.0.9', 161, '1.0', V2C_PARAMS, 5000);

    expect(result.varbinds).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe('Reached max_results limit (1000)');
  });

  it('returns a partial result with the "Walk error after" prefix when doneCb reports an error mid-walk', async () => {
    mocks.createSession.mockReturnValueOnce(
      withSession({
        subtree: subtreeHandler([[octetVarbind('1.0.1', 'a'), octetVarbind('1.0.2', 'b')]], new Error('boom')),
      }),
    );

    const client = new SnmpClient('job-1');
    const result = await client.walk('10.0.0.9', 161, '1.0', V2C_PARAMS);

    expect(result.varbinds).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.hadError).toBe(true);
    expect(result.truncationReason).toBe('Walk error after 2 results: boom');
  });

  it('rejects when the walk fails before any data is collected', async () => {
    mocks.createSession.mockReturnValueOnce(
      withSession({ subtree: subtreeHandler([], new Error('Request timed out')) }),
    );

    const client = new SnmpClient('job-1');
    await expect(client.walk('10.0.0.9', 161, '1.0', V2C_PARAMS)).rejects.toThrow(SnmpError);
  });

  it('rejects on a mid-walk varbind error with no prior data', async () => {
    mocks.createSession.mockReturnValueOnce(
      withSession({ subtree: subtreeHandler([[{ oid: '1.0.1', type: snmp.ObjectType.NoSuchInstance, value: null }]]) }),
    );

    const client = new SnmpClient('job-1');
    await expect(client.walk('10.0.0.9', 161, '1.0', V2C_PARAMS)).rejects.toThrow(SnmpError);
  });

  it('returns partial with "Walk error-status after" prefix when a varbind error follows prior data', async () => {
    mocks.createSession.mockReturnValueOnce(
      withSession({
        subtree: subtreeHandler([
          [octetVarbind('1.0.1', 'a')],
          [{ oid: '1.0.2', type: snmp.ObjectType.NoSuchInstance, value: null }],
        ]),
      }),
    );

    const client = new SnmpClient('job-1');
    const result = await client.walk('10.0.0.9', 161, '1.0', V2C_PARAMS);

    expect(result.varbinds).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.hadError).toBe(true);
    expect(result.truncationReason).toMatch(/^Walk error-status after 1 results: /);
  });

  it('passes session options derived from config and auth params', async () => {
    mocks.createSession.mockReturnValueOnce(withSession({ subtree: subtreeHandler([]) }));

    const client = new SnmpClient('job-1');
    await client.walk('10.0.0.9', 161, '1.0', V2C_PARAMS);

    const call = mocks.createSession.mock.calls.at(-1);
    expect(call?.[0]).toBe('10.0.0.9');
    expect(call?.[1]).toBe(161);
    expect(call?.[2]).toEqual({ kind: 'community', community: 'public', version: snmp.Version2c });
    expect(call?.[3]).toEqual({ timeoutMs: 10_000, retries: 1 });
  });
});
