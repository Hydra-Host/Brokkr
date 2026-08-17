import type { Tag } from '@repo/api-client';

import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

const columns: ServerColumnDef<Tag>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    sortField: 'name',
    size: 200,
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        {row.original.color && (
          <span className="inline-block h-3 w-3 rounded-full border" style={{ backgroundColor: row.original.color }} />
        )}
        <span className="text-sm font-medium">{row.original.name}</span>
      </div>
    ),
  },
  {
    id: 'description',
    accessorKey: 'description',
    header: 'Description',
    cell: ({ row }) => (
      <span className="text-sm">{row.original.description || <span className="text-muted-foreground">--</span>}</span>
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

export const Route = createFileRoute('/_app/tags/')({
  staticData: { breadcrumb: 'Tags' },
  component: TagsPage,
});

function TagsPage() {
  useDocumentTitle('Tags');
  const navigate = useNavigate();
  const table = useServerTable<Tag>({ name: 'tags', columns });

  const tagsQuery = tsr.listTags.useQuery({
    queryKey: ['tags'],
    queryData: { query: {} },
  });

  const rows = tagsQuery.data?.status === 200 ? tagsQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Tags</CardTitle>
              <CardDescription>Manage tags for organizing resources.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/tags/create">Create Tag</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={tagsQuery.isPending}
            searchPlaceholder="Search tags..."
            searchLabel="Search tags"
            emptyMessage="No tags found"
            onRowClick={(row) => {
              void navigate({
                to: '/tags/$tagId',
                params: { tagId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
