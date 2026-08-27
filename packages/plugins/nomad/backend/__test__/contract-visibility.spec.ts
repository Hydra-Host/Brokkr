import { describe, expect, it } from 'vitest';

import { contractFragment } from '../../contract';

const JOB_ROUTE_KEYS = [
  'nomadValidate',
  'nomadPlan',
  'nomadSubmit',
  'nomadStatus',
  'nomadStop',
  'nomadJob',
  'nomadNodes',
  'nomadAllocs',
  'nomadLogs',
  'nomadDispatch',
] as const;

describe('nomad contract OpenAPI visibility', () => {
  it('keeps health + job routes internal (peer operator-plugin convention)', () => {
    expect(contractFragment.nomadHealth.metadata?.visibility).toBe('internal');
    for (const key of JOB_ROUTE_KEYS) {
      expect(contractFragment[key].metadata?.visibility, key).toBe('internal');
    }
  });
});
