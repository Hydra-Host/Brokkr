import { describe, expect, it } from 'vitest';

import { createRunExclusive } from '../run-exclusive';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createRunExclusive', () => {
  it('runs bodies one at a time in arrival order (no interleaving)', async () => {
    const runExclusive = createRunExclusive();
    const events: string[] = [];
    const gate1 = deferred();

    const first = runExclusive(async () => {
      events.push('1:start');
      await gate1.promise;
      events.push('1:end');
    });
    const second = runExclusive(async () => {
      events.push('2:start');
      events.push('2:end');
    });

    await Promise.resolve();
    expect(events).toEqual(['1:start']);

    gate1.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['1:start', '1:end', '2:start', '2:end']);
  });

  it('returns each body’s resolved value to its own caller', async () => {
    const runExclusive = createRunExclusive();
    const [a, b] = await Promise.all([runExclusive(async () => 'a'), runExclusive(async () => 'b')]);
    expect(a).toBe('a');
    expect(b).toBe('b');
  });

  it('a thrown body rejects only that caller and never breaks the chain', async () => {
    const runExclusive = createRunExclusive();
    const events: string[] = [];

    const failing = runExclusive(async () => {
      events.push('fail:start');
      throw new Error('boom');
    });
    const next = runExclusive(async () => {
      events.push('next:start');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    expect(events).toEqual(['fail:start', 'next:start']);
  });

  it('serializes a burst of concurrent calls without overlap', async () => {
    const runExclusive = createRunExclusive();
    let active = 0;
    let maxConcurrent = 0;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        runExclusive(async () => {
          active += 1;
          maxConcurrent = Math.max(maxConcurrent, active);
          await Promise.resolve();
          active -= 1;
        }),
      ),
    );

    expect(maxConcurrent).toBe(1);
  });
});
