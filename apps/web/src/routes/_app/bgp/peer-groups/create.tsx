import { zodResolver } from '@hookform/resolvers/zod';
import { useSession } from '@repo/auth/client';
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

const createPeerGroupSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string(),
});

type CreatePeerGroupFormData = z.infer<typeof createPeerGroupSchema>;

export const Route = createFileRoute('/_app/bgp/peer-groups/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateBgpPeerGroupPage,
});

function CreateBgpPeerGroupPage() {
  useDocumentTitle('Create BGP Peer Group');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const activeOrgId = (session?.session as { activeOrganizationId?: string } | undefined)?.activeOrganizationId ?? '';

  const { mutateAsync: createPeerGroup, isPending } = tsr.createBgpPeerGroup.useMutation({
    meta: { successMessage: 'BGP peer group created' },
  });

  const { control, handleSubmit } = useForm<CreatePeerGroupFormData>({
    resolver: zodResolver(createPeerGroupSchema),
    defaultValues: {
      name: '',
      description: '',
    },
  });

  const onSubmit = async (data: CreatePeerGroupFormData) => {
    await createPeerGroup({
      body: {
        name: data.name,
        description: data.description || undefined,
        organizationId: activeOrgId || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['bgp-peer-groups'] });
    navigate({ to: '/bgp/peer-groups' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>BGP Peer Group Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="name" label="Name" />
            <FormTextarea control={control} name="description" label="Description" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Peer Group'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/bgp/peer-groups' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
