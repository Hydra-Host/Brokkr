import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute, Outlet, useLocation } from '@tanstack/react-router';
import { useMemo } from 'react';
import { ResponsiveNavTabs } from '~/components/responsive-nav-tabs';
import { usePermissions } from '~/hooks/use-permissions';
import { activeOrganizationTab, visibleOrganizationTabs } from '~/lib/organization-tabs';

export const Route = createFileRoute('/_app/organizations')({
  staticData: {
    breadcrumb: 'Organization',
    description: 'Manage billing, members, API keys, and organization settings',
  },
  component: OrganizationLayout,
});

function OrganizationLayout() {
  useDocumentTitle('Organization');
  const location = useLocation();
  const { can } = usePermissions();

  const tabs = useMemo(() => visibleOrganizationTabs(can), [can]);
  const activeTab = activeOrganizationTab(location.pathname, tabs);

  return (
    <div className="space-y-6">
      <ResponsiveNavTabs tabs={tabs} activeValue={activeTab?.href ?? tabs[0]?.href} />
      <Outlet />
    </div>
  );
}
