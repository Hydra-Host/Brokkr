import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

describe('public navbar splat vs authenticated routes', () => {
  it('matches a plugin-declared public path on the navbar splat instead of the app catch-all', async () => {
    const root = createRootRoute({});
    const navbar = createRoute({ id: '/_navbar-layout', getParentRoute: () => root });
    const publicSplat = createRoute({ path: '/$', getParentRoute: () => navbar });
    const app = createRoute({ id: '/_app', getParentRoute: () => root });
    const appPage = createRoute({ path: '/deployments', getParentRoute: () => app });
    const router = createRouter({
      routeTree: root.addChildren([app.addChildren([appPage]), navbar.addChildren([publicSplat])]),
      history: createMemoryHistory({ initialEntries: ['/ext/example/listings'] }),
    });

    await router.load();

    expect(router.state.matches.map((match) => match.routeId)).toEqual([
      '__root__',
      '/_navbar-layout',
      '/_navbar-layout/$',
    ]);
  });

  it('still prefers a static authenticated path over the public splat', async () => {
    const root = createRootRoute({});
    const navbar = createRoute({ id: '/_navbar-layout', getParentRoute: () => root });
    const publicSplat = createRoute({ path: '/$', getParentRoute: () => navbar });
    const app = createRoute({ id: '/_app', getParentRoute: () => root });
    const appPage = createRoute({ path: '/deployments', getParentRoute: () => app });
    const router = createRouter({
      routeTree: root.addChildren([app.addChildren([appPage]), navbar.addChildren([publicSplat])]),
      history: createMemoryHistory({ initialEntries: ['/deployments'] }),
    });

    await router.load();

    expect(router.state.matches.map((match) => match.routeId)).toEqual(['__root__', '/_app', '/_app/deployments']);
  });
});
