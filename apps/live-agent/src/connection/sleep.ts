export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    // Each path clears the other side's resource — otherwise a reused signal leaks one listener per call.
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const onTimer = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(onTimer, ms);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
