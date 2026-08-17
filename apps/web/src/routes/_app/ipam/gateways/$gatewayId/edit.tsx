import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { PrefixCombobox, VrfCombobox } from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';

const editGatewaySchema = z.object({
  prefixId: z.string().min(1, 'Prefix is required'),
  gatewayIpId: z.string().min(1, 'Gateway IP is required'),
  vrfId: z.string(),
  routingPriority: z.coerce.number().int(),
});

type EditGatewayFormData = z.infer<typeof editGatewaySchema>;

export const Route = createFileRoute('/_app/ipam/gateways/$gatewayId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditGatewayPage,
});

function EditGatewayPage() {
  const { gatewayId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getGateway.useQuery({
    queryKey: ['gateway', gatewayId],
    queryData: { params: { id: gatewayId } },
  });

  const updateMutation = tsr.updateGateway.useMutation({
    meta: { successMessage: 'Gateway updated' },
  });

  const gateway = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset, setValue } = useForm<EditGatewayFormData>({
    resolver: zodResolver(editGatewaySchema),
    defaultValues: { prefixId: '', gatewayIpId: '', vrfId: '', routingPriority: 0 },
  });

  useEffect(() => {
    if (gateway) {
      reset({
        prefixId: gateway.prefixId,
        gatewayIpId: gateway.gatewayIpId,
        vrfId: gateway.vrfId ?? '',
        routingPriority: gateway.routingPriority ?? 0,
      });
    }
  }, [gateway, reset]);

  const selectedPrefixId = useWatch({ control, name: 'prefixId' });
  const selectedGatewayIpId = useWatch({ control, name: 'gatewayIpId' });

  const { data: ipsData } = tsr.listIpsInPrefix.useQuery({
    queryKey: ['prefix', selectedPrefixId, 'ips'],
    queryData: { params: { id: selectedPrefixId } },
    enabled: !!selectedPrefixId,
  });

  useEffect(() => {
    if (selectedGatewayIpId && ipsData?.status === 200 && !ipsData.body.some((ip) => ip.id === selectedGatewayIpId)) {
      setValue('gatewayIpId', '');
    }
  }, [selectedGatewayIpId, ipsData, setValue]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!gateway) return null;

  const gatewayIpOptions =
    ipsData?.status === 200 ? ipsData.body.map((ip) => ({ label: ip.address, value: ip.id })) : [];

  const onSubmit = async (formData: EditGatewayFormData) => {
    await updateMutation.mutateAsync({
      params: { id: gatewayId },
      body: {
        gatewayIpId: formData.gatewayIpId,
        prefixId: formData.prefixId,
        vrfId: formData.vrfId === '' ? null : formData.vrfId,
        routingPriority: formData.routingPriority,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['gateways'] });
    await queryClient.invalidateQueries({ queryKey: ['gateway', gatewayId] });
    navigate({ to: '/ipam/gateways/$gatewayId', params: { gatewayId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Gateway</CardTitle>
        <CardDescription>Update details for this gateway</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <PrefixCombobox control={control} name="prefixId" />
          <FormSelect
            control={control}
            name="gatewayIpId"
            label="Gateway IP"
            options={gatewayIpOptions}
            placeholder={selectedPrefixId ? 'Select an IP address from this prefix' : 'Select a prefix first'}
            disabled={!selectedPrefixId}
            description="IP address in the selected prefix that acts as the default gateway."
          />
          <VrfCombobox control={control} name="vrfId" />
          <FormInput control={control} name="routingPriority" label="Routing Priority" type="number" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/ipam/gateways/$gatewayId', params: { gatewayId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
