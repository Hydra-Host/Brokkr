import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { AnchorHTMLAttributes } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const overflow = vi.hoisted(() => ({ visibleCount: 2 }));

vi.mock('@repo/ui/hooks/use-overflow-tabs', () => ({
  useOverflowTabs: () => ({
    containerRef: { current: null },
    setItemRef: () => () => {},
    visibleCount: overflow.visibleCount,
    measured: true,
  }),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, ...props }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={to} {...props} />,
  useNavigate: () => vi.fn(),
}));

import { ResponsiveNavTabs } from '../responsive-nav-tabs';

const tabs = [
  { name: 'Overview', href: '/dcim/servers/dev-1' },
  { name: 'Networking', href: '/dcim/servers/dev-1/networking' },
  { name: 'Diagnostics', href: '/dcim/servers/dev-1/diagnostics' },
  { name: 'Settings', href: '/dcim/servers/dev-1/settings' },
];

afterEach(() => {
  cleanup();
  overflow.visibleCount = 2;
});

describe('ResponsiveNavTabs', () => {
  it('renders the tabs that fit in the tablist and the rest as menu links', () => {
    render(<ResponsiveNavTabs tabs={tabs} activeValue="/dcim/servers/dev-1" />);
    const tablist = screen.getByRole('tablist');
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Overview', 'Networking']);

    const trigger = screen.getByRole('button', { name: 'More' });
    expect(trigger.hasAttribute('data-selected')).toBe(false);
    fireEvent.click(trigger);

    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Diagnostics', 'Settings']);
    expect(items.map((item) => item.getAttribute('href'))).toEqual([
      '/dcim/servers/dev-1/diagnostics',
      '/dcim/servers/dev-1/settings',
    ]);
  });

  it('names the hidden active tab on the trigger and marks it selected', () => {
    render(<ResponsiveNavTabs tabs={tabs} activeValue="/dcim/servers/dev-1/diagnostics" />);
    const trigger = screen.getByRole('button', { name: 'Diagnostics' });
    expect(trigger.hasAttribute('data-selected')).toBe(true);
  });

  it('renders no trigger when every tab fits', () => {
    overflow.visibleCount = tabs.length;
    render(<ResponsiveNavTabs tabs={tabs} activeValue="/dcim/servers/dev-1" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(within(screen.getByRole('tablist')).getAllByRole('tab')).toHaveLength(4);
  });

  it('keeps every tab in the mobile select', () => {
    render(<ResponsiveNavTabs tabs={tabs} activeValue="/dcim/servers/dev-1" />);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Overview',
      'Networking',
      'Diagnostics',
      'Settings',
    ]);
  });
});
