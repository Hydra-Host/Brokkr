export async function runWithConcurrency<T>(tasks: ReadonlyArray<() => Promise<T>>, limit: number): Promise<T[]> {
  if (tasks.length === 0) return [];
  const results: T[] = new Array(tasks.length);
  const bound = Math.max(1, limit);
  let next = 0;
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      const task = tasks[i]!;
      results[i] = await task();
    }
  };
  for (let i = 0; i < Math.min(bound, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}
