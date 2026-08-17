import { describe, expect, it } from 'vitest';
import { FirmwareTypeHandler } from '../firmware_type.handler';

describe('FirmwareTypeHandler', () => {
  const handler = new FirmwareTypeHandler();

  it('accepts "efi"', async () => {
    const parsed = handler.schema.parse('efi');
    const mutation = await handler.handle(parsed);
    expect(mutation).toEqual({});
  });

  it('accepts "bios"', async () => {
    const parsed = handler.schema.parse('bios');
    const mutation = await handler.handle(parsed);
    expect(mutation).toEqual({});
  });

  it('warns on unexpected value', async () => {
    const parsed = handler.schema.parse('uboot');
    const mutation = await handler.handle(parsed);
    expect(mutation.warnings).toContain('unexpected firmware_type: "uboot"');
  });

  it('rejects non-string input', () => {
    const out = handler.schema.safeParse({ detected: true });
    expect(out.success).toBe(false);
  });
});
