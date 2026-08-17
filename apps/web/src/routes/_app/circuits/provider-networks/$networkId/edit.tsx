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

const editProviderNetworkSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string(),
  comments: z.string(),
});

type EditProviderNetworkFormData = z.infer<typeof editProviderNetworkSchema>;

export const Route = createFileRoute('/_app/circuits/provider-networks/$networkId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditProviderNetworkPage,
});

function EditProviderNetworkPage() {
  const { networkId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getProviderNetwork.useQuery({
    queryKey: ['provider-network', networkId],
    queryData: { params: { id: networkId } },
  });

  const updateMutation = tsr.updateProviderNetwork.useMutation({
    meta: { successMessage: 'Provider network updated' },
  });

  const network = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditProviderNetworkFormData>({
    resolver: zodResolver(editProviderNetworkSchema),
    defaultValues: { name: '', description: '', comments: '' },
  });

  useEffect(() => {
    if (network) {
      reset({
        name: network.name,
        description: network.description ?? '',
        comments: network.comments ?? '',
      });
    }
  }, [network, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!network) return null;

  const onSubmit = async (formData: EditProviderNetworkFormData) => {
    await updateMutation.mutateAsync({
      params: { id: networkId },
      body: {
        name: formData.name,
        description: formData.description || undefined,
        comments: formData.comments || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['provider-networks'] });
    await queryClient.invalidateQueries({ queryKey: ['provider-network', networkId] });
    navigate({ to: '/circuits/provider-networks/$networkId', params: { networkId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Provider Network</CardTitle>
        <CardDescription>Update details for {network.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="name" label="Name" />
          <FormTextarea control={control} name="description" label="Description" />
          <FormTextarea control={control} name="comments" label="Comments" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/circuits/provider-networks/$networkId', params: { networkId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
