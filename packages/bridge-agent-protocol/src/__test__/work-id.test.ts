
import { describe, expect, it } from 'vitest';

import { WorkId } from '../envelope.js';
import { operations } from '../operations/index.js';

const FIRST_OPERATION = Object.keys(operations)[0]!;

describe('WorkId schema', () => {
  it('accepts a UUIDv4', () => {
    const result = WorkId.safeParse('123e4567-e89b-42d3-a456-426614174000');
    expect(result.success).toBe(true);
  });

  it('accepts a composite with a UUID job_id and a registered operation', () => {
    const result = WorkId.safeParse(`123e4567-e89b-42d3-a456-426614174000:${FIRST_OPERATION}`);
    expect(result.success).toBe(true);
  });

  it('accepts a composite with an alphanum BullMQ job_id', () => {
    const result = WorkId.safeParse(`abc123XYZ:${FIRST_OPERATION}`);
    expect(result.success).toBe(true);
  });

  it('rejects a composite that names an unknown operation', () => {
    const result = WorkId.safeParse('123e4567-e89b-42d3-a456-426614174000:no.such.operation');
    expect(result.success).toBe(false);
  });

  it('accepts a composite ONLY when the operation is registered', () => {
    const goodId = `abc123:${FIRST_OPERATION}`;
    const badId = 'abc123:definitely.not.real';
    expect(WorkId.safeParse(goodId).success).toBe(true);
    expect(WorkId.safeParse(badId).success).toBe(false);
  });

  it('rejects a string that is neither a UUID nor a composite', () => {
    const result = WorkId.safeParse('not-a-uuid-and-not-composite');
    expect(result.success).toBe(false);
  });

  it('rejects a composite with no colon', () => {
    const result = WorkId.safeParse(`some-job-id-no-colon-${FIRST_OPERATION}`);
    expect(result.success).toBe(false);
  });

  it('rejects an empty string', () => {
    const result = WorkId.safeParse('');
    expect(result.success).toBe(false);
  });

  it('rejects a composite with a job_id containing forbidden characters', () => {
    const result = WorkId.safeParse(`bad job id:${FIRST_OPERATION}`);
    expect(result.success).toBe(false);
  });
});
