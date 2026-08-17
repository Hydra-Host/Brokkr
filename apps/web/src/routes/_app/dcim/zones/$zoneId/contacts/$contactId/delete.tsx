import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';

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
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/zones/$zoneId/contacts/$contactId/delete')({
  staticData: { breadcrumb: 'Delete Contact' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['zone', params.zoneId, 'contact', params.contactId],
      queryFn: () =>
        tsr.getZoneContact.query({
          params: { zoneId: params.zoneId, contactId: params.contactId },
        }),
    });

    if (response.status !== 200) {
      throw new Error('Failed to load contact');
    }

    return response.body;
  },
  component: DeleteContactRoute,
});

function DeleteContactRoute() {
  const contact = Route.useLoaderData();
  const params = Route.useParams();
  const navigate = useNavigate();

  const queryClient = useQueryClient();

  useDocumentTitle(`Delete ${contact.name}`);

  const { mutateAsync: deleteContact, isPending } = tsr.deleteZoneContact.useMutation({
    meta: { successMessage: 'Contact deleted' },
  });

  const onClose = () => {
    navigate({
      to: '/dcim/zones/$zoneId',
      params: { zoneId: params.zoneId },
    });
  };

  const onDelete = async () => {
    await deleteContact({
      params: {
        zoneId: params.zoneId,
        contactId: params.contactId,
      },
    });

    await queryClient.invalidateQueries({ queryKey: ['zones'] });
    await queryClient.invalidateQueries({ queryKey: ['zone', params.zoneId, 'contacts'] });
    navigate({
      to: '/dcim/zones/$zoneId',
      params: { zoneId: params.zoneId },
    });
  };

  return (
    <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="sm:max-w-[425px]">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Contact: {contact.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{contact.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Contact'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
