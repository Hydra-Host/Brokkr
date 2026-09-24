import { RENDER_DOMAINS } from '@repo/utils';
import { describe, expect, it } from 'vitest';
import { renderRequestSchema } from '../../types/render-request.types';

const BASE = {
  request_id: '11111111-1111-1111-1111-111111111111',
  zone_id: '22222222-2222-2222-2222-222222222222',
  bridge_id: 'bridge-a',
  domain: 'netplan',
};

describe('renderRequestSchema', () => {
  it('parses a valid envelope with the required fields only', () => {
    const result = renderRequestSchema.safeParse(BASE);
    expect(result.success).toBe(true);
  });

  it('parses a valid envelope with reason and an arbitrary params record', () => {
    const result = renderRequestSchema.safeParse({
      ...BASE,
      reason: 'stale',
      params: { anything: 'goes', here: 1, nested: { foo: 'bar' } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects when request_id is missing', () => {
    const { request_id: _omit, ...rest } = BASE;
    const result = renderRequestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects when zone_id is not a UUID', () => {
    const result = renderRequestSchema.safeParse({ ...BASE, zone_id: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('rejects when domain is missing', () => {
    const { domain: _omit, ...rest } = BASE;
    const result = renderRequestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects when domain is an empty string', () => {
    const result = renderRequestSchema.safeParse({ ...BASE, domain: '' });
    expect(result.success).toBe(false);
  });

  it('rejects when domain is not one of the known literals', () => {
    const result = renderRequestSchema.safeParse({ ...BASE, domain: 'mystery_domain' });
    expect(result.success).toBe(false);
  });

  it.each(RENDER_DOMAINS)('accepts known domain literal %j', (domain) => {
    const result = renderRequestSchema.safeParse({ ...BASE, domain });
    expect(result.success).toBe(true);
  });

  it('rejects unknown top-level fields (strict envelope)', () => {
    const result = renderRequestSchema.safeParse({ ...BASE, extra_field: 'nope' });
    expect(result.success).toBe(false);
  });

  it('rejects a reason value outside the allowed enum', () => {
    const result = renderRequestSchema.safeParse({ ...BASE, reason: 'whenever' });
    expect(result.success).toBe(false);
  });

  it('treats params as optional', () => {
    const result = renderRequestSchema.safeParse(BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.params).toBeUndefined();
    }
  });

  it('accepts JSON null reason (serialized-null payloads), treating it as absent', () => {
    const result = renderRequestSchema.safeParse({ ...BASE, reason: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBeNull();
    }
  });

  it('accepts JSON null params (serialized-null payloads), treating it as absent', () => {
    const result = renderRequestSchema.safeParse({ ...BASE, params: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.params).toBeNull();
    }
  });
});
