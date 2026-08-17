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
import { useIsInstanceOperator } from '~/hooks/use-is-instance-operator';
import { tsr } from '~/lib/api';

const editSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  slug: z.string().min(1, 'Slug is required'),
  color: z.string(),
  description: z.string(),
});

type EditFormData = z.infer<typeof editSchema>;

export const Route = createFileRoute('/_app/dcim/rack-roles/$roleId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditRackRolePage,
});

function EditRackRolePage() {
  const { roleId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isInstanceOperator, isPending: isCapabilityPending } = useIsInstanceOperator();

  const { data, isPending: isLoading } = tsr.getDcimRackRole.useQuery({
    queryKey: ['dcim-rack-role', roleId],
    queryData: { params: { id: roleId } },
  });

  const updateMutation = tsr.updateDcimRackRole.useMutation({
    meta: { successMessage: 'Rack role updated' },
  });

  const role = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditFormData>({
    resolver: zodResolver(editSchema),
    defaultValues: { name: '', slug: '', color: '', description: '' },
  });

  useEffect(() => {
    if (role) {
      reset({
        name: role.name,
        slug: role.slug,
        color: role.color ?? '',
        description: role.description ?? '',
      });
    }
  }, [role, reset]);

  useEffect(() => {
    if (!isCapabilityPending && !isInstanceOperator) {
      navigate({ to: '/dcim/rack-roles' });
    }
  }, [isCapabilityPending, isInstanceOperator, navigate]);

  if (isLoading || isCapabilityPending || !isInstanceOperator) return <Skeleton className="h-64" />;
  if (!role) return null;

  const onSubmit = async (formData: EditFormData) => {
    await updateMutation.mutateAsync({
      params: { id: roleId },
      body: {
        ...formData,
        color: formData.color || undefined,
        description: formData.description || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-rack-roles'] });
    await queryClient.invalidateQueries({ queryKey: ['dcim-rack-role', roleId] });
    navigate({ to: '/dcim/rack-roles/$roleId', params: { roleId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Rack Role</CardTitle>
        <CardDescription>Update details for {role.name}</CardDescription>
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
              onClick={() => navigate({ to: '/dcim/rack-roles/$roleId', params: { roleId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
