import { zodResolver } from '@hookform/resolvers/zod';
import { DcimPortTypeSchema } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { DeviceCombobox, RearPortCombobox } from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';
import { enumOptions } from '~/lib/enum-options';

const createSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: DcimPortTypeSchema,
  rearPortPosition: z.coerce.number().int().min(1, 'Rear port position is required'),
  description: z.string(),
  deviceId: z.string().min(1, 'Device ID is required'),
  rearPortId: z.string().min(1, 'Rear port ID is required'),
});

type CreateFormData = z.infer<typeof createSchema>;

export const Route = createFileRoute('/_app/dcim/front-ports/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateFrontPortPage,
});

function CreateFrontPortPage() {
  useDocumentTitle('Create Front Port');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: create, isPending } = tsr.createDcimFrontPort.useMutation({
    meta: { successMessage: 'Front port created' },
  });

  const { control, handleSubmit, resetField } = useForm<CreateFormData>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      name: '',
      type: 'OTHER',
      rearPortPosition: 1,
      description: '',
      deviceId: '',
      rearPortId: '',
    },
  });

  const watchedDeviceId = useWatch({ control, name: 'deviceId' });

  useEffect(() => {
    resetField('rearPortId', { defaultValue: '' });
  }, [watchedDeviceId, resetField]);

  const onSubmit = async (data: CreateFormData) => {
    await create({
      body: {
        name: data.name,
        type: data.type,
        rearPortPosition: data.rearPortPosition,
        description: data.description || undefined,
        deviceId: data.deviceId,
        rearPortId: data.rearPortId,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-front-ports'] });
    navigate({ to: '/dcim/front-ports' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Front Port Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="name" label="Name" />
            <FormSelect
              control={control}
              name="type"
              label="Type"
              options={enumOptions(DcimPortTypeSchema)}
              placeholder="Select type"
            />
            <FormInput control={control} name="rearPortPosition" label="Rear Port Position" />
            <DeviceCombobox control={control} name="deviceId" />
            <RearPortCombobox control={control} name="rearPortId" deviceId={watchedDeviceId} />
            <FormTextarea control={control} name="description" label="Description" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Front Port'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/dcim/front-ports' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
