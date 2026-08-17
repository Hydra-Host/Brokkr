import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { readAtom } from '../atom-envelope';

const ValueSchema = z.object({ vip: z.string() });

const envelope = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    status: 'ok',
    value: { vip: '10.0.1.1/24' },
    written_at: 1_700_000_000_000,
    request_id: null,
    ...over,
  });

describe('readAtom', () => {
  it('unwraps an ok envelope', () => {
    const read = readAtom(envelope(), ValueSchema);

    expect(read).toEqual({
      ok: true,
      value: { vip: '10.0.1.1/24' },
      writtenAtMs: 1_700_000_000_000,
      requestId: null,
    });
  });

  it('reports a hub-failed envelope as a reason, keeping its stamp', () => {
    const raw = JSON.stringify({
      status: 'failed',
      reason: 'unsupported_domain',
      written_at: 1_700_000_000_000,
      request_id: 'plan-1',
    });
    const read = readAtom(raw, ValueSchema);

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('expected a failed read');
    expect(read.error).toContain('unsupported_domain');
    expect(read.writtenAtMs).toBe(1_700_000_000_000);
    expect(read.requestId).toBe('plan-1');
  });

  it('reports an absent atom rather than throwing', () => {
    const read = readAtom(null, ValueSchema);

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('expected a failed read');
    expect(read.error).toContain('absent');
  });

  it('reports invalid json rather than throwing', () => {
    const read = readAtom('{', ValueSchema);

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('expected a failed read');
    expect(read.error).toContain('json');
  });

  it('reports a value that does not match the expected shape', () => {
    const read = readAtom(envelope({ value: { vip: 42 } }), ValueSchema);

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('expected a failed read');
    expect(read.error).toContain('shape');
  });

  it('rejects a bare payload that carries no envelope', () => {
    const read = readAtom(JSON.stringify({ vip: '10.0.1.1/24' }), ValueSchema);

    expect(read.ok).toBe(false);
  });
});
