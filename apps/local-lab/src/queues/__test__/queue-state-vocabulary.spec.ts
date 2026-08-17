import { describe, expect, it } from 'vitest';

import { QueueCleanableStateSchema, QueueCountsSchema, QueueJobStateSchema, QueueSummarySchema } from '../../contract';
import { QUEUE_CLEANABLE_STATES, QUEUE_LIST_STATES, QUEUE_SET_STATES, QUEUE_ZSET_STATES } from '../saga-topology';

const countFields: readonly string[] = Object.keys(QueueCountsSchema.shape);
const listStates: readonly string[] = QUEUE_LIST_STATES;
const zsetStates: readonly string[] = QUEUE_ZSET_STATES;
const setStates: readonly string[] = QUEUE_SET_STATES;
const cleanableStates: readonly string[] = QUEUE_CLEANABLE_STATES;

describe('job-state vocabulary parity between the contract and saga-topology', () => {
  it('covers every contract count field with exactly one redis-key-type group', () => {
    expect(new Set([...listStates, ...zsetStates])).toEqual(new Set(countFields));
  });

  it('keeps the list and zset groups disjoint, so no state is read twice or with the wrong command', () => {
    expect(listStates.filter((state) => zsetStates.includes(state))).toEqual([]);
    expect(listStates.length + zsetStates.length).toBe(countFields.length);
  });

  it('reports each set-backed state as its own summary field rather than inside the counts', () => {
    for (const state of setStates) {
      expect(countFields).not.toContain(state);
      expect(Object.keys(QueueSummarySchema.shape)).toContain(state);
    }
  });
});

describe('cleanable-state parity between the contract and saga-topology', () => {
  it('keeps the contract cleanable enum identical to the server-side set', () => {
    expect([...QueueCleanableStateSchema.options].sort()).toEqual([...cleanableStates].sort());
  });

  it('keeps every cleanable state inside the job-state vocabulary', () => {
    for (const state of QUEUE_CLEANABLE_STATES) {
      expect(QueueJobStateSchema.options).toContain(state);
    }
  });

  it('never makes active or waiting-children cleanable', () => {
    expect(cleanableStates).not.toContain('active');
    expect(cleanableStates).not.toContain('waiting-children');
  });
});
