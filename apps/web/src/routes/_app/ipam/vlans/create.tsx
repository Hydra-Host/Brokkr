import { zodResolver } from '@hookform/resolvers/zod';
import { VLAN_VID_MAX, VLAN_VID_MIN, VLAN_VID_RANGE_MESSAGE } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { VrfCombobox } from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';

const statusOptions = [
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Reserved', value: 'RESERVED' },
  { label: 'Deprecated', value: 'DEPRECATED' },
] as const;

const createVlanSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  vid: z.coerce.number().int().min(VLAN_VID_MIN, VLAN_VID_RANGE_MESSAGE).max(VLAN_VID_MAX, VLAN_VID_RANGE_MESSAGE),
  status: z.string(),
  description: z.string(),
  vrfId: z.string(),
});

type CreateVlanFormData = z.infer<typeof createVlanSchema>;

export const Route = createFileRoute('/_app/ipam/vlans/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateVlanPage,
});

function CreateVlanPage() {
  useDocumentTitle('Create VLAN');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { mutateAsync: createVlan, isPending } = tsr.createVlan.useMutation({
    meta: { successMessage: 'VLAN created' },
  });

  const { control, handleSubmit } = useForm<CreateVlanFormData>({
    resolver: zodResolver(createVlanSchema),
    defaultValues: {
      name: '',
      vid: VLAN_VID_MIN,
      status: 'ACTIVE',
      description: '',
      vrfId: '',
    },
  });

  const onSubmit = async (data: CreateVlanFormData) => {
    await createVlan({
      body: {
        name: data.name,
        vid: data.vid,
        status: data.status as 'ACTIVE' | 'RESERVED' | 'DEPRECATED',
        description: data.description || undefined,
        vrfId: data.vrfId || null,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['vlans'] });
    navigate({ to: '/ipam/vlans' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>VLAN Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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
            <VrfCombobox control={control} name="vrfId" noneLabel="None (global table)" />
            <FormTextarea control={control} name="description" label="Description" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create VLAN'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/ipam/vlans' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
