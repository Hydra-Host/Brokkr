import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';

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

export const Route = createFileRoute('/_app/organizations/members/cancel-invitation/$invitationId')({
  staticData: { breadcrumb: 'Cancel Invitation' },
  component: CancelInvitationPage,
});

function CancelInvitationPage() {
  useDocumentTitle('Cancel Invitation');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { invitationId } = useParams({
    from: '/_app/organizations/members/cancel-invitation/$invitationId',
  });

  const [error, setError] = useState<string | undefined>(undefined);
  const { mutateAsync: cancelInvitation, isPending } = tsr.cancelInvitation.useMutation();

  function onClose() {
    navigate({ to: '/organizations/members' });
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isPending) return;
    setError(undefined);

    try {
      await cancelInvitation({
        params: { invitationId },
        body: {},
      });
      await queryClient.invalidateQueries({ queryKey: ['invitations'] });
      navigate({ to: '/organizations/members' });
    } catch {
      setError('Failed to cancel invitation. Please try again.');
    }
  };

  return (
    <AlertDialog
      open={true}
      onOpenChange={(open) => {
        if (!open && !isPending) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-2xl">Cancel Invitation</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to cancel this invitation? The invited user will no longer be able to join your
            organization using this invitation.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form onSubmit={handleSubmit}>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Keep Invitation</AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={isPending}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isPending ? 'Cancelling...' : 'Cancel Invitation'}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
