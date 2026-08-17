import { describe, expect, it } from 'vitest';

import { streamCompletedNormally } from './use-log-stream';

describe('streamCompletedNormally', () => {
  it('completes a finite stream whose server sent the done sentinel', () => {
    expect(streamCompletedNormally({ finite: true, done: true })).toBe(true);
  });

  it('does not complete a finite stream that closed without the sentinel — that is a drop, retry', () => {
    expect(streamCompletedNormally({ finite: true, done: false })).toBe(false);
  });

  it('never completes an infinite tail — any close is abnormal and retries', () => {
    expect(streamCompletedNormally({ finite: false, done: false })).toBe(false);
    expect(streamCompletedNormally({ finite: false, done: true })).toBe(false);
  });
});
