import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = resolve(__dirname, '..');
const ENTRY = resolve(SRC_DIR, 'index.ts');
const REACT_QUERY = /['"]@ts-rest\/react-query|['"]@tanstack\/react-query/;
const IMPORT_FROM = /(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, resolve(base, 'index.ts')]) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function walkGraph(entry: string): { visited: Set<string>; offenders: string[] } {
  const visited = new Set<string>();
  const offenders: string[] = [];
  const stack = [entry];

  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = readFileSync(file, 'utf8');
    if (REACT_QUERY.test(source)) offenders.push(file);

    for (const match of source.matchAll(IMPORT_FROM)) {
      const next = resolveRelative(file, match[1]);
      if (next && !visited.has(next)) stack.push(next);
    }
  }

  return { visited, offenders };
}

describe('api-client root barrel packaging', () => {
  it('does not transitively import @ts-rest/react-query (Node/CLI/MCP-safe)', () => {
    const { offenders } = walkGraph(ENTRY);
    expect(offenders).toEqual([]);
  });

  it('the react-query client remains reachable from the ./client subpath', () => {
    const { offenders } = walkGraph(resolve(SRC_DIR, 'client.ts'));
    expect(offenders.length).toBeGreaterThan(0);
  });
});
