import { describe, expect, it } from 'vitest';

import { syncSagaPayloadSchema } from '../sync.schema';

describe('syncSagaPayloadSchema', () => {
  it('accepts an empty payload (orphan saga default)', () => {
    const result = syncSagaPayloadSchema.parse({});
    expect(result.sync_type ?? null).toBeNull();
    expect(result.force ?? null).toBeNull();
  });

  it('accepts a discovery sync_type', () => {
    const result = syncSagaPayloadSchema.parse({ sync_type: 'discovery' });
    expect(result.sync_type).toBe('discovery');
  });

  it('accepts a forced discovery sync', () => {
    const result = syncSagaPayloadSchema.parse({ sync_type: 'discovery', force: true });
    expect(result.force).toBe(true);
  });

  it('rejects extra fields (strict mode)', () => {
    expect(() => syncSagaPayloadSchema.parse({ rogue: 'x' })).toThrow();
  });

  it('rejects non-boolean for force', () => {
    expect(() => syncSagaPayloadSchema.parse({ force: [1, 2, 3] })).toThrow();
  });
});
