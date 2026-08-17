import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GhwGpuHandler } from '../ghw_gpu.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/ghw_gpu', `${name}.json`), 'utf8'));

describe('GhwGpuHandler', () => {
  const handler = new GhwGpuHandler();

  it('parses the outer shape and returns empty mutation', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    expect(mutation).toEqual({});
  });

  it('accepts missing cards', () => {
    expect(handler.schema.safeParse({ gpu: {} }).success).toBe(true);
  });

  it('rejects a payload missing the gpu wrapper', () => {
    expect(handler.schema.safeParse({}).success).toBe(false);
  });
});
