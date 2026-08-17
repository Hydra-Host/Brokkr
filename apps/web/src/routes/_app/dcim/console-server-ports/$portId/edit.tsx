import { zodResolver } from '@hookform/resolvers/zod';
import { DcimConsolePortTypeSchema } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { tsr } from '~/lib/api';
import { enumOptions } from '~/lib/enum-options';

const editSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: DcimConsolePortTypeSchema.or(z.literal('')),
  speed: z.string(),
  description: z.string(),
});

type EditFormData = z.infer<typeof editSchema>;

export const Route = createFileRoute('/_app/dcim/console-server-ports/$portId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditConsoleServerPortPage,
});

function EditConsoleServerPortPage() {
  const { portId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getDcimConsoleServerPort.useQuery({
    queryKey: ['dcim-console-server-port', portId],
    queryData: { params: { id: portId } },
  });

  const updateMutation = tsr.updateDcimConsoleServerPort.useMutation({
    meta: { successMessage: 'Console server port updated' },
  });

  const port = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditFormData>({
    resolver: zodResolver(editSchema),
    defaultValues: { name: '', type: '', speed: '', description: '' },
  });

  useEffect(() => {
    if (port) {
      reset({
        name: port.name,
        type: port.type ?? '',
        speed: port.speed?.toString() ?? '',
        description: port.description ?? '',
      });
    }
  }, [port, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!port) return null;

  const onSubmit = async (formData: EditFormData) => {
    await updateMutation.mutateAsync({
      params: { id: portId },
      body: {
        name: formData.name,
        type: formData.type || undefined,
        speed: formData.speed ? parseInt(formData.speed, 10) : undefined,
        description: formData.description || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-console-server-ports'] });
    await queryClient.invalidateQueries({ queryKey: ['dcim-console-server-port', portId] });
    navigate({ to: '/dcim/console-server-ports/$portId', params: { portId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Console Server Port</CardTitle>
        <CardDescription>Update details for {port.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="name" label="Name" />
          <FormSelect
            control={control}
            name="type"
            label="Type"
            options={enumOptions(DcimConsolePortTypeSchema, { USB_MINI: 'USB Mini' })}
            placeholder="Select type"
          />
          <FormInput control={control} name="speed" label="Speed" />
          <FormTextarea control={control} name="description" label="Description" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/dcim/console-server-ports/$portId', params: { portId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
