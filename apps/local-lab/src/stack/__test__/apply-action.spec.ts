import { APPLY_ACTION, ApplyClassSchema } from '@repo/local-lab-contract';

import { STACK_OPS } from '../stack.service';

describe('APPLY_ACTION against the op registry', () => {
  const ids = new Set(STACK_OPS.map((op) => op.id));

  it('names an op the registry lists for every stack-op action', () => {
    const named = ApplyClassSchema.options
      .map((cls) => APPLY_ACTION[cls])
      .filter((a): a is { kind: 'stack-op'; opId: string } => a?.kind === 'stack-op');

    expect(named.length).toBeGreaterThan(0);
    for (const action of named) expect(ids.has(action.opId)).toBe(true);
  });

  it('routes a datastore reset at an op that actually wipes the datastores', () => {
    const action = APPLY_ACTION['datastore-reset'];
    expect(action).toEqual({ kind: 'stack-op', opId: 'reinit' });
    const op = STACK_OPS.find((o) => o.id === 'reinit');
    expect(op?.destructive).toBe(true);
  });
});
