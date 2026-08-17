import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CollectionMetadataHandler } from '../collection_metadata.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/collection_metadata', `${name}.json`), 'utf8'));

describe('CollectionMetadataHandler', () => {
  const handler = new CollectionMetadataHandler();

  it('emits no warning when all collectors succeeded', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    expect(mutation).toEqual({});
  });

  it('warns on partial bridge-side success', async () => {
    const parsed = handler.schema.parse({
      collectors_total: 20,
      collectors_successful: 17,
      collector_version: 'comprehensive_cli',
    });
    const mutation = await handler.handle(parsed);
    expect(mutation.warnings?.[0]).toMatch(/17\/20 collectors ok/);
  });

  it('rejects missing collector_version (required for DiscoveryRun stamping)', () => {
    expect(
      handler.schema.safeParse({
        collectors_total: 20,
        collectors_successful: 20,
      }).success,
    ).toBe(false);
  });
});
