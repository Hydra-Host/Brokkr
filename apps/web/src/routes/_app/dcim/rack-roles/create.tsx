import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormInput } from '@repo/ui/form/form-input';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useIsInstanceOperator } from '~/hooks/use-is-instance-operator';
import { tsr } from '~/lib/api';

const createSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  slug: z.string().min(1, 'Slug is required'),
  color: z.string(),
  description: z.string(),
});

type CreateFormData = z.infer<typeof createSchema>;

export const Route = createFileRoute('/_app/dcim/rack-roles/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateRackRolePage,
});

function CreateRackRolePage() {
  useDocumentTitle('Create Rack Role');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isInstanceOperator, isPending: isCapabilityPending } = useIsInstanceOperator();

  const { mutateAsync: create, isPending } = tsr.createDcimRackRole.useMutation({
    meta: { successMessage: 'Rack role created' },
  });

  const { control, handleSubmit } = useForm<CreateFormData>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      name: '',
      slug: '',
      color: '',
      description: '',
    },
  });

  useEffect(() => {
    if (!isCapabilityPending && !isInstanceOperator) {
      navigate({ to: '/dcim/rack-roles' });
    }
  }, [isCapabilityPending, isInstanceOperator, navigate]);

  if (isCapabilityPending || !isInstanceOperator) return <Skeleton className="h-64" />;

  const onSubmit = async (data: CreateFormData) => {
    await create({
      body: {
        name: data.name,
        slug: data.slug,
        color: data.color || undefined,
        description: data.description || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-rack-roles'] });
    navigate({ to: '/dcim/rack-roles' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Rack Role Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="name" label="Name" />
            <FormInput control={control} name="slug" label="Slug" />
            <FormInput control={control} name="color" label="Color" description="Hex color code (e.g. #ff0000)" />
            <FormTextarea control={control} name="description" label="Description" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Rack Role'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/dcim/rack-roles' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
