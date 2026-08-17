import { describe, expect, it } from 'vitest';

import { sealedBmcPayload } from '../../oob/steps/__test__/sealed-bmc.testutil';
import { solSagaPayloadSchema } from '../sol.schema';

const VALID = sealedBmcPayload();

describe('solSagaPayloadSchema', () => {
  it('accepts a payload using the canonical bmc_ip field', () => {
    const parsed = solSagaPayloadSchema.parse(VALID);
    expect(parsed.bmc_ip).toBe('10.0.0.5');
  });

  it('applies defaults for optional SOL fields', () => {
    const parsed = solSagaPayloadSchema.parse(VALID);
    expect(parsed.port).toBe(623);
    expect(parsed.timeout).toBe(300);
    expect(parsed.pass_strings).toEqual([' login:']);
    expect(parsed.fail_strings).toEqual(['timeout', 'grub>']);
    expect(parsed.device_id).toBeNull();
  });

  it('rejects the legacy ip_address field name (strict mode)', () => {
    const { bmc_ip: _omit, ...rest } = VALID;
    expect(() => solSagaPayloadSchema.parse({ ...rest, ip_address: '10.0.0.9' })).toThrow();
  });

  it.each(['bmc_ip', 'secrets'] as const)('rejects payload missing required field %s', (field) => {
    const { [field]: _omitted, ...partial } = VALID;
    expect(() => solSagaPayloadSchema.parse(partial)).toThrow();
  });

  it('accepts a nullable device_id', () => {
    expect(solSagaPayloadSchema.parse({ ...VALID, device_id: null }).device_id).toBeNull();
    expect(solSagaPayloadSchema.parse({ ...VALID, device_id: 'dev-1' }).device_id).toBe('dev-1');
  });

  it('rejects extra fields (strict mode)', () => {
    expect(() => solSagaPayloadSchema.parse({ ...VALID, rogue: 'x' })).toThrow();
  });
});
