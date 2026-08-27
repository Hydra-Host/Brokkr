import { zodResolver } from '@hookform/resolvers/zod';
import { VLAN_VID_MAX, VLAN_VID_MIN, VLAN_VID_RANGE_MESSAGE } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { VrfCombobox } from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';

const statusOptions = [
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Reserved', value: 'RESERVED' },
  { label: 'Deprecated', value: 'DEPRECATED' },
] as const;

const editVlanSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  vid: z.coerce.number().int().min(VLAN_VID_MIN, VLAN_VID_RANGE_MESSAGE).max(VLAN_VID_MAX, VLAN_VID_RANGE_MESSAGE),
  status: z.string(),
  description: z.string(),
  vrfId: z.string(),
});

type EditVlanFormData = z.infer<typeof editVlanSchema>;

export const Route = createFileRoute('/_app/ipam/vlans/$vlanId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditVlanPage,
});

function EditVlanPage() {
  const { vlanId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getVlan.useQuery({
    queryKey: ['vlan', vlanId],
    queryData: { params: { id: vlanId } },
  });

  const updateMutation = tsr.updateVlan.useMutation({
    meta: { successMessage: 'VLAN updated' },
  });

  const vlan = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditVlanFormData>({
    resolver: zodResolver(editVlanSchema),
    defaultValues: { name: '', vid: VLAN_VID_MIN, status: 'ACTIVE', description: '', vrfId: '' },
  });

  useEffect(() => {
    if (vlan) {
      reset({
        name: vlan.name,
        vid: vlan.vid,
        status: vlan.status,
        description: vlan.description ?? '',
        vrfId: vlan.vrfId ?? '',
      });
    }
  }, [vlan, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!vlan) return null;

  const onSubmit = async (formData: EditVlanFormData) => {
    await updateMutation.mutateAsync({
      params: { id: vlanId },
      body: {
        name: formData.name,
        vid: formData.vid,
        status: formData.status as 'ACTIVE' | 'RESERVED' | 'DEPRECATED',
        description: formData.description || null,
        vrfId: formData.vrfId || null,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['vlans'] });
    await queryClient.invalidateQueries({ queryKey: ['vlan', vlanId] });
    navigate({ to: '/ipam/vlans/$vlanId', params: { vlanId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit VLAN</CardTitle>
        <CardDescription>Update details for {vlan.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="name" label="Name" />
          <FormInput
            control={control}
            name="vid"
            label="VID"
            type="number"
            description={`VLAN ID (${VLAN_VID_MIN}-${VLAN_VID_MAX})`}
            min={VLAN_VID_MIN}
            max={VLAN_VID_MAX}
          />
          <FormSelect
            control={control}
            name="status"
            label="Status"
            options={statusOptions}
            placeholder="Select status"
          />
          <VrfCombobox
            control={control}
            name="vrfId"
            noneLabel="None (global table)"
            seedOption={
              vlan.vrfId ? { value: vlan.vrfId, label: vlan.vrfId } : { value: '', label: 'None (global table)' }
            }
          />
          <FormTextarea control={control} name="description" label="Description" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/ipam/vlans/$vlanId', params: { vlanId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
