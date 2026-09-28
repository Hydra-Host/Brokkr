import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute } from '@tanstack/react-router';
import { LayoutDashboard } from 'lucide-react';

export const Route = createFileRoute('/_app/dashboard')({
  staticData: { breadcrumb: 'Dashboard' },
  component: DashboardPage,
});

function DashboardPage() {
  useDocumentTitle('Dashboard');

  return (
    <Card className="mx-auto mt-16 max-w-lg">
      <CardHeader className="items-center text-center">
        <LayoutDashboard className="text-accent mb-2 size-8" />
        <CardTitle>Dashboard</CardTitle>
        <CardDescription>Coming soon.</CardDescription>
      </CardHeader>
      <CardContent className="text-text-muted text-center font-mono text-sm">
        Shortcuts, alerts and recently viewed pages will land here. Until then, use the sidebar or press ⌘K to jump
        anywhere.
      </CardContent>
    </Card>
  );
}
