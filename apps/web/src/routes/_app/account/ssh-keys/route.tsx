import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { ColumnDef } from '@tanstack/react-table';
import { Plus, Trash2 } from 'lucide-react';

import type { SshKey } from '@repo/api-client';
import { ServerPagination } from '@repo/domain-ui/components/server-pagination';
import { usePagination } from '@repo/domain-ui/hooks/use-pagination';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { DataTable, DataTableSortHeader } from '@repo/ui/components/data-table';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { keepPreviousData } from '@tanstack/react-query';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/account/ssh-keys')({
  staticData: { breadcrumb: 'SSH Keys' },
  component: SshKeysPage,
});

const columns: ColumnDef<SshKey>[] = [
  {
    accessorKey: 'name',
    header: ({ column }) => <DataTableSortHeader column={column} label="Name" />,
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
  },
  {
    accessorKey: 'dateCreated',
    header: ({ column }) => <DataTableSortHeader column={column} label="Date Created" />,
    cell: ({ row }) => (
      <span className="text-sm">
        {new Date(row.original.dateCreated).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })}
      </span>
    ),
  },
  {
    accessorKey: 'fingerprint',
    header: 'Fingerprint',
    cell: ({ row }) => <span className="text-muted-foreground font-mono text-sm">{row.original.fingerprint}</span>,
  },
  {
    id: 'actions',
    header: '',
    cell: ({ row }) => (
      <div className="flex justify-end">
        <Button size="sm" variant="destructive" asChild>
          <Link to="/account/ssh-keys/$sshKeyId/delete" params={{ sshKeyId: row.original.id }}>
            <Trash2 className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    ),
  },
];

function SshKeysPage() {
  useDocumentTitle('SSH Keys');
  const { page, setPage, pageSize, setPageSize } = usePagination({ defaultPageSize: 20 });

  const { data: response } = tsr.getSshKeys.useQuery({
    queryKey: ['ssh-keys', page, pageSize],
    queryData: { query: { page, pageSize } },
    placeholderData: keepPreviousData,
  });

  const sshKeys = response?.status === 200 ? response.body.data : [];
  const meta = response?.status === 200 ? response.body.meta : undefined;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>SSH Keys</CardTitle>
            <CardDescription>Setup and control access to your deployments with secure shell keys.</CardDescription>
          </div>
          <Button asChild>
            <Link to="/account/ssh-keys/create">
              <Plus className="mr-2 h-4 w-4" />
              Add Key
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {meta && (
            <ServerPagination meta={meta} onPageChange={setPage} pageSize={pageSize} onPageSizeChange={setPageSize} />
          )}
          <DataTable columns={columns} data={sshKeys} emptyMessage="No SSH keys yet. Add one to get started." />
        </CardContent>
      </Card>

      <Outlet />
    </div>
  );
}
