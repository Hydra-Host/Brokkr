import { describe, expect, it } from 'vitest';
import { EfiHandler } from '../efi.handler';

describe('EfiHandler', () => {
  const handler = new EfiHandler();

  it('parses detected=true and returns empty mutation', async () => {
    const parsed = handler.schema.parse({ detected: true });
    const mutation = await handler.handle(parsed);
    expect(mutation).toEqual({});
  });

  it('parses detected=false', async () => {
    const parsed = handler.schema.parse({ detected: false });
    expect(parsed.detected).toBe(false);
  });

  it('rejects missing detected', () => {
    const out = handler.schema.safeParse({});
    expect(out.success).toBe(false);
  });

  it('tolerates unknown sibling fields', () => {
    const out = handler.schema.safeParse({ detected: true, future: 'ok' });
    expect(out.success).toBe(true);
  });
});
