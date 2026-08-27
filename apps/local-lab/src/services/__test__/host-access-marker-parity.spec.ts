import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostAccessFindingSchema } from '@repo/local-lab-contract';

const CHECK_SH = join(__dirname, '..', '..', '..', '..', '..', 'devenv', 'scripts', 'host-access-check.sh');

function shellTokens(re: RegExp): string[] {
  const src = readFileSync(CHECK_SH, 'utf8');
  return [...new Set([...src.matchAll(re)].map((m) => m[1]))].sort();
}

function schemaValues(key: 'probe' | 'severity'): string[] {
  const shape = HostAccessFindingSchema.shape[key];
  return [...shape.options].sort();
}

describe.runIf(existsSync(CHECK_SH))('host-access marker parity', () => {
  it('every probe the shell writer emits is a value this schema accepts', () => {
    const emitted = shellTokens(/^\s*_(?:skip|warn|block)\s+([a-z]+)\b/gm);
    expect(emitted.length).toBeGreaterThan(0);
    expect(schemaValues('probe')).toEqual(expect.arrayContaining(emitted));
  });

  it('every severity the shell writer emits is a value this schema accepts', () => {
    const emitted = shellTokens(/_record\s+"\$1"\s+([a-z]+)\b/gm);
    expect(emitted.length).toBeGreaterThan(0);
    expect(schemaValues('severity')).toEqual(expect.arrayContaining(emitted));
  });
});
