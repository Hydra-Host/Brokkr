import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import type { WebhookEventTypeEnum } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog';
import { Label } from '@repo/ui/components/label';
import { Skeleton } from '@repo/ui/components/skeleton';
import { Switch } from '@repo/ui/components/switch';
import { FormInput } from '@repo/ui/form/form-input';
import { FormMultiSelect } from '@repo/ui/form/form-multi-select';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { unwrapErrorMessage } from '@repo/utils';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/organizations/webhooks/edit/$webhookId')({
  staticData: { breadcrumb: 'Edit Webhook' },
  component: EditWebhookPage,
});

const WEBHOOK_EVENT_OPTIONS = [
  { value: 'DEVICE_LISTING_UPDATED', label: 'Device Listing Updated' },
  { value: 'DEVICE_LISTING_CREATED', label: 'Device Listing Created' },
  { value: 'DEVICE_LISTING_DECOMMISSIONED', label: 'Device Listing Decommissioned' },
  { value: 'DEPLOYMENT_INTERRUPTED', label: 'Deployment Interrupted' },
  { value: 'DEPLOYMENT_INTERRUPTION_COMPLETED', label: 'Deployment Interruption Completed' },
];

const editWebhookSchema = z.object({
  endpoint: z.string().url('Please enter a valid URL'),
  description: z.string().optional(),
  events: z.array(z.string()).min(1, 'Select at least one event'),
});

type EditWebhookFormData = z.infer<typeof editWebhookSchema>;

function EditWebhookPage() {
  useDocumentTitle('Edit Webhook');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { webhookId } = useParams({ from: '/_app/organizations/webhooks/edit/$webhookId' });

  const [error, setError] = useState<string | undefined>(undefined);
  const [isActive, setIsActive] = useState(true);

  const { data: webhookData, isPending: isLoadingWebhook } = tsr.getWebhook.useQuery({
    queryKey: ['webhook', webhookId],
    queryData: { params: { webhookId } },
  });

  const webhook = webhookData?.status === 200 ? webhookData.body : undefined;

  const form = useForm<EditWebhookFormData>({
    resolver: zodResolver(editWebhookSchema),
    defaultValues: {
      endpoint: '',
      description: '',
      events: [],
    },
  });

  useEffect(() => {
    if (webhook) {
      form.reset({
        endpoint: webhook.endpoint,
        description: webhook.description ?? '',
        events: webhook.events,
      });
      setIsActive(webhook.isActive);
    }
  }, [webhook, form]);

  const { mutateAsync: updateWebhook, isPending: isUpdating } = tsr.updateWebhook.useMutation();

  function onClose() {
    navigate({ to: '/organizations/webhooks' });
  }

  const onSubmit = async (data: EditWebhookFormData) => {
    setError(undefined);

    try {
      const res = await updateWebhook({
        params: { webhookId },
        body: {
          endpoint: data.endpoint,
          description: data.description || undefined,
          events: data.events as WebhookEventTypeEnum[],
          isActive,
        },
      });

      if (res.status === 200) {
        await queryClient.invalidateQueries({ queryKey: ['webhooks'] });
        await queryClient.invalidateQueries({ queryKey: ['webhook', webhookId] });
        navigate({ to: '/organizations/webhooks' });
      } else {
        setError(unwrapErrorMessage(res, 'Failed to update webhook'));
      }
    } catch (err) {
      const message = unwrapErrorMessage(err, 'Failed to update webhook. Please try again.');
      setError(message);
    }
  };

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Webhook</DialogTitle>
          <DialogDescription>Update your webhook endpoint configuration.</DialogDescription>
        </DialogHeader>

        {isLoadingWebhook ? (
          <div className="space-y-4 py-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <div className="flex flex-col gap-4 py-4">
              <FormInput
                control={form.control}
                name="endpoint"
                label="Webhook URL"
                placeholder="https://example.com/webhooks"
              />

              <FormTextarea
                control={form.control}
                name="description"
                label="Description"
                placeholder="Optional description for this webhook"
                rows={2}
              />

              <FormMultiSelect
                control={form.control}
                name="events"
                label="Events"
                options={WEBHOOK_EVENT_OPTIONS}
                placeholder="Select events to subscribe to..."
              />

              <div className="flex items-center justify-between">
                <Label htmlFor="isActive">Active</Label>
                <Switch id="isActive" checked={isActive} onCheckedChange={(checked) => setIsActive(!!checked)} />
              </div>

              {error && <p className="text-destructive text-sm">{error}</p>}
            </div>

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={isUpdating}>
                {isUpdating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
