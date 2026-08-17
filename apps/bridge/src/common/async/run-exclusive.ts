// A thrown body rejects only its caller; `finally` always resolves the tail, so the chain never deadlocks on a predecessor's failure.
export function createRunExclusive(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = tail;
    let resolveNext!: () => void;
    tail = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    try {
      await prev;
      return await fn();
    } finally {
      resolveNext();
    }
  };
}
