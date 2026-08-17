import { zodResolver } from '@hookform/resolvers/zod';
import { DcimInterfaceTypeSchema } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
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
  type: DcimInterfaceTypeSchema.or(z.literal('')),
  enabled: z.boolean(),
  mtu: z.string(),
  macAddress: z.string(),
  speed: z.string(),
  description: z.string(),
});

type EditFormData = z.infer<typeof editSchema>;

export const Route = createFileRoute('/_app/dcim/interfaces/$interfaceId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditInterfacePage,
});

function EditInterfacePage() {
  const { interfaceId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getDcimInterface.useQuery({
    queryKey: ['dcim-interface', interfaceId],
    queryData: { params: { id: interfaceId } },
  });

  const updateMutation = tsr.updateDcimInterface.useMutation({
    meta: { successMessage: 'Interface updated' },
  });

  const iface = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditFormData>({
    resolver: zodResolver(editSchema),
    defaultValues: { name: '', type: '', enabled: true, mtu: '', macAddress: '', speed: '', description: '' },
  });

  useEffect(() => {
    if (iface) {
      reset({
        name: iface.name,
        type: iface.type ?? '',
        enabled: iface.enabled,
        mtu: iface.mtu?.toString() ?? '',
        macAddress: iface.macAddress ?? '',
        speed: iface.speed?.toString() ?? '',
        description: iface.description ?? '',
      });
    }
  }, [iface, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!iface) return null;

  const onSubmit = async (formData: EditFormData) => {
    await updateMutation.mutateAsync({
      params: { id: interfaceId },
      body: {
        name: formData.name,
        type: formData.type || undefined,
        enabled: formData.enabled,
        mtu: formData.mtu ? parseInt(formData.mtu, 10) : undefined,
        macAddress: formData.macAddress || undefined,
        speed: formData.speed ? parseInt(formData.speed, 10) : undefined,
        description: formData.description || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-interfaces'] });
    await queryClient.invalidateQueries({ queryKey: ['dcim-interface', interfaceId] });
    navigate({ to: '/dcim/interfaces/$interfaceId', params: { interfaceId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Interface</CardTitle>
        <CardDescription>Update details for {iface.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
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
          <FormTextarea control={control} name="description" label="Description" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/dcim/interfaces/$interfaceId', params: { interfaceId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
