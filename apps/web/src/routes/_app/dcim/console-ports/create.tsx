import { zodResolver } from '@hookform/resolvers/zod';
import { DcimConsolePortTypeSchema } from '@repo/api-client';
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
  type: DcimConsolePortTypeSchema.or(z.literal('')),
  speed: z.string(),
  description: z.string(),
  deviceId: z.string().min(1, 'Device ID is required'),
});

type CreateFormData = z.infer<typeof createSchema>;

export const Route = createFileRoute('/_app/dcim/console-ports/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateConsolePortPage,
});

function CreateConsolePortPage() {
  useDocumentTitle('Create Console Port');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: create, isPending } = tsr.createDcimConsolePort.useMutation({
    meta: { successMessage: 'Console port created' },
  });

  const { control, handleSubmit } = useForm<CreateFormData>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      name: '',
      type: '',
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
        speed: data.speed ? parseInt(data.speed, 10) : undefined,
        description: data.description || undefined,
        deviceId: data.deviceId,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-console-ports'] });
    navigate({ to: '/dcim/console-ports' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Console Port Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="name" label="Name" />
            <FormSelect
              control={control}
              name="type"
              label="Type"
              options={enumOptions(DcimConsolePortTypeSchema, { USB_MINI: 'USB Mini' })}
              placeholder="Select type"
            />
            <FormInput control={control} name="speed" label="Speed" />
            <DeviceCombobox control={control} name="deviceId" />
            <FormTextarea control={control} name="description" label="Description" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Console Port'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/dcim/console-ports' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
