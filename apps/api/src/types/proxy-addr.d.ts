// Minimal types for proxy-addr (no @types package); only `compile` is used.
declare module 'proxy-addr' {
  function proxyaddr(req: unknown, trust: unknown): string;
  namespace proxyaddr {
    function compile(val: string | string[]): (addr: string, i: number) => boolean;
  }
  export = proxyaddr;
}
