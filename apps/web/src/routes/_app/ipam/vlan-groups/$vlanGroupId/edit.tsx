import { zodResolver } from '@hookform/resolvers/zod';
import { VLAN_VID_MAX, VLAN_VID_MIN, VLAN_VID_RANGE_MESSAGE } from '@repo/api-client';
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

const editVlanGroupSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    description: z.string(),
    minVid: z.coerce.number().int().min(VLAN_VID_MIN, VLAN_VID_RANGE_MESSAGE).max(VLAN_VID_MAX, VLAN_VID_RANGE_MESSAGE),
    maxVid: z.coerce.number().int().min(VLAN_VID_MIN, VLAN_VID_RANGE_MESSAGE).max(VLAN_VID_MAX, VLAN_VID_RANGE_MESSAGE),
  })
  .refine((data) => data.minVid <= data.maxVid, {
    message: 'Min VID must be less than or equal to Max VID',
    path: ['maxVid'],
  });

type EditVlanGroupFormData = z.infer<typeof editVlanGroupSchema>;

export const Route = createFileRoute('/_app/ipam/vlan-groups/$vlanGroupId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditVlanGroupPage,
});

function EditVlanGroupPage() {
  const { vlanGroupId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getVlanGroup.useQuery({
    queryKey: ['vlan-group', vlanGroupId],
    queryData: { params: { id: vlanGroupId } },
  });

  const updateMutation = tsr.updateVlanGroup.useMutation({
    meta: { successMessage: 'VLAN group updated' },
  });

  const vlanGroup = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditVlanGroupFormData>({
    resolver: zodResolver(editVlanGroupSchema),
    defaultValues: { name: '', description: '', minVid: VLAN_VID_MIN, maxVid: VLAN_VID_MAX },
  });

  useEffect(() => {
    if (vlanGroup) {
      reset({
        name: vlanGroup.name,
        description: vlanGroup.description ?? '',
        minVid: vlanGroup.minVid,
        maxVid: vlanGroup.maxVid,
      });
    }
  }, [vlanGroup, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!vlanGroup) return null;

  const onSubmit = async (formData: EditVlanGroupFormData) => {
    await updateMutation.mutateAsync({
      params: { id: vlanGroupId },
      body: {
        ...formData,
        description: formData.description || null,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['vlan-groups'] });
    await queryClient.invalidateQueries({ queryKey: ['vlan-group', vlanGroupId] });
    navigate({ to: '/ipam/vlan-groups/$vlanGroupId', params: { vlanGroupId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit VLAN Group</CardTitle>
        <CardDescription>Update details for {vlanGroup.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="name" label="Name" />
          <FormTextarea control={control} name="description" label="Description" />
          <FormInput control={control} name="minVid" label="Min VID" type="number" />
          <FormInput control={control} name="maxVid" label="Max VID" type="number" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/ipam/vlan-groups/$vlanGroupId', params: { vlanGroupId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
