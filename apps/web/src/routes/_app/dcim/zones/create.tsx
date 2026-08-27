import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Control, FieldValues } from 'react-hook-form';
import { FormProvider, useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';

// Workaround: zodResolver with deeply nested schemas causes TS2719; widening to Control<FieldValues> avoids the recursive type unification failure.
type FormControl = Control<FieldValues>;

import type { ResolvedAddress } from '@hydrahost/plugin-sdk';
import { CreateZoneRequestSchema, ZoneAddressInputSchema, type ZoneRedisCredential } from '@repo/api-client';
import { ZoneRedisCredentialDialog } from '@repo/domain-ui/components/zone-redis-credential-dialog';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Separator } from '@repo/ui/components/separator';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormCountrySelect } from '@repo/ui/form/form-country-select';
import { FormInput } from '@repo/ui/form/form-input';
import { FormNumberInput } from '@repo/ui/form/form-number-input';
import { FormPhoneInput } from '@repo/ui/form/form-phone-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { FormTimezoneSelect } from '@repo/ui/form/form-timezone-select';
import { tsr } from '~/lib/api';
import { PluginSlot } from '~/plugin-host';

const ZONES_KEY = ['zones'] as const;

const formSchema = CreateZoneRequestSchema.extend({
  useSeperateShippingAddress: z.boolean().default(false),
  primaryAddress: ZoneAddressInputSchema,
  shippingAddress: ZoneAddressInputSchema.optional(),
});

type FormData = z.infer<typeof formSchema>;

export const Route = createFileRoute('/_app/dcim/zones/create')({
  staticData: {
    breadcrumb: 'Create',
  },
  component: CreateZonePage,
});

const CONTACT_TYPE_OPTIONS = [
  { label: 'Main', value: 'Main' },
  { label: 'Technical', value: 'Technical' },
];

function CreateZonePage() {
  const navigate = useNavigate();

  const queryClient = useQueryClient();

  const { mutateAsync: createZone, isPending } = tsr.createZone.useMutation({
    meta: { successMessage: 'Zone created' },
  });

  const [redisCredential, setRedisCredential] = useState<ZoneRedisCredential | null>(null);

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema) as never,
    defaultValues: {
      name: '',
      useSeperateShippingAddress: false,
      primaryAddress: {
        addressLineOne: '',
        addressLineTwo: '',
        city: '',
        stateOrProvince: '',
        postalCode: '',
        countryCode: '',
        latitude: undefined,
        longitude: undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      contacts: [
        {
          name: '',
          title: '',
          email: '',
          phone: '',
          contactType: 'Main' as const,
          isShippingContact: true,
        },
      ],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'contacts',
  });

  const control = form.control as unknown as FormControl;
  const useSeperateShippingAddress = form.watch('useSeperateShippingAddress');

  const applyResolved = (prefix: 'primaryAddress' | 'shippingAddress', a: ResolvedAddress) => {
    const opts = { shouldValidate: true, shouldDirty: true };
    if (a.addressLineOne !== undefined) form.setValue(`${prefix}.addressLineOne`, a.addressLineOne, opts);
    if (a.addressLineTwo !== undefined) form.setValue(`${prefix}.addressLineTwo`, a.addressLineTwo, opts);
    if (a.city !== undefined) form.setValue(`${prefix}.city`, a.city, opts);
    if (a.stateOrProvince !== undefined) form.setValue(`${prefix}.stateOrProvince`, a.stateOrProvince, opts);
    if (a.postalCode !== undefined) form.setValue(`${prefix}.postalCode`, a.postalCode, opts);
    if (a.countryCode !== undefined) form.setValue(`${prefix}.countryCode`, a.countryCode, opts);
    if (a.latitude !== undefined) form.setValue(`${prefix}.latitude`, a.latitude, opts);
    if (a.longitude !== undefined) form.setValue(`${prefix}.longitude`, a.longitude, opts);
    if (a.timezone !== undefined) form.setValue(`${prefix}.timezone`, a.timezone, opts);
  };

  const onSubmit = async (data: FormData) => {
    const res = await createZone({
      body: {
        name: data.name,
        primaryAddress: data.primaryAddress,
        shippingAddress: data.useSeperateShippingAddress ? data.shippingAddress : undefined,
        contacts: data.contacts,
      },
    });

    await queryClient.invalidateQueries({ queryKey: ZONES_KEY });

    if (res.status === 201 && res.body.redisCredential) {
      setRedisCredential(res.body.redisCredential);
      return;
    }
    navigate({ to: '/dcim/zones' });
  };

  return (
    <FormProvider {...form}>
      <ZoneRedisCredentialDialog
        credential={redisCredential}
        onClose={() => {
          setRedisCredential(null);
          navigate({ to: '/dcim/zones' });
        }}
      />
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
            <CardDescription>Basic information about your zone.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="name" label="Zone Name" placeholder="Zone A" autoFocus />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Location</CardTitle>
            <CardDescription>Primary and shipping address for the zone.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <h4 className="mb-4 text-sm font-medium">Primary Address</h4>
              <div className="space-y-4">
                <PluginSlot name="address-autocomplete" onResolved={(a) => applyResolved('primaryAddress', a)} />
                <FormInput
                  control={control}
                  name="primaryAddress.addressLineOne"
                  label="Address Line 1"
                  placeholder="123 Main St"
                />
                <FormInput
                  control={control}
                  name="primaryAddress.addressLineTwo"
                  label="Address Line 2"
                  placeholder="Suite, unit, floor, etc."
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormInput control={control} name="primaryAddress.city" label="City" placeholder="San Francisco" />
                  <FormInput
                    control={control}
                    name="primaryAddress.stateOrProvince"
                    label="State / Province"
                    placeholder="CA"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormInput
                    control={control}
                    name="primaryAddress.postalCode"
                    label="ZIP / Postal Code"
                    placeholder="94102"
                  />
                  <FormCountrySelect control={control} name="primaryAddress.countryCode" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormNumberInput
                    control={control}
                    name="primaryAddress.latitude"
                    label="Latitude"
                    placeholder="37.7749"
                    step="any"
                  />
                  <FormNumberInput
                    control={control}
                    name="primaryAddress.longitude"
                    label="Longitude"
                    placeholder="-122.4194"
                    step="any"
                  />
                </div>
                <FormTimezoneSelect control={control} name="primaryAddress.timezone" />
              </div>
            </div>

            <Separator />

            <FormCheckbox
              control={control}
              name="useSeperateShippingAddress"
              label="Use a different shipping address"
            />

            {useSeperateShippingAddress && (
              <div>
                <h4 className="mb-4 text-sm font-medium">Shipping Address</h4>
                <div className="space-y-4">
                  <PluginSlot name="address-autocomplete" onResolved={(a) => applyResolved('shippingAddress', a)} />
                  <FormInput
                    control={control}
                    name="shippingAddress.addressLineOne"
                    label="Address Line 1"
                    placeholder="123 Main St"
                  />
                  <FormInput
                    control={control}
                    name="shippingAddress.addressLineTwo"
                    label="Address Line 2"
                    placeholder="Suite, unit, floor, etc."
                  />
                  <div className="grid grid-cols-2 gap-4">
                    <FormInput control={control} name="shippingAddress.city" label="City" />
                    <FormInput control={control} name="shippingAddress.stateOrProvince" label="State / Province" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <FormInput control={control} name="shippingAddress.postalCode" label="ZIP / Postal Code" />
                    <FormCountrySelect control={control} name="shippingAddress.countryCode" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <FormNumberInput
                      control={control}
                      name="shippingAddress.latitude"
                      label="Latitude"
                      placeholder="37.7749"
                      step="any"
                    />
                    <FormNumberInput
                      control={control}
                      name="shippingAddress.longitude"
                      label="Longitude"
                      placeholder="-122.4194"
                      step="any"
                    />
                  </div>
                  <FormTimezoneSelect control={control} name="shippingAddress.timezone" />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div className="space-y-1">
              <CardTitle>Contacts</CardTitle>
              <CardDescription>
                At least one contact is required. One contact must be designated for shipping.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                append({
                  name: '',
                  title: '',
                  email: '',
                  phone: '',
                  contactType: 'Technical',
                  isShippingContact: false,
                })
              }
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Contact
            </Button>
          </CardHeader>
          <CardContent className="space-y-6">
            {fields.map((field, index) => (
              <div key={field.id} className="space-y-4 rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium">Contact {index + 1}</h4>
                  {fields.length > 1 && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => remove(index)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormInput
                    control={control}
                    name={`contacts.${index}.name`}
                    label="Full Name"
                    placeholder="John Doe"
                  />
                  <FormInput
                    control={control}
                    name={`contacts.${index}.title`}
                    label="Title"
                    placeholder="Site Manager"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormInput
                    control={control}
                    name={`contacts.${index}.email`}
                    label="Email"
                    type="email"
                    placeholder="john@example.com"
                  />
                  <FormPhoneInput
                    control={control}
                    name={`contacts.${index}.phone`}
                    label="Phone"
                    defaultCountry="US"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormSelect
                    control={control}
                    name={`contacts.${index}.contactType`}
                    label="Contact Type"
                    options={CONTACT_TYPE_OPTIONS}
                  />
                  <div className="flex items-end pb-2">
                    <FormCheckbox
                      control={control}
                      name={`contacts.${index}.isShippingContact`}
                      label="Shipping contact"
                      description="Receives shipping-related communications"
                    />
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-4">
          <Button type="button" variant="outline" asChild>
            <Link to="/dcim/zones">Cancel</Link>
          </Button>
          <FormSubmitButton pending={isPending}>Create Zone</FormSubmitButton>
        </div>
      </form>
    </FormProvider>
  );
}
