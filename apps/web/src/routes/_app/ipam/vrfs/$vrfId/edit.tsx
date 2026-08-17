import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormInput } from '@repo/ui/form/form-input';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { tsr } from '~/lib/api';

const editVrfSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  rd: z.string(),
  description: z.string(),
});

type EditVrfFormData = z.infer<typeof editVrfSchema>;

export const Route = createFileRoute('/_app/ipam/vrfs/$vrfId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditVrfPage,
});

function EditVrfPage() {
  const { vrfId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getVrf.useQuery({
    queryKey: ['vrf', vrfId],
    queryData: { params: { id: vrfId } },
  });

  const updateMutation = tsr.updateVrf.useMutation({
    meta: { successMessage: 'VRF updated' },
  });

  const vrf = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditVrfFormData>({
    resolver: zodResolver(editVrfSchema),
    defaultValues: { name: '', rd: '', description: '' },
  });

  useEffect(() => {
    if (vrf) {
      reset({
        name: vrf.name,
        rd: vrf.rd ?? '',
        description: vrf.description ?? '',
      });
    }
  }, [vrf, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!vrf) return null;

  const onSubmit = async (formData: EditVrfFormData) => {
    await updateMutation.mutateAsync({
      params: { id: vrfId },
      body: {
        name: formData.name,
        rd: formData.rd || null,
        description: formData.description || null,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['vrfs'] });
    await queryClient.invalidateQueries({ queryKey: ['vrf', vrfId] });
    navigate({ to: '/ipam/vrfs/$vrfId', params: { vrfId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit VRF</CardTitle>
        <CardDescription>Update details for {vrf.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="name" label="Name" />
          <FormInput control={control} name="rd" label="Route Distinguisher" description="e.g. 65000:100" />
          <FormTextarea control={control} name="description" label="Description" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/ipam/vrfs/$vrfId', params: { vrfId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
