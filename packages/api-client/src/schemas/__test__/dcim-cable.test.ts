import { describe, expect, it } from 'vitest';
import { CreateDcimCableRequestSchema } from '../dcim';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

describe('CreateDcimCableRequestSchema terminations', () => {
  it('accepts a body with both A and B terminations', () => {
    const result = CreateDcimCableRequestSchema.safeParse({
      type: 'CAT6',
      status: 'CONNECTED',
      aTermination: { type: 'INTERFACE', id: A },
      bTermination: { type: 'INTERFACE', id: B },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a body with no terminations (the bug: cable could never be created)', () => {
    const result = CreateDcimCableRequestSchema.safeParse({ type: 'CAT6', status: 'CONNECTED' });
    expect(result.success).toBe(false);
  });

  it('rejects a body missing the B-side termination', () => {
    const result = CreateDcimCableRequestSchema.safeParse({
      aTermination: { type: 'INTERFACE', id: A },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown termination type', () => {
    const result = CreateDcimCableRequestSchema.safeParse({
      aTermination: { type: 'NOT_A_PORT', id: A },
      bTermination: { type: 'INTERFACE', id: B },
    });
    expect(result.success).toBe(false);
  });
});
