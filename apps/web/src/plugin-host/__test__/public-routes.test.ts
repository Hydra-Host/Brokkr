import { describe, expect, it } from 'vitest';

import {
  findPublicPluginRoute,
  normalizePublicPath,
  pluginIdFromPluginsPath,
  publicRedirectFromPluginAppMount,
  validatePublicPluginRoutes,
  type PublicRouteRegistryEntry,
} from '../public-routes';

const examplePublic: PublicRouteRegistryEntry = {
  pluginId: 'example',
  route: {
    path: '/ext/example/listings',
    layout: 'navbar',
    component: () => null,
  },
};

function publicRoute(pluginId: string, path: string): PublicRouteRegistryEntry {
  return { pluginId, route: { path, layout: 'navbar', component: () => null } };
}

describe('normalizePublicPath', () => {
  it('strips a trailing slash except for root', () => {
    expect(normalizePublicPath('/ext/example/listings/')).toBe('/ext/example/listings');
    expect(normalizePublicPath('/ext/example/listings///')).toBe('/ext/example/listings');
    expect(normalizePublicPath('/')).toBe('/');
  });
});

describe('validatePublicPluginRoutes', () => {
  it('allows an arbitrary absolute product path', () => {
    expect(validatePublicPluginRoutes([publicRoute('example', '/foo/bar')], () => false)).toEqual({
      invalidPluginIds: new Set(),
      errors: [],
    });
  });

  it('rejects relative, protocol-relative, query, and hash paths', () => {
    for (const path of ['foo/bar', '//foo/bar', '/foo/bar?x=1', '/foo/bar#details']) {
      const result = validatePublicPluginRoutes([publicRoute('example', path)], () => false);
      expect(result.invalidPluginIds).toEqual(new Set(['example']));
      expect(result.errors).toEqual([
        `Public route "${path}" from plugin "example" must be an absolute path without query or hash`,
      ]);
    }
  });

  it('rejects duplicate normalized paths and names both plugins', () => {
    const result = validatePublicPluginRoutes(
      [publicRoute('first', '/foo/bar/'), publicRoute('second', '/foo/bar')],
      () => false,
    );

    expect(result.invalidPluginIds).toEqual(new Set(['first', 'second']));
    expect(result.errors).toEqual(['Public route collision at "/foo/bar" between plugins "first", "second"']);
  });

  it('rejects the same plugin declaring a path twice', () => {
    const result = validatePublicPluginRoutes(
      [publicRoute('example', '/foo/bar'), publicRoute('example', '/foo/bar/')],
      () => false,
    );

    expect(result.invalidPluginIds).toEqual(new Set(['example']));
    expect(result.errors).toEqual(['Public route "/foo/bar" is declared more than once by plugin "example"']);
  });

  it('rejects a path claimed by the core host', () => {
    const result = validatePublicPluginRoutes([publicRoute('example', '/inventory')], (path) => path === '/inventory');

    expect(result.invalidPluginIds).toEqual(new Set(['example']));
    expect(result.errors).toEqual(['Public route "/inventory" from plugin "example" conflicts with a core host route']);
  });

  it('does not treat two plugins on a core path as an inter-plugin collision', () => {
    const result = validatePublicPluginRoutes(
      [publicRoute('first', '/inventory'), publicRoute('second', '/inventory/')],
      (path) => path === '/inventory',
    );

    expect(result.invalidPluginIds).toEqual(new Set(['first', 'second']));
    expect(result.errors).toEqual([
      'Public route "/inventory" from plugin "first" conflicts with a core host route',
      'Public route "/inventory" from plugin "second" conflicts with a core host route',
    ]);
  });
});

describe('findPublicPluginRoute', () => {
  it('matches a navbar path declared by a plugin', () => {
    expect(findPublicPluginRoute([examplePublic], '/ext/example/listings', 'navbar')?.pluginId).toBe('example');
  });

  it('returns undefined when no plugin owns the path', () => {
    expect(findPublicPluginRoute([examplePublic], '/ext/other', 'navbar')).toBeUndefined();
  });

  it('does not treat a parent prefix as a match', () => {
    expect(findPublicPluginRoute([examplePublic], '/ext/example', 'navbar')).toBeUndefined();
  });
});

describe('pluginIdFromPluginsPath', () => {
  it('reads the plugin id from the authenticated mount', () => {
    expect(pluginIdFromPluginsPath('/plugins/example')).toBe('example');
    expect(pluginIdFromPluginsPath('/plugins/example/nested')).toBe('example');
    expect(pluginIdFromPluginsPath('/plugins')).toBeUndefined();
    expect(pluginIdFromPluginsPath('/ext/example/listings')).toBeUndefined();
  });
});

describe('publicRedirectFromPluginAppMount', () => {
  it('leaves /plugins/:id for the plugin public navbar path, including nested leftover app URLs', () => {
    expect(publicRedirectFromPluginAppMount('/plugins/example', '', [examplePublic])).toBe('/ext/example/listings');
    expect(publicRedirectFromPluginAppMount('/plugins/example/nested', '?offerId=1', [examplePublic])).toBe(
      '/ext/example/listings?offerId=1',
    );
  });

  it('does not redirect unknown plugin ids', () => {
    expect(publicRedirectFromPluginAppMount('/plugins/other', '', [examplePublic])).toBeUndefined();
  });
});
