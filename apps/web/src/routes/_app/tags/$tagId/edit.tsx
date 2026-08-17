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

const editTagSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  color: z.string(),
  description: z.string(),
});

type EditTagFormData = z.infer<typeof editTagSchema>;

export const Route = createFileRoute('/_app/tags/$tagId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditTagPage,
});

function EditTagPage() {
  const { tagId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getTag.useQuery({
    queryKey: ['tag', tagId],
    queryData: { params: { id: tagId } },
  });

  const updateMutation = tsr.updateTag.useMutation({
    meta: { successMessage: 'Tag updated' },
  });

  const tag = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditTagFormData>({
    resolver: zodResolver(editTagSchema),
    defaultValues: { name: '', color: '', description: '' },
  });

  useEffect(() => {
    if (tag) {
      reset({
        name: tag.name,
        color: tag.color ?? '',
        description: tag.description ?? '',
      });
    }
  }, [tag, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!tag) return null;

  const onSubmit = async (formData: EditTagFormData) => {
    await updateMutation.mutateAsync({
      params: { id: tagId },
      body: {
        ...formData,
        color: formData.color || null,
        description: formData.description || null,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['tags'] });
    await queryClient.invalidateQueries({ queryKey: ['tag', tagId] });
    navigate({ to: '/tags/$tagId', params: { tagId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Tag</CardTitle>
        <CardDescription>Update details for {tag.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="name" label="Name" />
          <FormInput control={control} name="color" label="Color" description="Hex color code (e.g. #ff0000)" />
          <FormTextarea control={control} name="description" label="Description" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button type="button" variant="outline" onClick={() => navigate({ to: '/tags/$tagId', params: { tagId } })}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
