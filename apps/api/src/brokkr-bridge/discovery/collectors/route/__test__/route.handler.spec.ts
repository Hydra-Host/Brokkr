import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RouteHandler } from '../route.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/route', `${name}.json`), 'utf8'));

describe('RouteHandler', () => {
  const handler = new RouteHandler();

  it('parses a route list and returns empty mutation', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    expect(parsed).toHaveLength(2);
    const mutation = await handler.handle(parsed);
    expect(mutation).toEqual({});
  });

  it('accepts empty route list', () => {
    expect(handler.schema.safeParse([]).success).toBe(true);
  });

  it('rejects a non-array payload', () => {
    expect(handler.schema.safeParse({}).success).toBe(false);
  });
});
