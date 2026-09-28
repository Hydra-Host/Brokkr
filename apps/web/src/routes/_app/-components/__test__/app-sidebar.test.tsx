import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let pathname = '/ipam/vrfs';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname }),
}));

vi.mock('~/plugin-host', () => ({
  usePluginRegistry: () => ({ publicRoutes: [] }),
  findPublicPluginRoute: () => undefined,
}));

vi.mock('@repo/ui/animated-sidebar-logo', () => ({
  AnimatedSidebarLogo: () => <div data-testid="logo" />,
}));

import { SidebarProvider } from '@repo/ui/components/sidebar';
import type { NavSection } from '~/lib/nav';
import { AppSidebar } from '../app-sidebar';

const Icon = () => null;

const sections: NavSection[] = [
  {
    title: 'Infrastructure',
    icon: Icon,
    items: [
      { title: 'Zones', url: '/dcim/zones', icon: Icon },
      { title: 'Bridges', url: '/dcim/bridges', icon: Icon },
      { title: 'VRFs', url: '/ipam/vrfs', icon: Icon },
    ],
  },
  { title: 'Help', icon: Icon, items: [{ title: 'Docs', url: 'https://docs.example', icon: Icon, external: true }] },
  {
    title: 'Organization Settings',
    icon: Icon,
    footer: true,
    items: [
      { title: 'Members', url: '/organizations/members', icon: Icon },
      { title: 'Roles', url: '/organizations/roles', icon: Icon },
    ],
  },
];

function renderSidebar() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  return render(
    <SidebarProvider>
      <AppSidebar sections={sections} dashboard={{ title: 'Dashboard', url: '/dashboard', icon: Icon }} />
    </SidebarProvider>,
  );
}

describe('AppSidebar', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('opens only the accordion that owns the current route and marks the leaf active', () => {
    pathname = '/ipam/vrfs';
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Infrastructure' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Help' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('link', { name: 'VRFs' })).toHaveAttribute('aria-current', 'page');
  });

  it('toggles an accordion on click', () => {
    pathname = '/ipam/vrfs';
    renderSidebar();
    const header = screen.getByRole('button', { name: 'Help' });
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders the dashboard link above the accordions', () => {
    pathname = '/ipam/vrfs';
    renderSidebar();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/dashboard');
  });

  it('renders Organization Settings as a flat footer list instead of an accordion', () => {
    pathname = '/ipam/vrfs';
    renderSidebar();
    expect(screen.queryByRole('button', { name: 'Organization Settings' })).not.toBeInTheDocument();
    const footer = screen.getByRole('navigation', { name: 'Organization Settings' });
    expect(within(footer).getByRole('link', { name: 'Members' })).toHaveAttribute('href', '/organizations/members');
  });

  it('lists pinned leaves under the Favorites pinned tab', () => {
    pathname = '/dcim/zones';
    window.localStorage.setItem('web:pinned-leaves', JSON.stringify(['/dcim/bridges']));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));
    expect(screen.getAllByRole('link', { name: 'Bridges' })).toHaveLength(2);
  });

  it('lists visited leaves under the Favorites recent tab', () => {
    pathname = '/dcim/zones';
    window.localStorage.setItem('web:recent-leaves', JSON.stringify(['/ipam/vrfs']));
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Recent' }));
    const recent = screen.getByRole('tabpanel');
    expect(
      within(recent)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Zones', 'VRFs']);
  });
});
