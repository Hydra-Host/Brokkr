function liveProxy(key: 'stdin' | 'stdout' | 'stderr'): any {
  return new Proxy(
    {},
    {
      get(_, prop) {
        const target = (globalThis.process as any)?.[key];
        const value = target?.[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(_, prop, value) {
        const target = (globalThis.process as any)?.[key];
        if (target) target[prop as string] = value;
        return true;
      },
      has(_, prop) {
        const target = (globalThis.process as any)?.[key];
        return target ? prop in target : false;
      },
    },
  );
}

export default globalThis.process;
export const stdin = liveProxy('stdin');
export const stdout = liveProxy('stdout');
export const stderr = liveProxy('stderr');
export const { argv, env, cwd, platform, version, versions } = globalThis.process;
export function exit(code?: number): never {
  return (globalThis.process.exit as (c?: number) => never)(code);
}
export function nextTick(fn: () => void): void {
  setTimeout(fn, 0);
}
