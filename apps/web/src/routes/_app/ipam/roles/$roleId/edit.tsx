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

const editIpamRoleSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  slug: z.string().min(1, 'Slug is required'),
  weight: z.coerce.number().int().min(0, 'Weight must be non-negative'),
  description: z.string(),
});

type EditIpamRoleFormData = z.infer<typeof editIpamRoleSchema>;

export const Route = createFileRoute('/_app/ipam/roles/$roleId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditIpamRolePage,
});

function EditIpamRolePage() {
  const { roleId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getIpamRole.useQuery({
    queryKey: ['ipam-role', roleId],
    queryData: { params: { id: roleId } },
  });

  const updateMutation = tsr.updateIpamRole.useMutation({
    meta: { successMessage: 'IPAM role updated' },
  });

  const role = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditIpamRoleFormData>({
    resolver: zodResolver(editIpamRoleSchema),
    defaultValues: { name: '', slug: '', weight: 1000, description: '' },
  });

  useEffect(() => {
    if (role) {
      reset({
        name: role.name,
        slug: role.slug,
        weight: role.weight,
        description: role.description ?? '',
      });
    }
  }, [role, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!role) return null;

  const onSubmit = async (formData: EditIpamRoleFormData) => {
    await updateMutation.mutateAsync({
      params: { id: roleId },
      body: {
        ...formData,
        description: formData.description || null,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['ipam-roles'] });
    await queryClient.invalidateQueries({ queryKey: ['ipam-role', roleId] });
    navigate({ to: '/ipam/roles/$roleId', params: { roleId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit IPAM Role</CardTitle>
        <CardDescription>Update details for {role.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="name" label="Name" />
          <FormInput control={control} name="slug" label="Slug" />
          <FormInput control={control} name="weight" label="Weight" type="number" />
          <FormTextarea control={control} name="description" label="Description" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/ipam/roles/$roleId', params: { roleId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
