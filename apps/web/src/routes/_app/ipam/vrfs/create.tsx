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

const createVrfSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  rd: z.string(),
  description: z.string(),
});

type CreateVrfFormData = z.infer<typeof createVrfSchema>;

export const Route = createFileRoute('/_app/ipam/vrfs/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateVrfPage,
});

function CreateVrfPage() {
  useDocumentTitle('Create VRF');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { mutateAsync: createVrf, isPending } = tsr.createVrf.useMutation({
    meta: { successMessage: 'VRF created' },
  });

  const { control, handleSubmit } = useForm<CreateVrfFormData>({
    resolver: zodResolver(createVrfSchema),
    defaultValues: {
      name: '',
      rd: '',
      description: '',
    },
  });

  const onSubmit = async (data: CreateVrfFormData) => {
    await createVrf({
      body: {
        name: data.name,
        rd: data.rd || undefined,
        description: data.description || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['vrfs'] });
    navigate({ to: '/ipam/vrfs' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>VRF Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="name" label="Name" />
            <FormInput control={control} name="rd" label="Route Distinguisher" description="e.g. 65000:100" />
            <FormTextarea control={control} name="description" label="Description" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create VRF'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/ipam/vrfs' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
