import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute, Link, Outlet, useNavigate } from '@tanstack/react-router';
import { ExternalLink, Key, MoreHorizontal, Plus, Rocket, Trash2 } from 'lucide-react';
import { useMemo } from 'react';

import type { ApiKeyWithCreator } from '@repo/api-client';
import { useSession } from '@repo/auth/client';
import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { formatShortDate } from '@repo/utils';
import { BootScreen } from '~/components/boot-screen';
import { usePermissions } from '~/hooks/use-permissions';
import { tsr } from '~/lib/api';
import { BRAND_NAME } from '~/lib/branding';

export const Route = createFileRoute('/_app/organizations/api-keys')({
  staticData: { breadcrumb: 'API Keys', description: 'Create and manage API keys for programmatic access' },
  component: ApiKeysPage,
});

const apiKeyBaseColumns: ServerColumnDef<ApiKeyWithCreator>[] = [
  {
    accessorKey: 'name',
    header: 'Name',
    sortField: 'name',
    cell: ({ row }) => (
      <div className="flex items-center gap-2 overflow-hidden">
        <Key className="text-muted-foreground h-4 w-4 shrink-0" />
        <span className="font-medium">{row.original.name || 'Unnamed Key'}</span>
      </div>
    ),
  },
  {
    accessorKey: 'start',
    header: 'Key Preview',
    breakpoint: 'tablet',
    size: 140,
    cell: ({ row }) => {
      const preview = row.original.start ? `${row.original.start}...` : '—';
      return <code className="text-muted-foreground text-xs">{preview}</code>;
    },
  },
  {
    accessorKey: 'createdByEmail',
    header: 'Created By',
    breakpoint: 'tablet',
    enableSorting: false,
    cell: ({ row }) => (
      <span className="text-muted-foreground text-sm">{row.original.createdByName || row.original.createdByEmail}</span>
    ),
  },
  {
    accessorKey: 'createdAt',
    header: 'Created',
    sortField: 'createdAt',
    breakpoint: 'desktop',
    size: 130,
    cell: ({ row }) => <span className="text-muted-foreground text-sm">{formatShortDate(row.original.createdAt)}</span>,
  },
  {
    accessorKey: 'expiresAt',
    header: 'Expires',
    sortField: 'expiresAt',
    size: 130,
    cell: ({ row }) => {
      const expiresAt = row.original.expiresAt;
      if (!expiresAt) return <Badge variant="outline">Never</Badge>;
      const isExpired = new Date(expiresAt) < new Date();
      return (
        <Badge variant={isExpired ? 'destructive' : 'outline'}>
          {isExpired ? 'Expired' : formatShortDate(expiresAt)}
        </Badge>
      );
    },
  },
];

function makeActionsColumn(canManage: (row: ApiKeyWithCreator) => boolean): ServerColumnDef<ApiKeyWithCreator> {
  return {
    id: 'actions',
    size: 48,
    cell: ({ row }) => {
      if (!canManage(row.original)) return null;
      return (
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link to="/organizations/api-keys/delete/$apiKeyId" params={{ apiKeyId: row.original.id }}>
                  <Trash2 className="text-destructive mr-2 h-4 w-4" />
                  Delete
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      );
    },
  };
}

function ApiKeysPage() {
  useDocumentTitle('API Keys');

  const navigate = useNavigate();
  const { data: session } = useSession();
  const myUserId = session?.user?.id;
  const { can } = usePermissions();
  const canCreate = can('api-key', 'create');
  const canDelete = can('api-key', 'delete');

  const columns = useMemo(
    () => [...apiKeyBaseColumns, makeActionsColumn((row) => canDelete || row.userId === myUserId)],
    [canDelete, myUserId],
  );
  const table = useServerTable<ApiKeyWithCreator>({ name: 'org-api-keys', columns });

  const {
    data: apiKeys,
    isPending,
    isFetching,
  } = tsr.listApiKeys.useQuery({
    queryKey: ['api-keys', table.query],
    queryData: { query: table.query },
    placeholderData: keepPreviousData,
  });

  const keys = apiKeys?.status === 200 ? apiKeys.body.data : [];
  const meta = apiKeys?.status === 200 ? apiKeys.body.meta : undefined;

  return (
    <>
      <Alert>
        <Rocket className="h-4 w-4" />
        <AlertTitle>{BRAND_NAME} API v1 is here!</AlertTitle>
        <AlertDescription>
          We&apos;re excited to announce the release of our first stable API version. The API base URL has moved to{' '}
          <code className="bg-muted rounded px-1 py-0.5 text-sm font-semibold">/api/v1</code>. Please update your
          integrations accordingly. Full documentation is available at{' '}
          <a
            href="/api/redoc"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
          >
            /api/redoc
            <ExternalLink className="h-3 w-3" />
          </a>
          .
        </AlertDescription>
      </Alert>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>API Keys</CardTitle>
              <CardDescription>Manage API keys for programmatic access to your organization.</CardDescription>
            </div>
            {canCreate && (
              <Button asChild>
                <Link to="/organizations/api-keys/create">
                  <Plus className="mr-2 h-4 w-4" />
                  Create Key
                </Link>
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <BootScreen />
          ) : !isFetching && meta && meta.totalItems === 0 && !table.search ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Key className="text-muted-foreground mb-4 h-12 w-12" />
              <h3 className="text-lg font-medium">No API Keys</h3>
              <p className="text-muted-foreground mt-1 max-w-sm text-sm">
                Create an API key to access your organization&apos;s resources programmatically.
              </p>
              {canCreate && (
                <Button asChild className="mt-4">
                  <Link to="/organizations/api-keys/create">
                    <Plus className="mr-2 h-4 w-4" />
                    Create Your First Key
                  </Link>
                </Button>
              )}
            </div>
          ) : (
            <ServerDataTable
              table={table}
              data={keys}
              meta={meta}
              isPending={isPending}
              isFetching={isFetching && !isPending}
              searchPlaceholder="Search keys..."
              searchLabel="Search API keys"
              emptyMessage="No API keys found"
              onRowClick={(row) =>
                navigate({ to: '/organizations/api-keys/details/$apiKeyId', params: { apiKeyId: row.id } })
              }
            />
          )}
        </CardContent>
      </Card>
      <Outlet />
    </>
  );
}
