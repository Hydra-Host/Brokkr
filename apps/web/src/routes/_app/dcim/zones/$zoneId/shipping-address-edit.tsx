import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { z } from 'zod';

import type { ResolvedAddress } from '@hydrahost/plugin-sdk';
import type { Zone, ZoneAddressInput } from '@repo/api-client';
import { ZoneAddressInputSchema } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Checkbox } from '@repo/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormCountrySelect } from '@repo/ui/form/form-country-select';
import { FormInput } from '@repo/ui/form/form-input';
import { FormNumberInput } from '@repo/ui/form/form-number-input';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { FormTimezoneSelect } from '@repo/ui/form/form-timezone-select';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { tsr } from '~/lib/api';
import { PluginSlot } from '~/plugin-host';

const formSchema = z.object({
  address: ZoneAddressInputSchema,
});

type FormData = { address: ZoneAddressInput };

export const Route = createFileRoute('/_app/dcim/zones/$zoneId/shipping-address-edit')({
  staticData: { breadcrumb: 'Edit Shipping Address' },
  component: EditShippingAddressRoute,
});

function EditShippingAddressRoute() {
  const params = Route.useParams();
  const navigate = useNavigate();
  useDocumentTitle('Edit Shipping Address');

  const { data: zoneData, isPending: isLoading } = tsr.getZoneById.useQuery({
    queryKey: ['zone', params.zoneId],
    queryData: { params: { zoneId: params.zoneId } },
  });
  const zone = zoneData?.status === 200 ? zoneData.body : null;

  const onClose = () => {
    navigate({ to: '/dcim/zones/$zoneId', params: { zoneId: params.zoneId } });
  };

  if (isLoading) {
    return (
      <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[550px]">
          <Skeleton className="h-48" />
        </DialogContent>
      </Dialog>
    );
  }

  if (!zone) {
    return (
      <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[550px]">
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

  return <ShippingAddressForm zone={zone} zoneId={params.zoneId} onClose={onClose} />;
}

function ShippingAddressForm({ zone, zoneId, onClose }: { zone: Zone; zoneId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [updatePrimary, setUpdatePrimary] = useState(false);

  const { mutateAsync: updateShipping, isPending: isShippingPending } = tsr.updateZoneShippingAddress.useMutation({
    meta: { successMessage: 'Shipping address updated' },
  });
  const { mutateAsync: updatePrimaryAddress, isPending: isPrimaryPending } = tsr.updateZonePrimaryAddress.useMutation();
  const isPending = isShippingPending || isPrimaryPending;

  const a = zone.shippingAddress;
  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      address: {
        addressLineOne: a?.addressLineOne ?? '',
        addressLineTwo: a?.addressLineTwo ?? '',
        city: a?.city ?? '',
        stateOrProvince: a?.stateOrProvince ?? '',
        postalCode: a?.postalCode ?? '',
        countryCode: a?.countryCode ?? '',
        latitude: a?.latitude ?? undefined,
        longitude: a?.longitude ?? undefined,
        timezone: a?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    },
  });

  const applyResolved = (a: ResolvedAddress) => {
    const opts = { shouldValidate: true, shouldDirty: true };
    if (a.addressLineOne !== undefined) form.setValue('address.addressLineOne', a.addressLineOne, opts);
    if (a.addressLineTwo !== undefined) form.setValue('address.addressLineTwo', a.addressLineTwo, opts);
    if (a.city !== undefined) form.setValue('address.city', a.city, opts);
    if (a.stateOrProvince !== undefined) form.setValue('address.stateOrProvince', a.stateOrProvince, opts);
    if (a.postalCode !== undefined) form.setValue('address.postalCode', a.postalCode, opts);
    if (a.countryCode !== undefined) form.setValue('address.countryCode', a.countryCode, opts);
    if (a.latitude !== undefined) form.setValue('address.latitude', a.latitude, opts);
    if (a.longitude !== undefined) form.setValue('address.longitude', a.longitude, opts);
    if (a.timezone !== undefined) form.setValue('address.timezone', a.timezone, opts);
  };

  const onSubmit = async (data: FormData) => {
    await updateShipping({ params: { zoneId }, body: data.address });

    if (updatePrimary) {
      await updatePrimaryAddress({ params: { zoneId }, body: data.address });
    }

    await queryClient.invalidateQueries({ queryKey: ['zones'] });
    await queryClient.invalidateQueries({ queryKey: ['zone', zoneId] });
    navigate({ to: '/dcim/zones/$zoneId', params: { zoneId } });
  };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[550px]">
        <FormProvider {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <DialogHeader>
              <DialogTitle>Change Shipping Address</DialogTitle>
              <DialogDescription>Update the shipping address for {zone.name ?? 'this zone'}.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <PluginSlot name="address-autocomplete" onResolved={applyResolved} />
              <FormInput
                control={form.control}
                name="address.addressLineOne"
                label="Address Line 1"
                placeholder="123 Main St"
              />
              <FormInput
                control={form.control}
                name="address.addressLineTwo"
                label="Address Line 2"
                placeholder="Suite, unit, floor, etc."
              />
              <div className="grid grid-cols-2 gap-4">
                <FormInput control={form.control} name="address.city" label="City" placeholder="San Francisco" />
                <FormInput
                  control={form.control}
                  name="address.stateOrProvince"
                  label="State / Province"
                  placeholder="CA"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormInput
                  control={form.control}
                  name="address.postalCode"
                  label="ZIP / Postal Code"
                  placeholder="94102"
                />
                <FormCountrySelect control={form.control} name="address.countryCode" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormNumberInput
                  control={form.control}
                  name="address.latitude"
                  label="Latitude"
                  placeholder="37.7749"
                  step="any"
                />
                <FormNumberInput
                  control={form.control}
                  name="address.longitude"
                  label="Longitude"
                  placeholder="-122.4194"
                  step="any"
                />
              </div>
              <FormTimezoneSelect control={form.control} name="address.timezone" />
              <Checkbox
                id="update-primary"
                label="Make this my primary address too"
                checked={updatePrimary}
                onCheckedChange={(checked) => setUpdatePrimary(checked)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
                Cancel
              </Button>
              <FormSubmitButton pending={isPending}>Update Shipping Address</FormSubmitButton>
            </DialogFooter>
          </form>
        </FormProvider>
      </DialogContent>
    </Dialog>
  );
}
