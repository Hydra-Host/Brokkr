import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/tags/$tagId')({
  staticData: { breadcrumb: 'Tag Detail' },
  component: TagLayout,
});

function TagLayout() {
  const { tagId } = Route.useParams();

  const { data, isPending } = tsr.getTag.useQuery({
    queryKey: ['tag', tagId],
    queryData: { params: { id: tagId } },
  });

  useDocumentTitle(data?.status === 200 ? data.body.name : 'Tag Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Tag not found.</p>;
  }

  const tag = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {tag.color && (
            <span className="inline-block h-4 w-4 rounded-full border" style={{ backgroundColor: tag.color }} />
          )}
          <span className="text-lg font-medium">{tag.name}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/tags/$tagId/edit" params={{ tagId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/tags/$tagId/delete" params={{ tagId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
