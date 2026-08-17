import React, { createContext, useCallback, useContext, useState } from 'react';

export interface Route {
  screen: string;
  params?: Record<string, string>;
  title?: string;
}

interface RouterContextValue {
  stack: Route[];
  current: Route;
  push: (route: Route) => void;
  pop: () => void;
  reset: (route: Route) => void;
}

const RouterContext = createContext<RouterContextValue>(null!);

export function useRouter() {
  return useContext(RouterContext);
}

export function RouterProvider({ initial, children }: { initial: Route; children: React.ReactNode }) {
  const [stack, setStack] = useState<Route[]>([initial]);

  const current = stack[stack.length - 1]!;

  const push = useCallback((route: Route) => {
    setStack((s) => [...s, route]);
  }, []);

  const pop = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  const reset = useCallback((route: Route) => {
    setStack([route]);
  }, []);

  return <RouterContext.Provider value={{ stack, current, push, pop, reset }}>{children}</RouterContext.Provider>;
}
