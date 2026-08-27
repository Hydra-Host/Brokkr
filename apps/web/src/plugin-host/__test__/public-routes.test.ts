import { describe, expect, it } from 'vitest';

import {
  findPublicPluginRoute,
  normalizePublicPath,
  pluginIdFromPluginsPath,
  publicRedirectFromPluginAppMount,
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

describe('normalizePublicPath', () => {
  it('strips a trailing slash except for root', () => {
    expect(normalizePublicPath('/ext/example/listings/')).toBe('/ext/example/listings');
    expect(normalizePublicPath('/')).toBe('/');
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
