import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LshwHandler } from '../lshw.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/lshw', `${name}.json`), 'utf8'));

describe('LshwHandler', () => {
  const handler = new LshwHandler();

  it('accepts the root shape and returns empty mutation', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    expect(mutation).toEqual({});
  });

  it('rejects a tree missing id/class', () => {
    expect(handler.schema.safeParse({ product: 'X' }).success).toBe(false);
  });
});
