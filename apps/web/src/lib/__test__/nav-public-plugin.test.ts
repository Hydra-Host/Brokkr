import { describe, expect, it, vi } from 'vitest';

import { followInternalNavClick, getVisibleLeaves, mergeNavSections, type NavSection } from '../nav';

const Icon = () => null;

describe('mergeNavSections', () => {
  it('appends plugin leaves onto a host section with the same title', () => {
    const host: NavSection[] = [
      { title: 'Rentals', icon: Icon, items: [{ title: 'Servers Available', url: '/inventory/categories', icon: Icon }] },
    ];
    const plugin: NavSection[] = [
      { title: 'Rentals', icon: Icon, items: [{ title: 'Plugin Listings', url: '/ext/example/listings', icon: Icon }] },
    ];
    const merged = mergeNavSections(host, plugin);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.items.map((item) => item.title)).toEqual(['Servers Available', 'Plugin Listings']);
  });

  it('keeps an unmatched plugin section instead of dropping it', () => {
    const host: NavSection[] = [{ title: 'Rentals', icon: Icon, items: [] }];
    const plugin: NavSection[] = [{ title: 'Plugins', icon: Icon, items: [{ title: 'Thing', url: '/plugins/thing', icon: Icon }] }];
    expect(mergeNavSections(host, plugin).map((section) => section.title)).toEqual(['Rentals', 'Plugins']);
  });
});

describe('followInternalNavClick', () => {
  it('pushes on a primary click and ignores modified clicks', () => {
    const push = vi.fn();
    followInternalNavClick(
      { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0, preventDefault: vi.fn() },
      '/ext/example/listings',
      push,
    );
    expect(push).toHaveBeenCalledWith('/ext/example/listings');

    push.mockClear();
    followInternalNavClick(
      { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, button: 0, preventDefault: vi.fn() },
      '/ext/example/listings',
      push,
    );
    expect(push).not.toHaveBeenCalled();
  });
});

describe('getVisibleLeaves', () => {
  it('stamps each leaf with its section title', () => {
    const sections: NavSection[] = [
      { title: 'Rentals', icon: Icon, items: [{ title: 'Servers', url: '/servers', icon: Icon }] },
      { title: 'Account', icon: Icon, items: [{ title: 'Settings', url: '/settings', icon: Icon }] },
    ];
    expect(getVisibleLeaves(sections).map((leaf) => [leaf.title, leaf.sectionTitle])).toEqual([
      ['Servers', 'Rentals'],
      ['Settings', 'Account'],
    ]);
  });

  it('returns an empty array for empty sections', () => {
    expect(getVisibleLeaves([])).toEqual([]);
  });

  it('skips sections with no items', () => {
    const sections: NavSection[] = [{ title: 'Empty', icon: Icon, items: [] }];
    expect(getVisibleLeaves(sections)).toEqual([]);
  });
});
