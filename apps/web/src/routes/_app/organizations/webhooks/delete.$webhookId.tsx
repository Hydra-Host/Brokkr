import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

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
import { FormInput } from '@repo/ui/form/form-input';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { unwrapErrorMessage } from '@repo/utils';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/organizations/webhooks/delete/$webhookId')({
  staticData: { breadcrumb: 'Delete Webhook' },
  component: DeleteWebhookPage,
});

function DeleteWebhookPage() {
  useDocumentTitle('Delete Webhook');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { webhookId } = useParams({ from: '/_app/organizations/webhooks/delete/$webhookId' });

  const [error, setError] = useState<string | undefined>(undefined);

  const { data: webhookData, isPending: isLoadingWebhook } = tsr.getWebhook.useQuery({
    queryKey: ['webhook', webhookId],
    queryData: { params: { webhookId } },
  });

  const { mutateAsync: deleteWebhook, isPending: isDeleting } = tsr.deleteWebhook.useMutation();

  const webhookEndpoint = webhookData?.status === 200 ? webhookData.body.endpoint : '';

  const deleteWebhookSchema = z.object({
    confirmEndpoint: z.string().refine((val) => val === webhookEndpoint, {
      message: 'Endpoint does not match',
    }),
  });

  type DeleteWebhookFormData = z.infer<typeof deleteWebhookSchema>;

  const form = useForm<DeleteWebhookFormData>({
    resolver: zodResolver(deleteWebhookSchema),
    defaultValues: { confirmEndpoint: '' },
  });

  function onClose() {
    navigate({ to: '/organizations/webhooks' });
  }

  const onSubmit = async () => {
    setError(undefined);

    try {
      const res = await deleteWebhook({
        params: { webhookId },
        body: {},
      });

      if (res.status === 204) {
        await queryClient.invalidateQueries({ queryKey: ['webhooks'] });
        navigate({ to: '/organizations/webhooks' });
      } else {
        setError('Failed to delete webhook');
      }
    } catch (err) {
      const message = unwrapErrorMessage(err, 'Failed to delete webhook. Please try again.');
      setError(message);
    }
  };

  const confirmValue = form.watch('confirmEndpoint');
  const canDelete = confirmValue === webhookEndpoint;

  return (
    <AlertDialog open={true} onOpenChange={onClose}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="text-destructive h-5 w-5" />
            Delete Webhook
          </AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. All pending deliveries for this webhook will also be removed.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {isLoadingWebhook ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <div className="flex flex-col gap-4 py-4">
              <p className="text-sm">To confirm, type the webhook endpoint below:</p>
              <code className="bg-muted rounded-md p-2 text-sm break-all">{webhookEndpoint}</code>

              <FormInput
                control={form.control}
                name="confirmEndpoint"
                label="Webhook Endpoint"
                placeholder={webhookEndpoint}
                autoFocus
              />

              {error && <p className="text-destructive text-sm">{error}</p>}
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button type="submit" variant="destructive" disabled={!canDelete || isDeleting || isLoadingWebhook}>
                {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Delete Webhook
              </Button>
            </AlertDialogFooter>
          </form>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
