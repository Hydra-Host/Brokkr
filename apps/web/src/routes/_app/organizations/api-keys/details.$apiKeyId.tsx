import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { isGrantableApiKeyPermission } from '@repo/auth/api-key-permissions';
import { useSession } from '@repo/auth/client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Separator } from '@repo/ui/components/separator';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@repo/ui/components/sheet';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormPermissionSelector } from '@repo/ui/form/form-permission-selector';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { formatShortDate } from '@repo/utils';
import { usePermissions } from '~/hooks/use-permissions';
import { tsr } from '~/lib/api';

const apiKeyPermissionsFormSchema = z.object({
  restrict: z.boolean(),
  permissions: z.array(z.string()),
});
type ApiKeyPermissionsFormValues = z.infer<typeof apiKeyPermissionsFormSchema>;

export const Route = createFileRoute('/_app/organizations/api-keys/details/$apiKeyId')({
  staticData: { breadcrumb: 'API Key' },
  component: ApiKeyDetailsSheet,
});

function ApiKeyDetailsSheet() {
  useDocumentTitle('API Key');
  const { apiKeyId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const { data: session } = useSession();
  const myUserId = session?.user?.id;

  const { data, isPending } = tsr.getApiKey.useQuery({
    queryKey: ['api-key', apiKeyId],
    queryData: { params: { apiKeyId } },
  });
  const key = data?.status === 200 ? data.body : null;

  const canEdit = can('api-key', 'update') || (!!key && key.userId === myUserId);

  const {
    data: permissionsResponse,
    isError: isPermissionsError,
    isFetching: isPermissionsFetching,
  } = tsr.listPermissions.useQuery({ queryKey: ['permissions'] });
  const { mutateAsync: updateApiKey, isPending: isSaving } = tsr.updateApiKey.useMutation();

  const form = useForm<ApiKeyPermissionsFormValues>({
    resolver: zodResolver(apiKeyPermissionsFormSchema),
    defaultValues: { restrict: false, permissions: [] },
  });
  const restrict = form.watch('restrict');
  const selectedValues = form.watch('permissions');
  const selected = useMemo(() => new Set(selectedValues), [selectedValues]);

  useEffect(() => {
    if (!key) return;
    form.reset({ restrict: key.permissions !== null, permissions: key.permissions ?? [] });
  }, [form, key]);

  const managesAnotherUserKey = !!key && key.userId !== myUserId && can('api-key', 'update');
  const grantablePermissions = useMemo(() => {
    const all = permissionsResponse?.status === 200 ? permissionsResponse.body : [];
    return all.filter((permission) =>
      managesAnotherUserKey
        ? isGrantableApiKeyPermission(`${permission.resource}:${permission.action}`)
        : can(permission.resource, permission.action),
    );
  }, [permissionsResponse, managesAnotherUserKey, can]);
  const isPermissionCatalogAuthoritative =
    permissionsResponse?.status === 200 && !isPermissionsError && !isPermissionsFetching;

  function close() {
    navigate({ to: '/organizations/api-keys' });
  }

  async function save(values: ApiKeyPermissionsFormValues) {
    const res = await updateApiKey({
      params: { apiKeyId },
      body: { permissions: values.restrict ? values.permissions : null },
    });
    if (res.status === 200) {
      toast.success('API key permissions updated');
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      await queryClient.invalidateQueries({ queryKey: ['api-key', apiKeyId] });
    } else {
      const body = res.body as { message?: string };
      toast.error(body?.message ?? 'Failed to update permissions');
    }
  }

  const dirty = key
    ? restrict !== (key.permissions !== null) || !setsEqual(selected, new Set(key.permissions ?? []))
    : false;

  return (
    <Sheet open={true} onOpenChange={(open) => !open && close()}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-lg">
        {isPending ? (
          <div className="space-y-4">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : key ? (
          <>
            <SheetHeader>
              <SheetTitle className="text-xl">{key.name || 'Unnamed Key'}</SheetTitle>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{key.start ? `${key.start}…` : '—'}</code>
                {key.expiresAt && new Date(key.expiresAt) < new Date() ? (
                  <Badge variant="destructive">Expired</Badge>
                ) : key.enabled ? (
                  <Badge variant="outline">Active</Badge>
                ) : (
                  <Badge variant="secondary">Disabled</Badge>
                )}
              </div>
            </SheetHeader>

            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <Field label="Created by" value={key.createdByName || key.createdByEmail} />
              <Field label="Created" value={formatShortDate(key.createdAt)} />
              <Field label="Expires" value={key.expiresAt ? formatShortDate(key.expiresAt) : 'Never'} />
              <Field label="Last used" value={key.lastRequest ? formatShortDate(key.lastRequest) : 'Never'} />
              <Field label="Requests" value={String(key.requestCount)} />
              <Field label="Remaining" value={key.remaining === null ? 'Unlimited' : String(key.remaining)} />
            </dl>

            <Separator className="my-4" />

            <div className="min-h-0 flex-1 overflow-y-auto">
              <h4 className="mb-1 text-sm font-medium">Permissions</h4>
              {canEdit ? (
                <>
                  <FormCheckbox
                    control={form.control}
                    name="restrict"
                    label="Limit to specific permissions"
                    description="Off or an empty selection inherits the owner’s live grantable permissions. An explicit selection restricts access and tracks owner access reductions."
                  />
                  {restrict && (
                    <FormPermissionSelector
                      control={form.control}
                      name="permissions"
                      label="Permissions"
                      permissions={grantablePermissions}
                      isPermissionCatalogAuthoritative={isPermissionCatalogAuthoritative}
                      emptyMessage="You have no permissions available to grant."
                    />
                  )}
                </>
              ) : (
                <ReadOnlyPermissions permissions={key.permissions} />
              )}
            </div>

            <SheetFooter className="mt-6 shrink-0 border-t pt-4">
              <Button variant="outline" onClick={close}>
                Close
              </Button>
              {canEdit && (
                <Button onClick={form.handleSubmit(save)} disabled={isSaving || !dirty}>
                  {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save
                </Button>
              )}
            </SheetFooter>
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground">API key not found.</p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}

function ReadOnlyPermissions({ permissions }: { permissions: string[] | null }) {
  if (permissions === null) {
    return (
      <p className="text-muted-foreground text-sm">
        Legacy unscoped key — inherits the owner’s current delegable permissions.
      </p>
    );
  }
  if (permissions.length === 0) {
    return <p className="text-muted-foreground text-sm">No permissions granted.</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {permissions.map((p) => (
        <Badge key={p} variant="secondary" className="font-mono text-xs">
          {p}
        </Badge>
      ))}
    </div>
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}
