import { zodResolver } from '@hookform/resolvers/zod';
import { DcimPowerPortTypeSchema } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
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
  type: DcimPowerPortTypeSchema.or(z.literal('')),
  maximumDraw: z.string(),
  allocatedDraw: z.string(),
  description: z.string(),
  deviceId: z.string().min(1, 'Device ID is required'),
});

type CreateFormData = z.infer<typeof createSchema>;

export const Route = createFileRoute('/_app/dcim/power-ports/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreatePowerPortPage,
});

function CreatePowerPortPage() {
  useDocumentTitle('Create Power Port');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: create, isPending } = tsr.createDcimPowerPort.useMutation({
    meta: { successMessage: 'Power port created' },
  });

  const { control, handleSubmit } = useForm<CreateFormData>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      name: '',
      type: '',
      maximumDraw: '',
      allocatedDraw: '',
      description: '',
      deviceId: '',
    },
  });

  const onSubmit = async (data: CreateFormData) => {
    await create({
      body: {
        name: data.name,
        type: data.type || undefined,
        maximumDraw: data.maximumDraw ? parseInt(data.maximumDraw, 10) : undefined,
        allocatedDraw: data.allocatedDraw ? parseInt(data.allocatedDraw, 10) : undefined,
        description: data.description || undefined,
        deviceId: data.deviceId,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-power-ports'] });
    navigate({ to: '/dcim/power-ports' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Power Port Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="name" label="Name" />
            <FormSelect
              control={control}
              name="type"
              label="Type"
              options={enumOptions(DcimPowerPortTypeSchema)}
              placeholder="Select type"
            />
            <FormInput control={control} name="maximumDraw" label="Maximum Draw" />
            <FormInput control={control} name="allocatedDraw" label="Allocated Draw" />
            <DeviceCombobox control={control} name="deviceId" />
            <FormTextarea control={control} name="description" label="Description" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Power Port'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/dcim/power-ports' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
