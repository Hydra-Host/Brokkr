import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { runLogPath } from '../../ledger/run-log-store';
import { resultsDir } from '../../results-root';
import { assertSafeRunId, isSafeRunId } from '../run-id';

describe('isSafeRunId', () => {
  it('accepts the ids the runner actually mints', () => {
    for (const id of ['b1f0c2de-4a8e-4b21-9d55-1f2e3a4b5c6d', 'created-0', 'run.1', 'A_b-9']) {
      expect(isSafeRunId(id), id).toBe(true);
    }
  });

  it('rejects anything that is not one safe path segment', () => {
    const hostile = [
      '..',
      '../../etc/passwd',
      '../../secret',
      '/etc/passwd',
      'a/b',
      'a\\b',
      './x',
      '.hidden',
      '-flag',
      '',
      'a b',
      'a\u0000b',
      'C:\\win',
    ];
    for (const id of hostile) expect(isSafeRunId(id), id).toBe(false);
  });
});

describe('assertSafeRunId', () => {
  it('throws NotFoundException so a traversal attempt 404s', () => {
    expect(() => assertSafeRunId('../../secret')).toThrow(NotFoundException);
  });

  it('passes a legitimate id through', () => {
    expect(() => assertSafeRunId('created-0')).not.toThrow();
  });
});

describe('run id path builders reject traversal', () => {
  it('resultsDir refuses to escape the results root', () => {
    expect(() => resultsDir('../../secret')).toThrow(NotFoundException);
    expect(resultsDir('created-0')).toContain('created-0-results');
  });

  it('runLogPath refuses to escape the run log dir', () => {
    expect(() => runLogPath('..%2F..%2Fsecret'.replace(/%2F/g, '/'))).toThrow(NotFoundException);
    expect(runLogPath('created-0')).toContain('created-0.log');
  });
});
