import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

import { ServerPriceForm, type ServerPriceFormSubmitData } from '@repo/domain-ui/form/server-price-form';
import { Button } from '@repo/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog';
import { navigatePreservingSearch } from '@repo/ui/utils';
import { tsr } from '~/lib/api';

const searchSchema = z.object({
  deviceIds: z.string().array().catch([]),
});

export const Route = createFileRoute('/_app/dcim/servers/_active/update-monetization')({
  validateSearch: searchSchema,
  component: UpdateMonetizationPage,
});

function UpdateMonetizationPage() {
  const { deviceIds } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { mutateAsync: updateListing } = tsr.updateServerListing.useMutation();

  const deviceQueries = tsr.getServerById.useQueries({
    queries: deviceIds.map((deviceId) => ({
      queryKey: ['server', deviceId],
      queryData: { params: { deviceId } },
    })),
  });

  const closeDialog = () => {
    navigatePreservingSearch(navigate, {
      to: '/dcim/servers',
      search: (prev) => {
        const { deviceIds, ...rest } = prev;
        void deviceIds;
        return rest;
      },
    });
  };

  if (deviceIds.length === 0) {
    closeDialog();
    return null;
  }

  const isLoading = deviceQueries.some((q) => q.isPending);
  const hasError = deviceQueries.some((q) => q.isError);
  const devices = deviceQueries.map((q) => (q.data?.status === 200 ? q.data.body : null)).filter((d) => d != null);

  if (isLoading) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Update Monetization</DialogTitle>
            <DialogDescription>Loading server data...</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  if (hasError || devices.length !== deviceIds.length) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Update Monetization</DialogTitle>
            <DialogDescription>Failed to load one or more servers.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const handleSubmit = async (data: ServerPriceFormSubmitData) => {
    setIsSubmitting(true);

    const loadedDeviceIds = devices.map((d) => d.id);
    const results = await Promise.allSettled(
      loadedDeviceIds.map((deviceId) => updateListing({ params: { deviceId }, body: data })),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    if (failed === 0) {
      toast.success(`Updated monetization for ${succeeded} server${succeeded !== 1 ? 's' : ''}`);
    } else {
      toast.warning(`${succeeded} succeeded, ${failed} failed`);
    }

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['servers-active'] }),
      ...loadedDeviceIds.map((id) => queryClient.invalidateQueries({ queryKey: ['server', id] })),
    ]);
    setIsSubmitting(false);
    closeDialog();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeDialog();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Update Monetization</DialogTitle>
          <DialogDescription>
            Apply pricing and listing settings to {devices.length} selected device
            {devices.length !== 1 ? 's' : ''}.
          </DialogDescription>
        </DialogHeader>

        <ServerPriceForm
          key={deviceIds.join(',')}
          devices={devices}
          onSubmit={handleSubmit}
          isPending={isSubmitting}
          onCancel={closeDialog}
        />
      </DialogContent>
    </Dialog>
  );
}
