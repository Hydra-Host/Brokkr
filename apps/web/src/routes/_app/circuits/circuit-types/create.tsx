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

const createCircuitTypeSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  slug: z.string().min(1, 'Slug is required'),
  color: z.string(),
  description: z.string(),
});

type CreateCircuitTypeFormData = z.infer<typeof createCircuitTypeSchema>;

export const Route = createFileRoute('/_app/circuits/circuit-types/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateCircuitTypePage,
});

function CreateCircuitTypePage() {
  useDocumentTitle('Create Circuit Type');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: createCircuitType, isPending } = tsr.createCircuitType.useMutation({
    meta: { successMessage: 'Circuit type created' },
  });

  const { control, handleSubmit } = useForm<CreateCircuitTypeFormData>({
    resolver: zodResolver(createCircuitTypeSchema),
    defaultValues: {
      name: '',
      slug: '',
      color: '',
      description: '',
    },
  });

  const onSubmit = async (data: CreateCircuitTypeFormData) => {
    await createCircuitType({
      body: {
        name: data.name,
        slug: data.slug,
        color: data.color || undefined,
        description: data.description || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['circuit-types'] });
    navigate({ to: '/circuits/circuit-types' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Circuit Type Details</CardTitle>
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
            {isPending ? 'Creating...' : 'Create Circuit Type'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/circuits/circuit-types' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
