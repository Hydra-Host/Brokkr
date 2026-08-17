import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/components/alert-dialog';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/tags/$tagId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteTagRoute,
});

function DeleteTagRoute() {
  const { tagId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getTag.useQuery({
    queryKey: ['tag', tagId],
    queryData: { params: { id: tagId } },
  });

  const tag = data?.status === 200 ? data.body : null;

  useDocumentTitle(tag ? `Delete ${tag.name}` : 'Delete Tag');

  const { mutateAsync: deleteTag, isPending } = tsr.deleteTag.useMutation({
    meta: { successMessage: 'Tag deleted' },
  });

  const onClose = () => {
    navigate({ to: '/tags/$tagId', params: { tagId } });
  };

  const onDelete = async () => {
    await deleteTag({
      params: { id: tagId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['tags'] });
    navigate({ to: '/tags' });
  };

  if (isLoading) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <Skeleton className="h-24" />
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  if (!tag) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Tag not found</AlertDialogTitle>
            <AlertDialogDescription>The tag could not be found.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="sm:max-w-[425px]">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Tag: {tag.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{tag.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Tag'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
