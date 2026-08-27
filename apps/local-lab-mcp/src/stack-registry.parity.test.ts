import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENTRY_FILENAME_PATTERN, defaultRegistryDir, readStackRegistry } from './stack-registry.js';

const LAB_READER = fileURLToPath(new URL('../../local-lab/src/services/stack-registry-client.ts', import.meta.url));

function labSource(): string {
  return readFileSync(LAB_READER, 'utf8');
}

function labRegistryDir(): string {
  const declaration = labSource().match(/const defaultRegistryDir = \(\): string =>\s*([\s\S]*?);\n/);
  if (!declaration) throw new Error(`defaultRegistryDir not found in ${LAB_READER}`);
  const expression = declaration[1]?.replace(/\s+/g, ' ').trim() ?? '';
  const parts = expression.match(
    /^join\(process\.env\.(\w+) \?\? join\(homedir\(\), '([^']+)', '([^']+)'\), '([^']+)', '([^']+)'\)$/,
  );
  if (!parts) throw new Error(`unrecognised registry directory expression: ${expression}`);
  const [, stateHomeVar = '', stateA = '', stateB = '', registryA = '', registryB = ''] = parts;
  return join(process.env[stateHomeVar] ?? join(homedir(), stateA, stateB), registryA, registryB);
}

function labEntryPattern(): RegExp {
  const match = labSource().match(/readdirSync\(this\.dir\)\.filter\(\(\w+\) => \/(.+?)\/\.test\(\w+\)\)/);
  if (!match) throw new Error(`entry filename filter not found in ${LAB_READER}`);
  return new RegExp(match[1] ?? '');
}

describe('stack registry parity with the lab-side reader', () => {
  it('resolves the same registry directory', () => {
    expect(defaultRegistryDir()).toBe(labRegistryDir());
  });

  it('accepts the same entry filenames', () => {
    expect(ENTRY_FILENAME_PATTERN.source).toBe(labEntryPattern().source);
  });

  it('reads exactly the files the lab-side filter accepts', () => {
    const names = ['stack-0.json', 'stack-12.json', 'stack-x.json', 'stack-1.json.bak', 'stack.json', 'notes.txt'];
    const dir = mkdtempSync(join(tmpdir(), 'lab-mcp-parity-'));
    names.forEach((name, index) =>
      writeFileSync(join(dir, name), JSON.stringify({ slot: index, checkout: `/checkouts/${index}` })),
    );
    const accepted = names.filter((name) => labEntryPattern().test(name));
    expect(accepted).toEqual(['stack-0.json', 'stack-12.json']);
    expect(readStackRegistry(dir).map((entry) => entry.slot)).toEqual(
      accepted.map((name) => names.indexOf(name)).sort((a, b) => a - b),
    );
  });
});
