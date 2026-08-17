import { zodResolver } from '@hookform/resolvers/zod';
import { DcimInterfaceTypeSchema } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { DeviceCombobox } from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';
import { enumOptions } from '~/lib/enum-options';

const createSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: DcimInterfaceTypeSchema.or(z.literal('')),
  enabled: z.boolean(),
  mtu: z.string(),
  macAddress: z.string(),
  speed: z.string(),
  description: z.string(),
  deviceId: z.string().min(1, 'Device ID is required'),
});

type CreateFormData = z.infer<typeof createSchema>;

export const Route = createFileRoute('/_app/dcim/interfaces/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateInterfacePage,
});

function CreateInterfacePage() {
  useDocumentTitle('Create Interface');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: create, isPending } = tsr.createDcimInterface.useMutation({
    meta: { successMessage: 'Interface created' },
  });

  const { control, handleSubmit } = useForm<CreateFormData>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      name: '',
      type: '',
      enabled: true,
      mtu: '',
      macAddress: '',
      speed: '',
      description: '',
      deviceId: '',
    },
  });

  const onSubmit = async (data: CreateFormData) => {
    await create({
      body: {
        name: data.name,
        type: data.type || undefined,
        enabled: data.enabled,
        mtu: data.mtu ? parseInt(data.mtu, 10) : undefined,
        macAddress: data.macAddress || undefined,
        speed: data.speed ? parseInt(data.speed, 10) : undefined,
        description: data.description || undefined,
        deviceId: data.deviceId,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-interfaces'] });
    navigate({ to: '/dcim/interfaces' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Interface Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="name" label="Name" />
            <FormSelect
              control={control}
              name="type"
              label="Type"
              options={enumOptions(DcimInterfaceTypeSchema, { BOND: 'Bond' })}
              placeholder="Select type"
            />
            <FormCheckbox control={control} name="enabled" label="Enabled" />
            <FormInput control={control} name="mtu" label="MTU" />
            <FormInput control={control} name="macAddress" label="MAC Address" />
            <FormInput control={control} name="speed" label="Speed" />
            <DeviceCombobox control={control} name="deviceId" />
            <FormTextarea control={control} name="description" label="Description" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Interface'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/dcim/interfaces' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
