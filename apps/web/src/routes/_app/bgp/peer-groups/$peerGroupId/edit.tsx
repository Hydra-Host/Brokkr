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

const editPeerGroupSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string(),
});

type EditPeerGroupFormData = z.infer<typeof editPeerGroupSchema>;

export const Route = createFileRoute('/_app/bgp/peer-groups/$peerGroupId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditBgpPeerGroupPage,
});

function EditBgpPeerGroupPage() {
  const { peerGroupId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getBgpPeerGroup.useQuery({
    queryKey: ['bgp-peer-group', peerGroupId],
    queryData: { params: { id: peerGroupId } },
  });

  const updateMutation = tsr.updateBgpPeerGroup.useMutation({
    meta: { successMessage: 'BGP peer group updated' },
  });

  const peerGroup = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditPeerGroupFormData>({
    resolver: zodResolver(editPeerGroupSchema),
    defaultValues: { name: '', description: '' },
  });

  useEffect(() => {
    if (peerGroup) {
      reset({
        name: peerGroup.name,
        description: peerGroup.description ?? '',
      });
    }
  }, [peerGroup, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!peerGroup) return null;

  const onSubmit = async (formData: EditPeerGroupFormData) => {
    await updateMutation.mutateAsync({
      params: { id: peerGroupId },
      body: {
        name: formData.name,
        description: formData.description || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['bgp-peer-groups'] });
    await queryClient.invalidateQueries({ queryKey: ['bgp-peer-group', peerGroupId] });
    navigate({ to: '/bgp/peer-groups/$peerGroupId', params: { peerGroupId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit BGP Peer Group</CardTitle>
        <CardDescription>Update details for {peerGroup.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="name" label="Name" />
          <FormTextarea control={control} name="description" label="Description" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/bgp/peer-groups/$peerGroupId', params: { peerGroupId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
