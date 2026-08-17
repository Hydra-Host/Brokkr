import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { IpAddressGatewayCard } from '~/components/ip-address-gateway-card';
import { tsr } from '~/lib/api';

const statusOptions = [
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Reserved', value: 'RESERVED' },
  { label: 'Deprecated', value: 'DEPRECATED' },
  { label: 'DHCP', value: 'DHCP' },
] as const;

const editIpAddressSchema = z.object({
  status: z.string(),
  dnsName: z.string(),
});

type EditIpAddressFormData = z.infer<typeof editIpAddressSchema>;

export const Route = createFileRoute('/_app/ipam/ip-addresses/$ipAddressId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditIpAddressPage,
});

function EditIpAddressPage() {
  const { ipAddressId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getIpAddress.useQuery({
    queryKey: ['ip-address', ipAddressId],
    queryData: { params: { id: ipAddressId } },
  });

  const updateMutation = tsr.updateIpAddress.useMutation({
    meta: { successMessage: 'IP address updated' },
  });

  const ipAddress = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditIpAddressFormData>({
    resolver: zodResolver(editIpAddressSchema),
    defaultValues: { status: 'ACTIVE', dnsName: '' },
  });

  useEffect(() => {
    if (ipAddress) {
      reset({
        status: ipAddress.status,
        dnsName: ipAddress.dnsName ?? '',
      });
    }
  }, [ipAddress, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!ipAddress) return null;

  const onSubmit = async (formData: EditIpAddressFormData) => {
    await updateMutation.mutateAsync({
      params: { id: ipAddressId },
      body: {
        status: formData.status as 'ACTIVE' | 'RESERVED' | 'DEPRECATED' | 'DHCP',
        dnsName: formData.dnsName || null,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['ip-addresses'] });
    await queryClient.invalidateQueries({ queryKey: ['ip-address', ipAddressId] });
    navigate({ to: '/ipam/ip-addresses/$ipAddressId', params: { ipAddressId } });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Edit IP Address</CardTitle>
          <CardDescription>Update details for {ipAddress.address}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <FormSelect
              control={control}
              name="status"
              label="Status"
              options={statusOptions}
              placeholder="Select status"
            />
            <FormInput control={control} name="dnsName" label="DNS Name" description="Optional DNS name for this IP" />
            <div className="flex gap-2 pt-2">
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate({ to: '/ipam/ip-addresses/$ipAddressId', params: { ipAddressId } })}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <IpAddressGatewayCard ipAddressId={ipAddressId} address={ipAddress.address} vrfId={ipAddress.vrfId} />
    </div>
  );
}
