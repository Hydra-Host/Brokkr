import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

function valueImports(file: string): string[] {
  const source = readFileSync(join(SRC, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  return [...source.matchAll(/^import\b([^;]*?\bfrom\b)?\s*(['"])([^'"]+)\2/gm)]
    .filter((match) => !/^import\s+type\b/.test(match[0]))
    .map((match) => match[3])
    .filter((specifier) => specifier !== undefined);
}

describe('light-import contract (disabled boots stay cheap)', () => {
  it('index.ts statically imports only the vetted light modules', () => {
    expect(valueImports('index.ts').sort()).toEqual(
      [
        '@opentelemetry/api',
        '@opentelemetry/api-logs',
        'bullmq-otel',
        './enablement',
        './load-sdk',
        './status',
      ].sort(),
    );
  });

  it('load-sdk.ts keeps the heavy half behind the lazy require', () => {
    expect(valueImports('load-sdk.ts')).toEqual([]);
  });
});
