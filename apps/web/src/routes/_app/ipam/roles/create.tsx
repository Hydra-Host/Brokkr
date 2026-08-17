import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormInput } from '@repo/ui/form/form-input';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { tsr } from '~/lib/api';

const createIpamRoleSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  slug: z.string().min(1, 'Slug is required'),
  weight: z.coerce.number().int().min(0, 'Weight must be non-negative'),
  description: z.string(),
});

type CreateIpamRoleFormData = z.infer<typeof createIpamRoleSchema>;

export const Route = createFileRoute('/_app/ipam/roles/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateIpamRolePage,
});

function CreateIpamRolePage() {
  useDocumentTitle('Create IPAM Role');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: createIpamRole, isPending } = tsr.createIpamRole.useMutation({
    meta: { successMessage: 'IPAM role created' },
  });

  const { control, handleSubmit } = useForm<CreateIpamRoleFormData>({
    resolver: zodResolver(createIpamRoleSchema),
    defaultValues: {
      name: '',
      slug: '',
      weight: 1000,
      description: '',
    },
  });

  const onSubmit = async (data: CreateIpamRoleFormData) => {
    await createIpamRole({
      body: {
        name: data.name,
        slug: data.slug,
        weight: data.weight,
        description: data.description || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['ipam-roles'] });
    navigate({ to: '/ipam/roles' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>IPAM Role Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="name" label="Name" />
            <FormInput control={control} name="slug" label="Slug" />
            <FormInput control={control} name="weight" label="Weight" type="number" />
            <FormTextarea control={control} name="description" label="Description" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Role'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/ipam/roles' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
