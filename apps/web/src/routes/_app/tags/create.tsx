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

const createTagSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  color: z.string(),
  description: z.string(),
});

type CreateTagFormData = z.infer<typeof createTagSchema>;

export const Route = createFileRoute('/_app/tags/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateTagPage,
});

function CreateTagPage() {
  useDocumentTitle('Create Tag');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: createTag, isPending } = tsr.createTag.useMutation({
    meta: { successMessage: 'Tag created' },
  });

  const { control, handleSubmit } = useForm<CreateTagFormData>({
    resolver: zodResolver(createTagSchema),
    defaultValues: {
      name: '',
      color: '',
      description: '',
    },
  });

  const onSubmit = async (data: CreateTagFormData) => {
    await createTag({
      body: {
        name: data.name,
        color: data.color || null,
        description: data.description || null,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['tags'] });
    navigate({ to: '/tags' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Tag Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="name" label="Name" />
            <FormInput control={control} name="color" label="Color" description="Hex color code (e.g. #ff0000)" />
            <FormTextarea control={control} name="description" label="Description" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Tag'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/tags' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
