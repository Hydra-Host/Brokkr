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

export const Route = createFileRoute('/_app/organizations/members/remove/$membershipId')({
  staticData: { breadcrumb: 'Remove Member' },
  component: RemoveMemberPage,
});

function RemoveMemberPage() {
  useDocumentTitle('Remove Member');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { membershipId } = useParams({
    from: '/_app/organizations/members/remove/$membershipId',
  });

  const [error, setError] = useState<string | undefined>(undefined);
  const { mutateAsync: removeMember, isPending } = tsr.deleteOrganizationMembership.useMutation();

  function onClose() {
    navigate({ to: '/organizations/members' });
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(undefined);

    try {
      await removeMember({
        params: { membershipId },
      });
      await queryClient.invalidateQueries({ queryKey: ['memberships'] });
      navigate({ to: '/organizations/members' });
    } catch {
      setError('Failed to remove member. Please try again.');
    }
  };

  return (
    <AlertDialog open={true} onOpenChange={onClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-2xl">Remove Member</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to remove this member from your organization? They will lose access to all
            organization resources immediately.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form onSubmit={handleSubmit}>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={isPending}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Remove Member
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
