import { describe, expect, it } from 'vitest';
import { jobRedisKeys } from '../redis-keys';

const ZONE = '11111111-1111-1111-1111-111111111111';
const PLAN = '0b0e8f7a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

describe('jobRedisKeys', () => {
  it('builds the serial console log list key', () => {
    expect(jobRedisKeys.solLogs(ZONE, PLAN)).toBe(`${ZONE}:sol:logs:${PLAN}`);
  });

  it('builds the job log stream key', () => {
    expect(jobRedisKeys.jobLogs(ZONE, PLAN)).toBe(`${ZONE}:job:logs:${PLAN}`);
  });
});
