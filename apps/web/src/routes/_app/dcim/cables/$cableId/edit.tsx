import { zodResolver } from '@hookform/resolvers/zod';
import { DcimCableLengthUnitSchema, DcimCableStatusSchema, DcimCableTypeSchema } from '@repo/api-client';
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
  type: DcimCableTypeSchema.or(z.literal('')),
  status: DcimCableStatusSchema.or(z.literal('')),
  label: z.string(),
  color: z.string(),
  length: z.string(),
  lengthUnit: DcimCableLengthUnitSchema.or(z.literal('')),
  description: z.string(),
});

type EditFormData = z.infer<typeof editSchema>;

export const Route = createFileRoute('/_app/dcim/cables/$cableId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditCablePage,
});

function EditCablePage() {
  const { cableId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getDcimCable.useQuery({
    queryKey: ['dcim-cable', cableId],
    queryData: { params: { id: cableId } },
  });

  const updateMutation = tsr.updateDcimCable.useMutation({
    meta: { successMessage: 'Cable updated' },
  });

  const cable = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditFormData>({
    resolver: zodResolver(editSchema),
    defaultValues: { type: '', status: '', label: '', color: '', length: '', lengthUnit: '', description: '' },
  });

  useEffect(() => {
    if (cable) {
      reset({
        type: cable.type ?? '',
        status: cable.status,
        label: cable.label ?? '',
        color: cable.color ?? '',
        length: cable.length?.toString() ?? '',
        lengthUnit: cable.lengthUnit ?? '',
        description: cable.description ?? '',
      });
    }
  }, [cable, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!cable) return null;

  const onSubmit = async (formData: EditFormData) => {
    await updateMutation.mutateAsync({
      params: { id: cableId },
      body: {
        type: formData.type || undefined,
        status: formData.status || undefined,
        label: formData.label || undefined,
        color: formData.color || undefined,
        length: formData.length ? parseFloat(formData.length) : undefined,
        lengthUnit: formData.lengthUnit || undefined,
        description: formData.description || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-cables'] });
    await queryClient.invalidateQueries({ queryKey: ['dcim-cable', cableId] });
    navigate({ to: '/dcim/cables/$cableId', params: { cableId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Cable</CardTitle>
        <CardDescription>Update details for {cable.label || 'this cable'}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="label" label="Label" />
          <FormSelect
            control={control}
            name="type"
            label="Type"
            options={enumOptions(DcimCableTypeSchema, { COAX: 'Coax' })}
            placeholder="Select type"
          />
          <FormSelect
            control={control}
            name="status"
            label="Status"
            options={enumOptions(DcimCableStatusSchema)}
            placeholder="Select status"
          />
          <FormInput control={control} name="color" label="Color" description="Hex color code (e.g. #ff0000)" />
          <FormInput control={control} name="length" label="Length" />
          <FormSelect
            control={control}
            name="lengthUnit"
            label="Length Unit"
            options={enumOptions(DcimCableLengthUnitSchema, { FEET: 'Feet' })}
            placeholder="Select length unit"
          />
          <FormTextarea control={control} name="description" label="Description" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/dcim/cables/$cableId', params: { cableId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
