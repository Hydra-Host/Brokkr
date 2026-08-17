import { zodResolver } from '@hookform/resolvers/zod';
import { IpamRoleSchema } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PrefixRoleCombobox, VrfCombobox, ZoneCombobox } from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';

const statusOptions = [
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Reserved', value: 'RESERVED' },
  { label: 'Deprecated', value: 'DEPRECATED' },
  { label: 'Container', value: 'CONTAINER' },
] as const;

const roleOptions = [
  { label: 'None', value: '' },
  { label: 'Allocation', value: 'ALLOCATION' },
  { label: 'Common', value: 'COMMON' },
  { label: 'Loopback', value: 'LOOPBACK' },
  { label: 'Management', value: 'MANAGEMENT' },
  { label: 'NAT', value: 'NAT' },
  { label: 'Primary', value: 'PRIMARY' },
] as const;

const createPrefixSchema = z.object({
  prefix: z.string().min(1, 'Prefix is required'),
  status: z.string(),
  isPool: z.boolean(),
  role: IpamRoleSchema.or(z.literal('')),
  zoneId: z.string(),
  vrfId: z.string(),
  prefixRoleId: z.string(),
  enableVlanTag: z.boolean(),
});

type CreatePrefixFormData = z.infer<typeof createPrefixSchema>;

export const Route = createFileRoute('/_app/ipam/prefixes/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreatePrefixPage,
});

function CreatePrefixPage() {
  useDocumentTitle('Create Prefix');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { mutateAsync: createPrefix, isPending } = tsr.createPrefix.useMutation({
    meta: { successMessage: 'Prefix created' },
  });

  const { control, handleSubmit } = useForm<CreatePrefixFormData>({
    resolver: zodResolver(createPrefixSchema),
    defaultValues: {
      prefix: '',
      status: 'ACTIVE',
      isPool: false,
      role: '',
      zoneId: '',
      vrfId: '',
      prefixRoleId: '',
      enableVlanTag: false,
    },
  });

  const onSubmit = async (data: CreatePrefixFormData) => {
    await createPrefix({
      body: {
        prefix: data.prefix,
        status: data.status as 'ACTIVE' | 'RESERVED' | 'DEPRECATED' | 'CONTAINER',
        isPool: data.isPool,
        role: data.role === '' ? null : data.role,
        zoneId: data.zoneId === '' ? null : data.zoneId,
        vrfId: data.vrfId === '' ? null : data.vrfId,
        prefixRoleId: data.prefixRoleId === '' ? null : data.prefixRoleId,
        enableVlanTag: data.enableVlanTag,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['prefixes'] });
    navigate({ to: '/ipam/prefixes' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Prefix Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="prefix" label="Prefix" description="CIDR notation (e.g. 10.0.0.0/24)" />
            <FormSelect
              control={control}
              name="status"
              label="Status"
              options={statusOptions}
              placeholder="Select status"
            />
            <FormSelect
              control={control}
              name="role"
              label="Role"
              options={roleOptions}
              placeholder="Select role"
              description="Set to Management (and a zone below) so this subnet is scanned during zone commissioning."
            />
            <ZoneCombobox
              control={control}
              name="zoneId"
              description="Optional. Required later if this subnet should advertise a VRRP floating IP."
            />
            <VrfCombobox control={control} name="vrfId" />
            <PrefixRoleCombobox control={control} name="prefixRoleId" />
            <FormCheckbox
              control={control}
              name="enableVlanTag"
              label="Always VLAN-tag"
              description="VLAN-tag IPs in this prefix in rendered netplan regardless of device role"
            />
            <FormCheckbox
              control={control}
              name="isPool"
              label="Is Pool"
              description="Mark this prefix as an IP pool for automatic allocation"
            />
          </CardContent>
        </Card>

        <Card className="opacity-70">
          <CardHeader>
            <CardTitle>VRRP Floating IP (VIP)</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              A VRRP floating IP can be configured once this prefix has been saved to a zone and contains at least one
              IP address. You can then assign the floating IP and its bridge interface from the{' '}
              <span className="font-medium">Edit</span> page.
            </p>
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Prefix'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/ipam/prefixes' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
