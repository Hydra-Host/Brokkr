import { zodResolver } from '@hookform/resolvers/zod';
import { DcimRackStatusSchema } from '@repo/api-client';
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
  status: DcimRackStatusSchema,
  heightU: z.coerce.number().int().min(1, 'Height must be at least 1'),
  startingUnit: z.coerce.number().int().min(1, 'Starting unit must be at least 1'),
  serial: z.string(),
  assetTag: z.string(),
  description: z.string(),
});

type EditFormData = z.infer<typeof editSchema>;

export const Route = createFileRoute('/_app/dcim/racks/$rackId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditRackPage,
});

function EditRackPage() {
  const { rackId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getDcimRack.useQuery({
    queryKey: ['dcim-rack', rackId],
    queryData: { params: { id: rackId } },
  });

  const updateMutation = tsr.updateDcimRack.useMutation({
    meta: { successMessage: 'Rack updated' },
  });

  const rack = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditFormData>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      name: '',
      status: 'ACTIVE',
      heightU: 42,
      startingUnit: 1,
      serial: '',
      assetTag: '',
      description: '',
    },
  });

  useEffect(() => {
    if (rack) {
      reset({
        name: rack.name,
        status: rack.status,
        heightU: rack.heightU,
        startingUnit: rack.startingUnit,
        serial: rack.serial ?? '',
        assetTag: rack.assetTag ?? '',
        description: rack.description ?? '',
      });
    }
  }, [rack, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!rack) return null;

  const onSubmit = async (formData: EditFormData) => {
    await updateMutation.mutateAsync({
      params: { id: rackId },
      body: {
        ...formData,
        serial: formData.serial || undefined,
        assetTag: formData.assetTag || undefined,
        description: formData.description || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-racks'] });
    await queryClient.invalidateQueries({ queryKey: ['dcim-rack', rackId] });
    navigate({ to: '/dcim/racks/$rackId', params: { rackId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Rack</CardTitle>
        <CardDescription>Update details for {rack.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="name" label="Name" />
          <FormSelect control={control} name="status" label="Status" options={enumOptions(DcimRackStatusSchema)} />
          <FormInput control={control} name="heightU" label="Height (U)" />
          <FormInput control={control} name="startingUnit" label="Starting Unit" />
          <FormInput control={control} name="serial" label="Serial" />
          <FormInput control={control} name="assetTag" label="Asset Tag" />
          <FormTextarea control={control} name="description" label="Description" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/dcim/racks/$rackId', params: { rackId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
