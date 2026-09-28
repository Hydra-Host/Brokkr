import { runWithConcurrency } from '../run-with-concurrency';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function gatedTasks(count: number) {
  const gates = Array.from({ length: count }, () => deferred<void>());
  const counter = { inFlight: 0, peak: 0, started: 0 };
  const tasks = gates.map((gate, i) => async () => {
    counter.inFlight++;
    counter.started++;
    counter.peak = Math.max(counter.peak, counter.inFlight);
    await gate.promise;
    counter.inFlight--;
    return i;
  });
  return { gates, tasks, counter };
}

async function drainInOrder(gates: Deferred<void>[], maxInFlight: number, counter: { inFlight: number }) {
  for (const gate of gates) {
    await flush();
    expect(counter.inFlight).toBeLessThanOrEqual(maxInFlight);
    gate.resolve();
  }
}

describe('runWithConcurrency', () => {
  it('returns results in input order when tasks finish out of order', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const run = runWithConcurrency(
      gates.map((gate) => () => gate.promise),
      3,
    );
    gates[2]!.resolve('c');
    await flush();
    gates[0]!.resolve('a');
    await flush();
    gates[1]!.resolve('b');
    await expect(run).resolves.toEqual(['a', 'b', 'c']);
  });

  it('never runs more than limit tasks at once and reaches limit when there are enough tasks', async () => {
    const { gates, tasks, counter } = gatedTasks(6);
    const run = runWithConcurrency(tasks, 2);
    await flush();
    expect(counter.inFlight).toBe(2);
    expect(counter.started).toBe(2);
    await drainInOrder(gates, 2, counter);
    await expect(run).resolves.toEqual([0, 1, 2, 3, 4, 5]);
    expect(counter.peak).toBe(2);
  });

  it('runs every task at once when limit exceeds the task count', async () => {
    const { gates, tasks, counter } = gatedTasks(3);
    const run = runWithConcurrency(tasks, 10);
    await flush();
    expect(counter.inFlight).toBe(3);
    await drainInOrder([...gates].reverse(), 3, counter);
    await expect(run).resolves.toEqual([0, 1, 2]);
    expect(counter.peak).toBe(3);
  });

  it('resolves to an empty array for an empty task list', async () => {
    await expect(runWithConcurrency([], 4)).resolves.toEqual([]);
  });

  it.each([0, -3])('clamps a limit of %d to one task at a time and still runs every task', async (limit) => {
    const { gates, tasks, counter } = gatedTasks(4);
    const run = runWithConcurrency(tasks, limit);
    await flush();
    expect(counter.inFlight).toBe(1);
    await drainInOrder(gates, 1, counter);
    await expect(run).resolves.toEqual([0, 1, 2, 3]);
    expect(counter.peak).toBe(1);
    expect(counter.started).toBe(4);
  });

  it('rejects with the first error raised', async () => {
    const first = new Error('first');
    const second = new Error('second');
    const slow = deferred<number>();
    const fast = deferred<number>();
    const run = runWithConcurrency([() => slow.promise, () => fast.promise], 2);
    fast.reject(first);
    await flush();
    slow.reject(second);
    await expect(run).rejects.toBe(first);
  });
});
