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

const editProviderSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  slug: z.string().min(1, 'Slug is required'),
  description: z.string(),
  comments: z.string(),
});

type EditProviderFormData = z.infer<typeof editProviderSchema>;

export const Route = createFileRoute('/_app/circuits/providers/$providerId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditProviderPage,
});

function EditProviderPage() {
  const { providerId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getProvider.useQuery({
    queryKey: ['provider', providerId],
    queryData: { params: { id: providerId } },
  });

  const updateMutation = tsr.updateProvider.useMutation({
    meta: { successMessage: 'Provider updated' },
  });

  const provider = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditProviderFormData>({
    resolver: zodResolver(editProviderSchema),
    defaultValues: { name: '', slug: '', description: '', comments: '' },
  });

  useEffect(() => {
    if (provider) {
      reset({
        name: provider.name,
        slug: provider.slug,
        description: provider.description ?? '',
        comments: provider.comments ?? '',
      });
    }
  }, [provider, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!provider) return null;

  const onSubmit = async (formData: EditProviderFormData) => {
    await updateMutation.mutateAsync({
      params: { id: providerId },
      body: {
        ...formData,
        description: formData.description || undefined,
        comments: formData.comments || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['providers'] });
    await queryClient.invalidateQueries({ queryKey: ['provider', providerId] });
    navigate({ to: '/circuits/providers/$providerId', params: { providerId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Provider</CardTitle>
        <CardDescription>Update details for {provider.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="name" label="Name" />
          <FormInput control={control} name="slug" label="Slug" />
          <FormTextarea control={control} name="description" label="Description" />
          <FormTextarea control={control} name="comments" label="Comments" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/circuits/providers/$providerId', params: { providerId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
