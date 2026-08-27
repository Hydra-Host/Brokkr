import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router';
import { AlertTriangle, Loader2 } from 'lucide-react';
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
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { unwrapErrorMessage } from '@repo/utils';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/organizations/api-keys/delete/$apiKeyId')({
  staticData: { breadcrumb: 'Delete API Key' },
  component: DeleteApiKeyPage,
});

function DeleteApiKeyPage() {
  useDocumentTitle('Delete API Key');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { apiKeyId } = useParams({ from: '/_app/organizations/api-keys/delete/$apiKeyId' });

  const [confirmName, setConfirmName] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const { data: apiKey, isPending: isLoadingKey } = tsr.getApiKey.useQuery({
    queryKey: ['api-key', apiKeyId],
    queryData: { params: { apiKeyId } },
  });

  const { mutateAsync: deleteApiKey, isPending: isDeleting } = tsr.deleteApiKey.useMutation();

  const keyName = apiKey?.status === 200 ? apiKey.body.name || 'Unnamed Key' : '';
  const canDelete = confirmName === keyName;

  function onClose() {
    navigate({ to: '/organizations/api-keys' });
  }

  const handleDelete = async () => {
    setError(undefined);

    try {
      const res = await deleteApiKey({
        params: { apiKeyId },
      });

      if (res.status === 204) {
        await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
        navigate({ to: '/organizations/api-keys' });
      } else {
        setError('Failed to delete API key');
      }
    } catch (err) {
      const message = unwrapErrorMessage(err, 'Failed to delete API key. Please try again.');
      setError(message);
    }
  };

  return (
    <AlertDialog open={true} onOpenChange={onClose}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="text-destructive h-5 w-5" />
            Delete API Key
          </AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. Any applications using this key will lose access immediately.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {isLoadingKey ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-4">
            <p className="text-sm">
              To confirm, type <span className="font-semibold">{keyName}</span> below:
            </p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmName">API Key Name</Label>
              <Input
                id="confirmName"
                placeholder={keyName}
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                autoFocus
              />
            </div>

            {error && <p className="text-destructive text-sm">{error}</p>}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={handleDelete} disabled={!canDelete || isDeleting || isLoadingKey}>
            {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Delete Key
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
