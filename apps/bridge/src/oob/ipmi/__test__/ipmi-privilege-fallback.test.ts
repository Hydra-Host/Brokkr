import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PRIVILEGE_DENIED_SIGNATURES,
  PRIVILEGE_FALLBACK_LEVEL,
  PRIVILEGE_FLAG,
  hasPrivilegeFlag,
  isPrivilegeDenied,
  withPrivilegeLevel,
} from '../privilege.js';

const CORPUS_PATH = resolve(__dirname, '..', '..', '..', '..', 'test-vectors', 'ipmi-privilege-fallback-v1.json');

const EXPECTED_CORPUS_SHA256 = '45caedb2c6584717b9d403eaa723db13bcb49414cff49d7c8a40fa0cbf838973';

interface DeniedVector {
  name: string;
  description: string;
  stderr: string;
  expected: boolean;
}

interface FlagVector {
  name: string;
  description: string;
  command: string[];
  expected: boolean;
}

interface ArgvVector {
  name: string;
  description: string;
  command: string[];
  level: string | null;
  expected: string[];
}

interface Corpus {
  version: string;
  constants: {
    PRIVILEGE_FALLBACK_LEVEL: string;
    PRIVILEGE_FLAG: string;
    PRIVILEGE_DENIED_SIGNATURES: string[];
  };
  denied_vectors: DeniedVector[];
  flag_vectors: FlagVector[];
  argv_vectors: ArgvVector[];
}

const corpusBytes = readFileSync(CORPUS_PATH);
const corpus = JSON.parse(corpusBytes.toString('utf8')) as Corpus;

describe('ipmi-privilege-fallback corpus', () => {
  it('matches the pinned sha256', () => {
    expect(createHash('sha256').update(corpusBytes).digest('hex')).toBe(EXPECTED_CORPUS_SHA256);
  });

  it('is the expected version', () => {
    expect(corpus.version).toBe('ipmi-privilege-fallback-v1');
  });

  it('agrees with this runtime on the constants', () => {
    expect(corpus.constants.PRIVILEGE_FALLBACK_LEVEL).toBe(PRIVILEGE_FALLBACK_LEVEL);
    expect(corpus.constants.PRIVILEGE_FLAG).toBe(PRIVILEGE_FLAG);
    expect(corpus.constants.PRIVILEGE_DENIED_SIGNATURES).toEqual([...PRIVILEGE_DENIED_SIGNATURES]);
  });

  it('stores every signature lowercase', () => {
    for (const sig of PRIVILEGE_DENIED_SIGNATURES) {
      expect(sig).toBe(sig.toLowerCase());
    }
  });

  it('carries both verdicts', () => {
    const verdicts = new Set(corpus.denied_vectors.map((v) => v.expected));
    expect([...verdicts].sort()).toEqual([false, true]);
  });
});

describe('isPrivilegeDenied — corpus vectors', () => {
  it.each(corpus.denied_vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    expect(isPrivilegeDenied(vector.stderr), vector.description).toBe(vector.expected);
  });
});

describe('hasPrivilegeFlag — corpus vectors', () => {
  it.each(corpus.flag_vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    expect(hasPrivilegeFlag(vector.command), vector.description).toBe(vector.expected);
  });
});

describe('withPrivilegeLevel — corpus vectors', () => {
  it.each(corpus.argv_vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    const actual =
      vector.level === null ? withPrivilegeLevel(vector.command) : withPrivilegeLevel(vector.command, vector.level);
    expect(actual, vector.description).toEqual(vector.expected);
  });

  it('never mutates its input', () => {
    for (const vector of corpus.argv_vectors) {
      const original = [...vector.command];
      withPrivilegeLevel(original);
      expect(original, `${vector.name} mutated its input`).toEqual(vector.command);
    }
  });
});
