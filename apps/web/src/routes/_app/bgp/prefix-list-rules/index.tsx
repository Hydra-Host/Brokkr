import type { PrefixListRule } from '@repo/api-client';

import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

const columns: ServerColumnDef<PrefixListRule>[] = [
  {
    id: 'sequence',
    accessorKey: 'sequence',
    header: 'Sequence',
    sortField: 'sequence',
    size: 100,
    cell: ({ row }) => <span className="text-sm font-medium">{row.original.sequence}</span>,
  },
  {
    id: 'action',
    accessorKey: 'action',
    header: 'Action',
    size: 100,
    cell: ({ row }) => <span className="text-sm">{row.original.action}</span>,
  },
  {
    id: 'prefix',
    accessorKey: 'prefix',
    header: 'Prefix',
    cell: ({ row }) => (
      <span className="text-sm">{row.original.prefix || <span className="text-muted-foreground">--</span>}</span>
    ),
  },
  {
    id: 'ge',
    accessorKey: 'ge',
    header: 'GE',
    size: 80,
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.ge != null ? row.original.ge : <span className="text-muted-foreground">--</span>}
      </span>
    ),
  },
  {
    id: 'le',
    accessorKey: 'le',
    header: 'LE',
    size: 80,
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.le != null ? row.original.le : <span className="text-muted-foreground">--</span>}
      </span>
    ),
  },
  {
    id: 'createdAt',
    header: 'Created',
    sortField: 'createdAt',
    breakpoint: 'desktop',
    size: 110,
    cell: ({ row }) => (
      <span className="text-muted-foreground text-sm">{new Date(row.original.createdAt).toLocaleDateString()}</span>
    ),
  },
];

export const Route = createFileRoute('/_app/bgp/prefix-list-rules/')({
  component: PrefixListRulesPage,
});

function PrefixListRulesPage() {
  useDocumentTitle('Prefix List Rules');
  const navigate = useNavigate();
  const table = useServerTable<PrefixListRule>({ name: 'prefix-list-rules', columns });

  const rulesQuery = tsr.listPrefixListRules.useQuery({
    queryKey: ['prefix-list-rules'],
    queryData: { query: {} },
  });

  const rows = rulesQuery.data?.status === 200 ? rulesQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Prefix List Rules</CardTitle>
              <CardDescription>Manage BGP prefix list rules.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/bgp/prefix-list-rules/create">Create Rule</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={rulesQuery.isPending}
            searchPlaceholder="Search prefix list rules..."
            searchLabel="Search prefix list rules"
            emptyMessage="No prefix list rules found"
            onRowClick={(row) => {
              void navigate({
                to: '/bgp/prefix-list-rules/$ruleId',
                params: { ruleId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
