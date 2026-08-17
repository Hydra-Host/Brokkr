import { zodResolver } from '@hookform/resolvers/zod';
import { DcimFeedLegPhaseSchema, DcimPowerOutletTypeSchema } from '@repo/api-client';
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
  type: DcimPowerOutletTypeSchema.or(z.literal('')),
  feedLegPhase: DcimFeedLegPhaseSchema.or(z.literal('')),
  description: z.string(),
});

type EditFormData = z.infer<typeof editSchema>;

export const Route = createFileRoute('/_app/dcim/power-outlets/$outletId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditPowerOutletPage,
});

function EditPowerOutletPage() {
  const { outletId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getDcimPowerOutlet.useQuery({
    queryKey: ['dcim-power-outlet', outletId],
    queryData: { params: { id: outletId } },
  });

  const updateMutation = tsr.updateDcimPowerOutlet.useMutation({
    meta: { successMessage: 'Power outlet updated' },
  });

  const outlet = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditFormData>({
    resolver: zodResolver(editSchema),
    defaultValues: { name: '', type: '', feedLegPhase: '', description: '' },
  });

  useEffect(() => {
    if (outlet) {
      reset({
        name: outlet.name,
        type: outlet.type ?? '',
        feedLegPhase: outlet.feedLegPhase ?? '',
        description: outlet.description ?? '',
      });
    }
  }, [outlet, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!outlet) return null;

  const onSubmit = async (formData: EditFormData) => {
    await updateMutation.mutateAsync({
      params: { id: outletId },
      body: {
        name: formData.name,
        type: formData.type || undefined,
        feedLegPhase: formData.feedLegPhase || undefined,
        description: formData.description || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-power-outlets'] });
    await queryClient.invalidateQueries({ queryKey: ['dcim-power-outlet', outletId] });
    navigate({ to: '/dcim/power-outlets/$outletId', params: { outletId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Power Outlet</CardTitle>
        <CardDescription>Update details for {outlet.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="name" label="Name" />
          <FormSelect
            control={control}
            name="type"
            label="Type"
            options={enumOptions(DcimPowerOutletTypeSchema)}
            placeholder="Select type"
          />
          <FormSelect
            control={control}
            name="feedLegPhase"
            label="Feed Leg Phase"
            options={enumOptions(DcimFeedLegPhaseSchema)}
            placeholder="Select feed leg phase"
          />
          <FormTextarea control={control} name="description" label="Description" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/dcim/power-outlets/$outletId', params: { outletId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
