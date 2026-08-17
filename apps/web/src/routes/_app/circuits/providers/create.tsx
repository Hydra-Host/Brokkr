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

const createProviderSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  slug: z.string().min(1, 'Slug is required'),
  description: z.string(),
  comments: z.string(),
});

type CreateProviderFormData = z.infer<typeof createProviderSchema>;

export const Route = createFileRoute('/_app/circuits/providers/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateProviderPage,
});

function CreateProviderPage() {
  useDocumentTitle('Create Provider');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: createProvider, isPending } = tsr.createProvider.useMutation({
    meta: { successMessage: 'Provider created' },
  });

  const { control, handleSubmit } = useForm<CreateProviderFormData>({
    resolver: zodResolver(createProviderSchema),
    defaultValues: {
      name: '',
      slug: '',
      description: '',
      comments: '',
    },
  });

  const onSubmit = async (data: CreateProviderFormData) => {
    await createProvider({
      body: {
        name: data.name,
        slug: data.slug,
        description: data.description || undefined,
        comments: data.comments || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['providers'] });
    navigate({ to: '/circuits/providers' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Provider Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="name" label="Name" />
            <FormInput control={control} name="slug" label="Slug" />
            <FormTextarea control={control} name="description" label="Description" />
            <FormTextarea control={control} name="comments" label="Comments" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Provider'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/circuits/providers' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
