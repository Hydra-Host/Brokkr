import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyEnvPreboot, envSetDefault } from '../env-preboot.js';

describe('envSetDefault', () => {
  const ORIGINAL_VALUE = process.env.GRPC_VERBOSITY;

  beforeEach(() => {
    delete process.env.GRPC_VERBOSITY;
  });

  afterEach(() => {
    if (ORIGINAL_VALUE === undefined) {
      delete process.env.GRPC_VERBOSITY;
    } else {
      process.env.GRPC_VERBOSITY = ORIGINAL_VALUE;
    }
  });

  it('writes the default when the variable is unset', () => {
    envSetDefault('GRPC_VERBOSITY', 'ERROR');
    expect(process.env.GRPC_VERBOSITY).toBe('ERROR');
  });

  it('preserves an explicit empty-string override', () => {
    process.env.GRPC_VERBOSITY = '';
    envSetDefault('GRPC_VERBOSITY', 'ERROR');
    expect(process.env.GRPC_VERBOSITY).toBe('');
  });

  it('preserves an operator override', () => {
    process.env.GRPC_VERBOSITY = 'DEBUG';
    envSetDefault('GRPC_VERBOSITY', 'ERROR');
    expect(process.env.GRPC_VERBOSITY).toBe('DEBUG');
  });
});

describe('applyEnvPreboot', () => {
  const ORIGINAL_VALUE = process.env.GRPC_VERBOSITY;

  beforeEach(() => {
    delete process.env.GRPC_VERBOSITY;
  });

  afterEach(() => {
    if (ORIGINAL_VALUE === undefined) {
      delete process.env.GRPC_VERBOSITY;
    } else {
      process.env.GRPC_VERBOSITY = ORIGINAL_VALUE;
    }
  });

  it('sets GRPC_VERBOSITY=ERROR when unset', () => {
    applyEnvPreboot();
    expect(process.env.GRPC_VERBOSITY).toBe('ERROR');
  });

  it('is idempotent — re-invocation leaves the prior value', () => {
    applyEnvPreboot();
    process.env.GRPC_VERBOSITY = 'WARNING';
    applyEnvPreboot();
    expect(process.env.GRPC_VERBOSITY).toBe('WARNING');
  });

  it('does not override an operator-set GRPC_VERBOSITY', () => {
    process.env.GRPC_VERBOSITY = 'INFO';
    applyEnvPreboot();
    expect(process.env.GRPC_VERBOSITY).toBe('INFO');
  });
});
