import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { tsr } from '~/lib/api';

const statusOptions = [
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Reserved', value: 'RESERVED' },
  { label: 'Deprecated', value: 'DEPRECATED' },
  { label: 'DHCP', value: 'DHCP' },
] as const;

const createIpAddressSchema = z.object({
  address: z.string().min(1, 'Address is required'),
  status: z.string(),
  dnsName: z.string(),
});

type CreateIpAddressFormData = z.infer<typeof createIpAddressSchema>;

export const Route = createFileRoute('/_app/ipam/ip-addresses/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateIpAddressPage,
});

function CreateIpAddressPage() {
  useDocumentTitle('Create IP Address');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { mutateAsync: createIpAddress, isPending } = tsr.createIpAddress.useMutation({
    meta: { successMessage: 'IP address created' },
  });

  const { control, handleSubmit } = useForm<CreateIpAddressFormData>({
    resolver: zodResolver(createIpAddressSchema),
    defaultValues: {
      address: '',
      status: 'ACTIVE',
      dnsName: '',
    },
  });

  const onSubmit = async (data: CreateIpAddressFormData) => {
    await createIpAddress({
      body: {
        address: data.address,
        status: data.status as 'ACTIVE' | 'RESERVED' | 'DEPRECATED' | 'DHCP',
        dnsName: data.dnsName || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['ip-addresses'] });
    navigate({ to: '/ipam/ip-addresses' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>IP Address Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput
              control={control}
              name="address"
              label="Address"
              description="CIDR notation (e.g. 10.0.0.1/32)"
            />
            <FormSelect
              control={control}
              name="status"
              label="Status"
              options={statusOptions}
              placeholder="Select status"
            />
            <FormInput control={control} name="dnsName" label="DNS Name" description="Optional DNS name for this IP" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create IP Address'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/ipam/ip-addresses' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
