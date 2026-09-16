import type { CreateReservationInviteRequest, EditReservationInviteRequest } from '@repo/api-client';
import { useSession } from '@repo/auth/client';
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
import { Card, CardContent } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { calculateNoticePeriodMs, type NoticePeriodUnit } from '@repo/utils';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, useNavigate, useRouter } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { tsr } from '~/lib/api';
import { DcimInviteForm, type DcimInviteFormValues } from './-components/dcim-invite-form';

const parentRoute = getRouteApi('/_app/dcim/servers/$deviceId');

const invitesQueryKey = (deviceId: string) => ['device-reservation-invites', deviceId] as const;

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/invite')({
  staticData: { breadcrumb: 'Invite' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: invitesQueryKey(params.deviceId),
      queryFn: () =>
        tsr.getReservationInvitesByServer.query({
          params: { deviceId: params.deviceId },
        }),
    });

    const invites = response.status === 200 ? response.body.data : [];
    return { existingInvite: invites[0] ?? null };
  },
  component: ServerInvitePage,
});

function ServerBlockedMessage({ message }: { message: string }) {
  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardContent className="flex items-start gap-3 pt-6">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
        <p className="text-sm text-amber-700 dark:text-amber-400">{message}</p>
      </CardContent>
    </Card>
  );
}

function ServerInvitePage() {
  const device = parentRoute.useLoaderData();
  const { existingInvite } = Route.useLoaderData();
  const { data: session } = useSession();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = Route.useParams();

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const invite = existingInvite;
  const isListingActive = device.listing?.isActive ?? false;
  const isInventoryStatus = device.status?.value?.toLowerCase() === 'inventory';
  const isServerUnhealthy = device.isHealthy === false;
  const isEdit = !!invite;

  useDocumentTitle(isEdit ? 'Edit Invite' : 'Create Invite');

  const gpuCount = device.specs.gpu.count ?? 0;
  const isInterruptibleOnly = device.listing?.isInterruptibleOnly ?? false;

  const activeOrgId = (session?.session as { activeOrganizationId?: string } | undefined)?.activeOrganizationId ?? '';
  const inviterEmail = session?.user?.email ?? '';

  const createMutation = tsr.createReservationInvite.useMutation();
  const editMutation = tsr.editReservationInvite.useMutation();
  const deleteMutation = tsr.deleteReservationInvite.useMutation();

  const handleSubmit = async (data: DcimInviteFormValues) => {
    const noticePeriodMs =
      data.isInterruptible && data.interruptibleNoticePeriodValue
        ? calculateNoticePeriodMs(
            data.interruptibleNoticePeriodValue,
            (data.interruptibleNoticePeriodUnit as NoticePeriodUnit) || 'hours',
          )
        : null;

    if (isEdit && invite?.id) {
      const body: EditReservationInviteRequest = {
        price: data.price,
        billingFrequency: data.billingFrequency as EditReservationInviteRequest['billingFrequency'],
        dateExpires: new Date(data.dateExpires),
        deviceIds: [device.id],
        notes: data.notes,
        interruptibleNoticePeriod: noticePeriodMs,
      };
      await editMutation.mutateAsync({
        params: { inviteId: invite.id },
        body,
      });
    } else {
      const body: CreateReservationInviteRequest = {
        inviterEmail: inviterEmail,
        inviteeEmail: data.inviteeEmail,
        organizationId: activeOrgId,
        price: data.price,
        billingFrequency: data.billingFrequency as CreateReservationInviteRequest['billingFrequency'],
        dateExpires: new Date(data.dateExpires),
        deviceIds: [device.id],
        notes: data.notes,
        interruptibleNoticePeriod: noticePeriodMs,
      };
      await createMutation.mutateAsync({
        params: { deviceId: device.id },
        body,
      });
    }

    queryClient.removeQueries({ queryKey: ['server', params.deviceId] });
    queryClient.removeQueries({ queryKey: invitesQueryKey(params.deviceId) });
    await router.invalidate();
    void navigate({ to: '/dcim/servers/$deviceId', params: { deviceId: params.deviceId } });
  };

  const handleDelete = async () => {
    if (!invite?.id) return;
    await deleteMutation.mutateAsync({
      params: { inviteId: invite.id },
    });
    setShowDeleteDialog(false);
    queryClient.removeQueries({ queryKey: ['server', params.deviceId] });
    queryClient.removeQueries({ queryKey: invitesQueryKey(params.deviceId) });
    await router.invalidate();
    void navigate({ to: '/dcim/servers/$deviceId', params: { deviceId: params.deviceId } });
  };

  const handleCancel = () =>
    void navigate({
      to: '/dcim/servers/$deviceId',
      params: { deviceId: params.deviceId },
    });

  const isPending = createMutation.isPending || editMutation.isPending;
  const isError = createMutation.isError || editMutation.isError;

  if (!isInventoryStatus) {
    return (
      <div className="space-y-6">
        <PageHeader title="Invite" onBack={handleCancel} />
        <ServerBlockedMessage message='This server must be in "Inventory" status (available to rent) before creating a reservation invite.' />
      </div>
    );
  }

  if (isServerUnhealthy) {
    return (
      <div className="space-y-6">
        <PageHeader title="Invite" onBack={handleCancel} />
        <ServerBlockedMessage message="This server is currently unhealthy and cannot accept reservation invites. The server must pass health checks before it can be rented." />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader title={isEdit ? 'Edit Invite' : 'Create Invite'} onBack={handleCancel}>
            <p className="text-muted-foreground text-sm">
              {isEdit
                ? 'Modify the reservation invite for this device.'
                : 'Create a new reservation invite for a customer.'}
            </p>
          </PageHeader>

          {isEdit && invite?.id && (
            <Button variant="destructive" size="sm" onClick={() => setShowDeleteDialog(true)}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete Invite
            </Button>
          )}
        </div>

        {!isListingActive && (
          <ServerBlockedMessage message="This server is not listed on the public marketplace. Creating this invite will not list it — only the invitee can provision." />
        )}

        <DcimInviteForm
          mode={isEdit ? 'edit' : 'create'}
          invite={
            invite
              ? {
                  id: invite.id,
                  inviteeEmail: invite.inviteeEmail,
                  billingFrequency: invite.billingFrequency,
                  price: invite.price,
                  interruptibleNoticePeriod: invite.interruptibleNoticePeriod,
                  dateExpires: invite.dateExpires,
                  notes: invite.notes,
                }
              : undefined
          }
          gpuCount={gpuCount}
          isInterruptibleOnly={isInterruptibleOnly}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          isPending={isPending}
          isError={isError}
        />
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Invite</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this reservation invite? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {deleteMutation.isPending ? 'Deleting...' : 'Delete Invite'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function PageHeader({ title, onBack, children }: { title: string; onBack: () => void; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <Button variant="ghost" size="icon" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  );
}
