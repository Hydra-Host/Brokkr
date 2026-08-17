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

const editCircuitTypeSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  slug: z.string().min(1, 'Slug is required'),
  color: z.string(),
  description: z.string(),
});

type EditCircuitTypeFormData = z.infer<typeof editCircuitTypeSchema>;

export const Route = createFileRoute('/_app/circuits/circuit-types/$typeId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditCircuitTypePage,
});

function EditCircuitTypePage() {
  const { typeId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getCircuitType.useQuery({
    queryKey: ['circuit-type', typeId],
    queryData: { params: { id: typeId } },
  });

  const updateMutation = tsr.updateCircuitType.useMutation({
    meta: { successMessage: 'Circuit type updated' },
  });

  const circuitType = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditCircuitTypeFormData>({
    resolver: zodResolver(editCircuitTypeSchema),
    defaultValues: { name: '', slug: '', color: '', description: '' },
  });

  useEffect(() => {
    if (circuitType) {
      reset({
        name: circuitType.name,
        slug: circuitType.slug,
        color: circuitType.color ?? '',
        description: circuitType.description ?? '',
      });
    }
  }, [circuitType, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!circuitType) return null;

  const onSubmit = async (formData: EditCircuitTypeFormData) => {
    await updateMutation.mutateAsync({
      params: { id: typeId },
      body: {
        ...formData,
        color: formData.color || undefined,
        description: formData.description || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['circuit-types'] });
    await queryClient.invalidateQueries({ queryKey: ['circuit-type', typeId] });
    navigate({ to: '/circuits/circuit-types/$typeId', params: { typeId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Circuit Type</CardTitle>
        <CardDescription>Update details for {circuitType.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="name" label="Name" />
          <FormInput control={control} name="slug" label="Slug" />
          <FormInput control={control} name="color" label="Color" description="Hex color code (e.g. #ff0000)" />
          <FormTextarea control={control} name="description" label="Description" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/circuits/circuit-types/$typeId', params: { typeId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
