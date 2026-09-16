import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('..', import.meta.url));

const WEBSOCKET_SURFACES = ['components/terminal.tsx'];

const sources = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
  .filter((rel) => /\.tsx?$/.test(rel) && !/\.spec\.tsx?$/.test(rel))
  .map((rel) => ({ rel: rel.split('\\').join('/'), body: readFileSync(`${srcDir}${rel}`, 'utf8') }))
  .filter(({ rel }) => rel !== 'lib/use-host-token.tsx');

const consumers = sources.filter(({ body }) => body.includes('useHostToken(')).map(({ rel }) => rel);
const tsRestConsumers = consumers.filter((rel) => !WEBSOCKET_SURFACES.includes(rel));
const bodyOf = (rel: string) => sources.find((s) => s.rel === rel)?.body ?? '';

describe('useHostToken refusal wiring', () => {
  it('finds the known consumers', () => {
    expect(consumers.sort()).toEqual(
      [
        'components/terminal.tsx',
        'features/datastore/postgres/sql-runner.tsx',
        'lib/apply-run.ts',
        'lib/use-ops.tsx',
        'routes/fleet.tsx',
      ].sort(),
    );
  });

  it.each(tsRestConsumers)('%s handles a refusal that arrives as a rejection', (rel) => {
    expect(bodyOf(rel)).toMatch(/noteThrownRefusal\(/);
  });

  it.each(WEBSOCKET_SURFACES)('%s re-opens the prompt from the socket instead', (rel) => {
    const body = bodyOf(rel);
    expect(body).not.toMatch(/noteThrownRefusal\(/);
    expect(body).toMatch(/(?:^|[^.\w])ask\(\)/m);
  });
});
