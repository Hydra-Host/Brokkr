import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { type NavSection, useRecentLeaves } from '../nav';

const Icon = () => null;
const urls = ['/a', '/b', '/b/child', '/c', '/d', '/e', '/f', '/g', '/h', '/i'];
const sections: NavSection[] = [
  { title: 'Section', icon: Icon, items: urls.map((url) => ({ title: url.slice(1), url, icon: Icon })) },
];

function renderRecent(pathname: string) {
  return renderHook(({ pathname }: { pathname: string }) => useRecentLeaves(sections, pathname), {
    initialProps: { pathname },
  });
}

describe('useRecentLeaves', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('keeps the current page first and moves a revisited page to the front without duplicates', () => {
    const { result, rerender } = renderRecent('/a');
    rerender({ pathname: '/b' });
    rerender({ pathname: '/a' });
    expect(result.current.map((leaf) => leaf.url)).toEqual(['/a', '/b']);
  });

  it('records the most specific leaf for nested paths', () => {
    const { result } = renderRecent('/b/child/details');
    expect(result.current.map((leaf) => leaf.url)).toEqual(['/b/child']);
  });

  it('ignores paths that match no leaf', () => {
    const { result } = renderRecent('/nowhere');
    expect(result.current).toEqual([]);
  });

  it('caps the list at eight entries, dropping the oldest', () => {
    const { result, rerender } = renderRecent(urls[0]!);
    for (const url of urls.slice(1)) rerender({ pathname: url });
    expect(result.current).toHaveLength(8);
    expect(result.current[0]?.url).toBe('/i');
    expect(result.current.some((leaf) => leaf.url === '/a')).toBe(false);
  });

  it('persists to localStorage and follows changes from another tab', () => {
    const { result } = renderRecent('/a');
    expect(JSON.parse(window.localStorage.getItem('web:recent-leaves') ?? '[]')).toEqual(['/a']);
    act(() => {
      window.localStorage.setItem('web:recent-leaves', JSON.stringify(['/c', '/d']));
      window.dispatchEvent(new StorageEvent('storage', { key: 'web:recent-leaves' }));
    });
    expect(result.current.map((leaf) => leaf.url)).toEqual(['/c', '/d']);
  });
});
