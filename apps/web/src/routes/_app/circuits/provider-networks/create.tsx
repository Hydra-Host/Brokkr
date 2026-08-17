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
import { ProviderCombobox } from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';

const createProviderNetworkSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string(),
  comments: z.string(),
  providerId: z.string().min(1, 'Provider ID is required'),
});

type CreateProviderNetworkFormData = z.infer<typeof createProviderNetworkSchema>;

export const Route = createFileRoute('/_app/circuits/provider-networks/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateProviderNetworkPage,
});

function CreateProviderNetworkPage() {
  useDocumentTitle('Create Provider Network');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: createProviderNetwork, isPending } = tsr.createProviderNetwork.useMutation({
    meta: { successMessage: 'Provider network created' },
  });

  const { control, handleSubmit } = useForm<CreateProviderNetworkFormData>({
    resolver: zodResolver(createProviderNetworkSchema),
    defaultValues: {
      name: '',
      description: '',
      comments: '',
      providerId: '',
    },
  });

  const onSubmit = async (data: CreateProviderNetworkFormData) => {
    await createProviderNetwork({
      body: {
        name: data.name,
        description: data.description || undefined,
        comments: data.comments || undefined,
        providerId: data.providerId,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['provider-networks'] });
    navigate({ to: '/circuits/provider-networks' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Provider Network Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="name" label="Name" />
            <ProviderCombobox control={control} name="providerId" />
            <FormTextarea control={control} name="description" label="Description" />
            <FormTextarea control={control} name="comments" label="Comments" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Provider Network'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/circuits/provider-networks' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
