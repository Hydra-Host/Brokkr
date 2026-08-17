import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/zones/$zoneId/dns')({
  staticData: { breadcrumb: 'DNS' },
  component: DnsLayout,
});

function DnsLayout() {
  return <Outlet />;
}
