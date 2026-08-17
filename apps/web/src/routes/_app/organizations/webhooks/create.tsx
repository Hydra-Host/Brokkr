import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Check, Copy, Loader2 } from 'lucide-react';
import { useState } from 'react';
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
import { FormInput } from '@repo/ui/form/form-input';
import { FormMultiSelect } from '@repo/ui/form/form-multi-select';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useCopyToClipboard } from '@repo/ui/hooks/use-copy-to-clipboard';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/organizations/webhooks/create')({
  staticData: { breadcrumb: 'Create Webhook' },
  component: CreateWebhookPage,
});

const WEBHOOK_EVENT_OPTIONS = [
  { value: 'DEVICE_LISTING_UPDATED', label: 'Device Listing Updated' },
  { value: 'DEVICE_LISTING_CREATED', label: 'Device Listing Created' },
  { value: 'DEVICE_LISTING_DECOMMISSIONED', label: 'Device Listing Decommissioned' },
  { value: 'DEPLOYMENT_INTERRUPTED', label: 'Deployment Interrupted' },
  { value: 'DEPLOYMENT_INTERRUPTION_COMPLETED', label: 'Deployment Interruption Completed' },
];

const createWebhookSchema = z.object({
  endpoint: z.string().url('Please enter a valid URL'),
  description: z.string().optional(),
  events: z.array(z.string()).min(1, 'Select at least one event'),
});

type CreateWebhookFormData = z.infer<typeof createWebhookSchema>;

function CreateWebhookPage() {
  useDocumentTitle('Create Webhook');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | undefined>(undefined);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [createdEndpoint, setCreatedEndpoint] = useState<string>('');
  const { copy, copied } = useCopyToClipboard();

  const form = useForm<CreateWebhookFormData>({
    resolver: zodResolver(createWebhookSchema),
    defaultValues: {
      endpoint: '',
      description: '',
      events: [],
    },
  });

  const { mutateAsync: createWebhook, isPending } = tsr.createWebhook.useMutation();

  function onClose() {
    navigate({ to: '/organizations/webhooks' });
  }

  const handleCopy = async () => {
    if (!createdSecret) return;
    await copy(createdSecret);
  };

  const onSubmit = async (data: CreateWebhookFormData) => {
    setError(undefined);

    try {
      const res = await createWebhook({
        body: {
          endpoint: data.endpoint,
          description: data.description || undefined,
          events: data.events as WebhookEventTypeEnum[],
          isActive: true,
        },
      });

      if (res.status === 201) {
        setCreatedSecret(res.body.secret);
        setCreatedEndpoint(res.body.endpoint);
        await queryClient.invalidateQueries({ queryKey: ['webhooks'] });
      } else {
        const body = res.body as { message?: string; error?: { message?: string } };
        setError(body?.message || body?.error?.message || 'Failed to create webhook');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create webhook. Please try again.';
      setError(message);
    }
  };

  if (createdSecret) {
    return (
      <Dialog open={true} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Webhook Created</DialogTitle>
            <DialogDescription>
              Your webhook has been created. Copy the signing secret now — you won&apos;t be able to see it again.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div>
              <p className="mb-1 text-sm font-medium">Endpoint</p>
              <code className="bg-muted block rounded-md p-2 text-sm break-all">{createdEndpoint}</code>
            </div>

            <div>
              <p className="mb-1 text-sm font-medium">Signing Secret</p>
              <div className="flex items-center gap-2">
                <code className="bg-muted flex-1 overflow-x-auto rounded-md p-3 text-sm break-all">
                  {createdSecret}
                </code>
                <Button variant="outline" size="icon" onClick={handleCopy} className="shrink-0">
                  {copied ? <Check className="text-status-online h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="bg-muted space-y-2 rounded-md p-3 text-sm">
              <p className="font-medium">Verifying webhook signatures</p>
              <p className="text-muted-foreground">
                Each webhook delivery includes an{' '}
                <code className="bg-background rounded px-1 text-xs">X-Webhook-Signature</code> header containing an
                HMAC-SHA256 signature of the payload, signed with this secret.
              </p>
              <p className="text-muted-foreground">
                Verify the signature by computing{' '}
                <code className="bg-background rounded px-1 text-xs">HMAC-SHA256(secret, JSON.stringify(payload))</code>{' '}
                and comparing it to the header value.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Webhook</DialogTitle>
          <DialogDescription>Create a new webhook endpoint to receive event notifications.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <div className="flex flex-col gap-4 py-4">
            <FormInput
              control={form.control}
              name="endpoint"
              label="Webhook URL"
              placeholder="https://example.com/webhooks"
              autoFocus
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

            {error && <p className="text-destructive text-sm">{error}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Webhook
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
