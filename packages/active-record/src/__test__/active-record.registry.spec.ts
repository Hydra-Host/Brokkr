import { afterEach, describe, expect, it } from 'vitest';

import { ActiveRecordRegistry } from '../active-record.registry';

describe('ActiveRecordRegistry.configureForTest production guard', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('throws when NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => ActiveRecordRegistry.configureForTest({})).toThrow(/test-only escape hatch/);
  });

  it('does not throw under the test environment', () => {
    process.env.NODE_ENV = 'test';
    expect(() =>
      ActiveRecordRegistry.configureForTest({}, () => ({ organizationId: 'org-1', permissions: new Set<string>() })),
    ).not.toThrow();
  });
});
