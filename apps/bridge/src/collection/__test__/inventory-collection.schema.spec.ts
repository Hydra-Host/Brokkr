import { describe, expect, it } from 'vitest';

import { inventoryCollectionSagaPayloadSchema } from '../collection.schema';

describe('inventoryCollectionSagaPayloadSchema', () => {
  it('accepts a UUID-string device_id', () => {
    const result = inventoryCollectionSagaPayloadSchema.parse({
      device_id: 'd3a53016-86ec-45dd-b2ac-3a505ec57c2b',
    });
    expect(result.device_id).toBe('d3a53016-86ec-45dd-b2ac-3a505ec57c2b');
  });

  it('rejects a bare integer device_id', () => {
    expect(() => inventoryCollectionSagaPayloadSchema.parse({ device_id: 42 })).toThrow();
  });

  it('rejects missing device_id', () => {
    expect(() => inventoryCollectionSagaPayloadSchema.parse({})).toThrow();
  });

  it('rejects extra fields (strict mode)', () => {
    expect(() =>
      inventoryCollectionSagaPayloadSchema.parse({
        device_id: 'd3a53016-86ec-45dd-b2ac-3a505ec57c2b',
        rogue: 'x',
      }),
    ).toThrow();
  });
});
