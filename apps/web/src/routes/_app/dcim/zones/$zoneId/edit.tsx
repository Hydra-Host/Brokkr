import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';

import type { UpdateZoneName } from '@repo/api-client';
import { UpdateZoneNameSchema } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/zones/$zoneId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditZoneRoute,
});

function EditZoneRoute() {
  const params = Route.useParams();
  const { data: zoneData, isPending: isLoading } = tsr.getZoneById.useQuery({
    queryKey: ['zone', params.zoneId],
    queryData: { params: { zoneId: params.zoneId } },
  });
  const zone = zoneData?.status === 200 ? zoneData.body : null;
  const navigate = useNavigate();

  const queryClient = useQueryClient();

  useDocumentTitle(`Edit ${zone?.name ?? 'Zone'}`);

  const { mutateAsync: updateName, isPending } = tsr.updateZoneName.useMutation({
    meta: { successMessage: 'Zone updated' },
  });

  const form = useForm<UpdateZoneName>({
    resolver: zodResolver(UpdateZoneNameSchema),
    defaultValues: {
      name: zone?.name ?? '',
    },
  });

  const onClose = () => {
    navigate({
      to: '/dcim/zones/$zoneId',
      params: { zoneId: params.zoneId },
    });
  };

  const onSubmit = async (data: UpdateZoneName) => {
    await updateName({
      params: { zoneId: params.zoneId },
      body: { name: data.name },
    });

    await queryClient.invalidateQueries({ queryKey: ['zones'] });
    await queryClient.invalidateQueries({ queryKey: ['zone', params.zoneId] });
    navigate({
      to: '/dcim/zones/$zoneId',
      params: { zoneId: params.zoneId },
    });
  };

  if (isLoading) {
    return (
      <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[500px]">
          <Skeleton className="h-32" />
        </DialogContent>
      </Dialog>
    );
  }

  if (!zone) {
    return (
      <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Zone not found</DialogTitle>
            <DialogDescription>The zone could not be found.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>Edit Zone</DialogTitle>
            <DialogDescription>Update the details for {zone.name ?? 'this zone'}.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <FormInput
              control={form.control}
              name="name"
              label="Zone Name"
              placeholder="Enter the name of the zone"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <FormSubmitButton pending={isPending}>Save Changes</FormSubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
