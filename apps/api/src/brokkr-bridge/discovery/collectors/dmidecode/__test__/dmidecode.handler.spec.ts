import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DmidecodeHandler } from '../dmidecode.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/dmidecode', `${name}.json`), 'utf8'));

describe('DmidecodeHandler', () => {
  const handler = new DmidecodeHandler();

  it('parses any array without throwing', () => {
    expect(handler.schema.safeParse(fixture('happy')).success).toBe(true);
  });

  it('returns an empty mutation', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    expect(mutation).toEqual({});
  });

  it('rejects a non-array payload', () => {
    expect(handler.schema.safeParse({ values: 'not an array' }).success).toBe(false);
  });
});
