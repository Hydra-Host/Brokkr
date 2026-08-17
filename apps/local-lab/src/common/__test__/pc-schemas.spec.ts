import { z } from 'zod';

import { parseBoundary, PcProcessSchema, ProcessesResponseSchema, RenderedConfigSchema } from '../pc-schemas';

describe('PcProcessSchema', () => {
  it('accepts null for every optional scalar (process-compose emits null, not omission)', () => {
    const r = PcProcessSchema.safeParse({
      name: 'hub-api',
      status: 'Running',
      namespace: null,
      is_ready: null,
      pid: null,
      restarts: null,
      exit_code: null,
      replica: null,
      cpu: null,
      mem: null,
      system_time: null,
    });
    expect(r.success).toBe(true);
  });

  it('accepts omitted optionals and passes through unknown keys', () => {
    const r = PcProcessSchema.safeParse({ name: 'redis', status: 'Running', is_elevated: false });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ is_elevated: false });
  });

  it('shapes the telemetry fields', () => {
    const r = PcProcessSchema.safeParse({
      name: 'redis',
      status: 'Running',
      cpu: 0.1,
      mem: 1234,
      system_time: '2d5h',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ cpu: 0.1, mem: 1234, system_time: '2d5h' });
  });

  it('still rejects a wrong-typed scalar', () => {
    expect(PcProcessSchema.safeParse({ name: 'x', status: 'Running', pid: 'nope' }).success).toBe(false);
  });

  it.each([{ cpu: '0.5' }, { mem: '1234' }, { system_time: 42 }])(
    'rejects a wrong-typed telemetry field %o',
    (extra) => {
      expect(PcProcessSchema.safeParse({ name: 'x', status: 'Running', ...extra }).success).toBe(false);
    },
  );
});

describe('ProcessesResponseSchema', () => {
  it('accepts a null data field', () => {
    expect(ProcessesResponseSchema.safeParse({ data: null }).success).toBe(true);
  });

  it('accepts rows carrying null scalar fields', () => {
    const r = ProcessesResponseSchema.safeParse({
      data: [{ name: 'fleet', status: 'Completed', exit_code: null, pid: null }],
    });
    expect(r.success).toBe(true);
  });
});

describe('RenderedConfigSchema', () => {
  it('accepts null for the process fields the code null-coalesces (rendered YAML can emit null, not just omission)', () => {
    const r = RenderedConfigSchema.safeParse({
      processes: { spoke: { namespace: null, description: null, depends_on: null, environment: null } },
    });
    expect(r.success).toBe(true);
  });
});

describe('parseBoundary', () => {
  it('returns the parsed data on success', () => {
    expect(parseBoundary(z.object({ a: z.number() }), { a: 1 }, 'ctx')).toEqual({ a: 1 });
  });

  it('throws a single-line "label: path: message" summary, not a multi-line ZodError blob', () => {
    let msg = '';
    try {
      parseBoundary(z.object({ a: z.number() }), { a: 'nope' }, 'rendered config');
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).not.toContain('\n');
    expect(msg).toMatch(/^rendered config: a: /);
  });
});
