import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { PrefixCombobox, VrfCombobox } from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';

const createGatewaySchema = z.object({
  prefixId: z.string().min(1, 'Prefix is required'),
  gatewayIpId: z.string().min(1, 'Gateway IP is required'),
  vrfId: z.string(),
  routingPriority: z.coerce.number().int(),
});

type CreateGatewayFormData = z.infer<typeof createGatewaySchema>;

export const Route = createFileRoute('/_app/ipam/gateways/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateGatewayPage,
});

function CreateGatewayPage() {
  useDocumentTitle('Create Gateway');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: createGateway, isPending } = tsr.createGateway.useMutation({
    meta: { successMessage: 'Gateway created' },
  });

  const { control, handleSubmit, setValue } = useForm<CreateGatewayFormData>({
    resolver: zodResolver(createGatewaySchema),
    defaultValues: {
      prefixId: '',
      gatewayIpId: '',
      vrfId: '',
      routingPriority: 0,
    },
  });

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

  const gatewayIpOptions =
    ipsData?.status === 200 ? ipsData.body.map((ip) => ({ label: ip.address, value: ip.id })) : [];

  const onSubmit = async (data: CreateGatewayFormData) => {
    await createGateway({
      body: {
        gatewayIpId: data.gatewayIpId,
        prefixId: data.prefixId,
        vrfId: data.vrfId === '' ? null : data.vrfId,
        routingPriority: data.routingPriority,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['gateways'] });
    navigate({ to: '/ipam/gateways' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Gateway Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Gateway'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/ipam/gateways' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
