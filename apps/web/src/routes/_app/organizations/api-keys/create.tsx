import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Check, Copy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@repo/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormInput } from '@repo/ui/form/form-input';
import { FormPermissionSelector } from '@repo/ui/form/form-permission-selector';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useCopyToClipboard } from '@repo/ui/hooks/use-copy-to-clipboard';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { usePermissions } from '~/hooks/use-permissions';
import { tsr } from '~/lib/api';

const createApiKeyFormSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(32, 'Name must be 32 characters or less'),
    expiresInDays: z.string(),
    restrictPermissions: z.boolean(),
    permissions: z.array(z.string()),
  })
  .refine(
    (data) => !data.expiresInDays || (/^[1-9]\d*$/.test(data.expiresInDays) && parseInt(data.expiresInDays, 10) <= 365),
    {
      message: 'Expiration must be between 1 and 365 whole days',
      path: ['expiresInDays'],
    },
  );
type CreateApiKeyFormValues = z.infer<typeof createApiKeyFormSchema>;

export const Route = createFileRoute('/_app/organizations/api-keys/create')({
  staticData: { breadcrumb: 'Create API Key' },
  component: CreateApiKeyPage,
});

function CreateApiKeyPage() {
  useDocumentTitle('Create API Key');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | undefined>(undefined);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const { copy, copied } = useCopyToClipboard();
  const form = useForm<CreateApiKeyFormValues>({
    resolver: zodResolver(createApiKeyFormSchema),
    defaultValues: {
      name: '',
      expiresInDays: '',
      restrictPermissions: false,
      permissions: [],
    },
  });
  const restrictPermissions = form.watch('restrictPermissions');

  const { can } = usePermissions();
  const {
    data: permissionsResponse,
    isError: isPermissionsError,
    isFetching: isPermissionsFetching,
  } = tsr.listPermissions.useQuery({ queryKey: ['permissions'] });

  const grantablePermissions = useMemo(() => {
    const all = permissionsResponse?.status === 200 ? permissionsResponse.body : [];
    return all.filter((p) => can(p.resource, p.action));
  }, [permissionsResponse, can]);
  const isPermissionCatalogAuthoritative =
    permissionsResponse?.status === 200 && !isPermissionsError && !isPermissionsFetching;

  const { mutateAsync: createApiKey, isPending } = tsr.createApiKey.useMutation();

  function onClose() {
    navigate({ to: '/organizations/api-keys' });
  }

  const handleCopy = async () => {
    if (!createdKey) return;
    await copy(createdKey);
  };

  const handleSubmit = async (values: CreateApiKeyFormValues) => {
    setError(undefined);

    try {
      const expiresInMilliseconds = values.expiresInDays
        ? parseInt(values.expiresInDays, 10) * 24 * 60 * 60 * 1000
        : undefined;

      const res = await createApiKey({
        body: {
          name: values.name,
          expiresIn: expiresInMilliseconds,
          // No explicit selection keeps the key tied to the owner's live permissions.
          permissions: values.restrictPermissions ? values.permissions : undefined,
        },
      });

      if (res.status === 201) {
        setCreatedKey(res.body.key);
        await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      } else {
        const body = res.body as { message?: string; error?: { message?: string } };
        setError(body?.message || body?.error?.message || 'Failed to create API key');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create API key. Please try again.';
      setError(message);
    }
  };

  if (createdKey) {
    return (
      <Dialog open={true} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>API Key Created</DialogTitle>
            <DialogDescription>
              Copy your API key now. You won&apos;t be able to see it again after closing this dialog.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="flex items-center gap-2">
              <code className="bg-muted flex-1 overflow-x-auto rounded-md p-3 text-sm break-all">{createdKey}</code>
              <Button variant="outline" size="icon" onClick={handleCopy} className="shrink-0">
                {copied ? <Check className="text-status-online h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-muted-foreground mt-3 text-sm">
              Use the <code className="bg-muted rounded px-1 text-xs">x-api-key</code> header to authenticate API
              requests.
            </p>
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
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Create API Key</DialogTitle>
          <DialogDescription>Create a new API key for programmatic access to your organization.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(handleSubmit)} className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-4">
            <FormInput
              control={form.control}
              name="name"
              label="Name"
              placeholder="e.g. Production API Key"
              maxLength={32}
              autoFocus
            />

            <FormInput
              control={form.control}
              name="expiresInDays"
              label="Expiration (days)"
              type="number"
              min={1}
              max={365}
              placeholder="Leave empty for no expiration"
              description="Optionally set the number of whole days before this key expires."
            />

            <div className="flex flex-col gap-2">
              <FormCheckbox
                control={form.control}
                name="restrictPermissions"
                label="Limit this key to specific permissions"
                description="By default the key inherits your live grantable permissions. Select permissions to restrict it; explicit restrictions automatically narrow when your access is reduced."
              />

              {restrictPermissions && (
                <FormPermissionSelector
                  control={form.control}
                  name="permissions"
                  label="Permissions"
                  permissions={grantablePermissions}
                  isPermissionCatalogAuthoritative={isPermissionCatalogAuthoritative}
                  emptyMessage="You have no permissions available to grant."
                />
              )}
            </div>

            {error && <p className="text-destructive text-sm">{error}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <FormSubmitButton pending={isPending}>Create Key</FormSubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
