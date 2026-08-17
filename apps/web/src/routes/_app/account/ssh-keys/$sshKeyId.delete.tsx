import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Loader2, Trash2 } from 'lucide-react';
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
import { Input } from '@repo/ui/components/input';
import { Label } from '@repo/ui/components/label';
import { tsr } from '~/lib/api';

const SSH_KEYS_KEY = ['ssh-keys'] as const;

export const Route = createFileRoute('/_app/account/ssh-keys/$sshKeyId/delete')({
  staticData: { breadcrumb: 'Delete' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['ssh-key', params.sshKeyId],
      queryFn: () => tsr.getSshKey.query({ params: { id: params.sshKeyId } }),
    });

    if (response.status !== 200) {
      throw new Error('Failed to load SSH key');
    }

    return response.body;
  },
  component: DeleteSshKeyDialog,
});

function DeleteSshKeyDialog() {
  const sshKey = Route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { mutateAsync: deleteSshKey, isPending } = tsr.deleteSshKey.useMutation({
    meta: { successMessage: `SSH key "${sshKey.name}" deleted` },
  });
  const [confirmation, setConfirmation] = useState('');

  const isConfirmed = confirmation === sshKey.name;

  const onClose = () => {
    navigate({ to: '/account/ssh-keys' });
  };

  const handleDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConfirmed) return;

    await deleteSshKey({ params: { id: sshKey.id } });

    queryClient.removeQueries({ queryKey: SSH_KEYS_KEY });
    queryClient.removeQueries({ queryKey: ['ssh-key', sshKey.id] });
    await router.invalidate();
    navigate({ to: '/account/ssh-keys' });
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <form onSubmit={handleDelete}>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive flex items-center gap-2">
              <Trash2 className="h-5 w-5" />
              Delete SSH Key
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the SSH key{' '}
              <strong className="text-foreground">{sshKey.name}</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 py-4">
            <Label htmlFor="confirm-name">
              Type <strong>{sshKey.name}</strong> to confirm
            </Label>
            <Input
              id="confirm-name"
              placeholder={sshKey.name}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoFocus
              className="mt-2"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={isPending || !isConfirmed}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete SSH Key
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
