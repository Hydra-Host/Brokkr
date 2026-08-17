import { describe, expect, it } from 'vitest';

import { errText } from './error-banner';

describe('errText', () => {
  it('reads the message off a thrown ts-rest response rather than stringifying the object', () => {
    const text = errText(undefined, { status: 400, body: { error: 'invalid job id' } });
    expect(text).toBe('invalid job id');
  });

  it('falls back to the status of a thrown ts-rest response whose body carries no message', () => {
    const text = errText(undefined, { status: 400, body: {} });
    expect(text).toBe('request failed (400)');
  });

  it('reads the message off a thrown error from a network failure', () => {
    expect(errText(undefined, new Error('Failed to fetch'))).toBe('Failed to fetch');
  });

  it('reads the message off a non-200 that arrived in data rather than thrown', () => {
    const text = errText({ status: 500, body: { error: 'redis read failed' } }, undefined);
    expect(text).toBe('redis read failed');
  });

  it('falls back to the status of a non-200 in data whose body carries no message', () => {
    expect(errText({ status: 500, body: {} }, undefined)).toBe('request failed (500)');
  });

  it('prefers the message over the bare status whenever one is available', () => {
    expect(errText({ status: 404, body: { error: 'queue not in the discovered inventory' } }, undefined)).toBe(
      'queue not in the discovered inventory',
    );
    expect(errText(undefined, { status: 404, body: { error: 'job absent' } })).toBe('job absent');
  });

  it('never renders object stringification for any failure shape', () => {
    const shapes: [{ status: number; body: unknown } | undefined, unknown][] = [
      [undefined, { status: 400, body: { error: 'invalid job id' } }],
      [undefined, { status: 400, body: {} }],
      [undefined, { status: 500, body: { error: null } }],
      [undefined, new Error('Failed to fetch')],
      [{ status: 500, body: { error: 'redis read failed' } }, undefined],
      [{ status: 500, body: {} }, undefined],
    ];
    for (const [data, thrown] of shapes) {
      expect(errText(data, thrown)).not.toContain('[object Object]');
    }
  });

  it('reports no error for a successful read and for an idle query', () => {
    expect(errText({ status: 200, body: { ok: true } }, undefined)).toBeNull();
    expect(errText(undefined, undefined)).toBeNull();
    expect(errText(undefined, null)).toBeNull();
  });
});
