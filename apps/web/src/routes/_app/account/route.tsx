import { createFileRoute, Outlet, useLocation } from '@tanstack/react-router';

import { ResponsiveNavTabs } from '@repo/domain-ui/components/responsive-nav-tabs';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';

const tabs = [
  { name: 'User Profile', href: '/account/profile' },
  { name: 'SSH Keys', href: '/account/ssh-keys' },
  { name: 'Theme', href: '/account/theme' },
];

export const Route = createFileRoute('/_app/account')({
  staticData: { breadcrumb: 'Account Settings', description: 'Manage your profile, SSH keys, and preferences' },
  component: AccountSettingsLayout,
});

function AccountSettingsLayout() {
  useDocumentTitle('Account Settings');
  const location = useLocation();

  const activeTab = tabs.find((tab) => location.pathname === tab.href || location.pathname.startsWith(tab.href + '/'));

  return (
    <div className="space-y-6">
      <ResponsiveNavTabs tabs={tabs} activeValue={activeTab?.href ?? tabs[0].href} />
      <Outlet />
    </div>
  );
}
