import { zodResolver } from '@hookform/resolvers/zod';
import { VLAN_VID_MAX, VLAN_VID_MIN, VLAN_VID_RANGE_MESSAGE } from '@repo/api-client';
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

const createVlanGroupSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    description: z.string(),
    zoneId: z.union([z.literal(''), z.string().uuid('Data Center ID must be a valid UUID')]),
    minVid: z.coerce.number().int().min(VLAN_VID_MIN, VLAN_VID_RANGE_MESSAGE).max(VLAN_VID_MAX, VLAN_VID_RANGE_MESSAGE),
    maxVid: z.coerce.number().int().min(VLAN_VID_MIN, VLAN_VID_RANGE_MESSAGE).max(VLAN_VID_MAX, VLAN_VID_RANGE_MESSAGE),
  })
  .refine((data) => data.minVid <= data.maxVid, {
    message: 'Min VID must be less than or equal to Max VID',
    path: ['maxVid'],
  });

type CreateVlanGroupFormData = z.infer<typeof createVlanGroupSchema>;

export const Route = createFileRoute('/_app/ipam/vlan-groups/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateVlanGroupPage,
});

function CreateVlanGroupPage() {
  useDocumentTitle('Create VLAN Group');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: createVlanGroup, isPending } = tsr.createVlanGroup.useMutation({
    meta: { successMessage: 'VLAN group created' },
  });

  const { control, handleSubmit } = useForm<CreateVlanGroupFormData>({
    resolver: zodResolver(createVlanGroupSchema),
    defaultValues: {
      name: '',
      description: '',
      zoneId: '',
      minVid: VLAN_VID_MIN,
      maxVid: VLAN_VID_MAX,
    },
  });

  const onSubmit = async (data: CreateVlanGroupFormData) => {
    await createVlanGroup({
      body: {
        name: data.name,
        description: data.description || null,
        zoneId: data.zoneId || null,
        minVid: data.minVid,
        maxVid: data.maxVid,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['vlan-groups'] });
    navigate({ to: '/ipam/vlan-groups' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>VLAN Group Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="name" label="Name" />
            <FormTextarea control={control} name="description" label="Description" />
            <FormInput control={control} name="zoneId" label="Data Center ID" />
            <FormInput control={control} name="minVid" label="Min VID" type="number" />
            <FormInput control={control} name="maxVid" label="Max VID" type="number" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create VLAN Group'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/ipam/vlan-groups' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
