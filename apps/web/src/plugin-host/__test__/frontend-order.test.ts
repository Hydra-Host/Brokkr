import frontendPluginsConfig, { orderFrontendManifests, sidebarOrder } from '@hydrahost/plugins-config/frontend';
import { describe, expect, it } from 'vitest';

const stub = (id: string) => ({ id, version: '0.0.0', frontend: async () => ({}) });

describe('orderFrontendManifests', () => {
  it('renders the declared sidebar order regardless of input order', () => {
    const shuffled = [...sidebarOrder].reverse().map(stub);
    expect(orderFrontendManifests(shuffled).map((p) => p.id)).toEqual([...sidebarOrder]);
  });

  it('keeps webvm-terminal alone when it is the only plugin present (public mirror)', () => {
    expect(orderFrontendManifests([stub('webvm-terminal')]).map((p) => p.id)).toEqual(['webvm-terminal']);
  });

  it('renders an unranked id last rather than dropping it', () => {
    const withUnknown = [stub('brand-new-plugin'), stub('webvm-terminal')];
    expect(orderFrontendManifests(withUnknown).map((p) => p.id)).toEqual(['webvm-terminal', 'brand-new-plugin']);
  });
});

describe('frontendPluginsConfig', () => {
  it('composes this tree in the declared sidebar order', () => {
    const ids = frontendPluginsConfig.map((entry) => entry.plugin.id);
    expect(ids).toEqual(sidebarOrder.filter((id) => ids.includes(id)));
  });

  it('ranks every plugin this tree installs', () => {
    const ids = frontendPluginsConfig.map((entry) => entry.plugin.id);
    expect(ids).toContain('webvm-terminal');
    expect(ids.filter((id) => !sidebarOrder.includes(id))).toEqual([]);
  });
});
