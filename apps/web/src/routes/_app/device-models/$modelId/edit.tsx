import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormInput } from '@repo/ui/form/form-input';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { tsr } from '~/lib/api';

const editSchema = z.object({
  manufacturer: z.string().min(1, 'Manufacturer is required'),
  model: z.string().min(1, 'Model is required'),
  formFactor: z.string(),
  description: z.string(),
  isFullDepth: z.boolean(),
  heightU: z.coerce.number().int().min(0).optional().or(z.literal('')),
  maxPowerW: z.coerce.number().int().min(0).optional().or(z.literal('')),
});

type FormData = z.infer<typeof editSchema>;

export const Route = createFileRoute('/_app/device-models/$modelId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditDeviceModelPage,
});

function EditDeviceModelPage() {
  const { modelId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getDeviceModel.useQuery({
    queryKey: ['device-model', modelId],
    queryData: { params: { id: modelId } },
  });

  const updateMutation = tsr.updateDeviceModel.useMutation({
    meta: { successMessage: 'Device model updated' },
  });

  const dm = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<FormData>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      manufacturer: '',
      model: '',
      formFactor: '',
      description: '',
      isFullDepth: true,
      heightU: '',
      maxPowerW: '',
    },
  });

  useEffect(() => {
    if (dm) {
      reset({
        manufacturer: dm.manufacturer,
        model: dm.model,
        formFactor: dm.formFactor ?? '',
        description: dm.description ?? '',
        isFullDepth: dm.isFullDepth,
        heightU: dm.heightU ?? '',
        maxPowerW: dm.maxPowerW ?? '',
      });
    }
  }, [dm, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!dm) return null;

  const onSubmit = async (formData: FormData) => {
    await updateMutation.mutateAsync({
      params: { id: modelId },
      body: {
        manufacturer: formData.manufacturer,
        model: formData.model,
        formFactor: formData.formFactor || null,
        description: formData.description || null,
        isFullDepth: formData.isFullDepth,
        heightU: typeof formData.heightU === 'number' ? formData.heightU : null,
        maxPowerW: typeof formData.maxPowerW === 'number' ? formData.maxPowerW : null,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['device-models'] });
    await queryClient.invalidateQueries({ queryKey: ['device-model', modelId] });
    navigate({ to: '/device-models/$modelId', params: { modelId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Device Model</CardTitle>
        <CardDescription>
          Update details for {dm.manufacturer} {dm.model}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="manufacturer" label="Manufacturer" />
          <FormInput control={control} name="model" label="Model" />
          <FormInput control={control} name="formFactor" label="Form Factor" description="e.g. 1U, 2U, blade" />
          <FormTextarea control={control} name="description" label="Description" />
          <FormCheckbox
            control={control}
            name="isFullDepth"
            label="Full depth"
            description="Occupies the full depth of a rack"
          />
          <FormInput control={control} name="heightU" label="Height (U)" type="number" />
          <FormInput control={control} name="maxPowerW" label="Max Power (W)" type="number" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/device-models/$modelId', params: { modelId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
