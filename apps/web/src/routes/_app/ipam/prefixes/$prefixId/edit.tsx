import { zodResolver } from '@hookform/resolvers/zod';
import { IpamRoleSchema, PrefixStatusSchema } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormSelect } from '@repo/ui/form/form-select';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PrefixRoleCombobox, VrfCombobox, ZoneCombobox } from '~/components/fk-comboboxes';
import { PrefixDhcpConfigCard } from '~/components/prefix-dhcp-config-card';
import { PrefixDnsConfigCard } from '~/components/prefix-dns-config-card';
import { tsr } from '~/lib/api';
import { VRRP_QUERY_KEY } from '~/routes/_app/dcim/zones/$zoneId/index';

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

const editPrefixSchema = z.object({
  status: PrefixStatusSchema,
  isPool: z.boolean(),
  role: IpamRoleSchema.or(z.literal('')),
  zoneId: z.string(),
  vrfId: z.string(),
  prefixRoleId: z.string(),
  gatewayIpId: z.string(),
  enableVlanTag: z.boolean(),
});

type EditPrefixFormData = z.infer<typeof editPrefixSchema>;

export function resolveGatewaySelection(
  selectedIpId: string,
  currentGatewayIpId: string | null,
): { gatewayIpId: string | null; needsValidation: boolean } {
  return {
    gatewayIpId: selectedIpId === '' ? null : selectedIpId,
    needsValidation: selectedIpId !== '' && selectedIpId !== currentGatewayIpId,
  };
}

const vrrpSchema = z.object({
  vrrpVipId: z.string().min(1, 'Select an IP address'),
  bindings: z.array(z.object({ bridgeId: z.string(), iface: z.string() })),
});

type VrrpFormData = z.infer<typeof vrrpSchema>;

export const Route = createFileRoute('/_app/ipam/prefixes/$prefixId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditPrefixPage,
});

function EditPrefixPage() {
  const { prefixId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getPrefix.useQuery({
    queryKey: ['prefix', prefixId],
    queryData: { params: { id: prefixId } },
  });

  const updateMutation = tsr.updatePrefix.useMutation({
    meta: { successMessage: 'Prefix updated' },
  });
  const validateGatewayMutation = tsr.validatePrefixGateway.useMutation();

  const { data: ipsData } = tsr.listIpsInPrefix.useQuery({
    queryKey: ['prefix', prefixId, 'ips'],
    queryData: { params: { id: prefixId } },
  });

  const prefix = data?.status === 200 ? data.body : null;

  const { data: zoneData } = tsr.getZoneById.useQuery({
    queryKey: ['zone', prefix?.zoneId],
    queryData: { params: { zoneId: prefix?.zoneId ?? '' } },
    enabled: !!prefix?.zoneId,
  });
  const zoneSeed = zoneData?.status === 200 ? { value: zoneData.body.id, label: zoneData.body.name } : undefined;

  const { control, handleSubmit, reset } = useForm<EditPrefixFormData>({
    resolver: zodResolver(editPrefixSchema),
    defaultValues: {
      status: 'ACTIVE',
      isPool: false,
      role: '',
      zoneId: '',
      vrfId: '',
      prefixRoleId: '',
      gatewayIpId: '',
      enableVlanTag: false,
    },
  });

  useEffect(() => {
    if (prefix) {
      reset({
        status: prefix.status,
        isPool: prefix.isPool,
        role: prefix.role ?? '',
        zoneId: prefix.zoneId ?? '',
        vrfId: prefix.vrfId ?? '',
        prefixRoleId: prefix.prefixRoleId ?? '',
        gatewayIpId: prefix.gatewayIpId ?? '',
        enableVlanTag: prefix.enableVlanTag,
      });
    }
  }, [prefix, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!prefix) return null;

  const gatewayOptions = [
    { label: 'None', value: '' },
    ...(ipsData?.status === 200 ? ipsData.body.map((ip) => ({ label: ip.address, value: ip.id })) : []),
  ];

  const onSubmit = async (formData: EditPrefixFormData) => {
    const oldZoneId = prefix.zoneId;
    const newZoneId = formData.zoneId === '' ? null : formData.zoneId;
    const gateway = resolveGatewaySelection(formData.gatewayIpId, prefix.gatewayIpId);

    if (gateway.needsValidation) {
      const validation = await validateGatewayMutation.mutateAsync({
        body: { prefixId, gatewayIpId: formData.gatewayIpId },
      });
      if (!(validation.status === 200 && validation.body.valid)) {
        toast.error(
          validation.status === 200
            ? (validation.body.reason ?? 'This IP address cannot be the prefix gateway.')
            : 'Failed to validate gateway.',
        );
        return;
      }
    }

    await updateMutation.mutateAsync({
      params: { id: prefixId },
      body: {
        status: formData.status,
        isPool: formData.isPool,
        role: formData.role === '' ? null : formData.role,
        zoneId: newZoneId,
        vrfId: formData.vrfId === '' ? null : formData.vrfId,
        prefixRoleId: formData.prefixRoleId === '' ? null : formData.prefixRoleId,
        gatewayIpId: gateway.gatewayIpId,
        enableVlanTag: formData.enableVlanTag,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['prefixes'] });
    await queryClient.invalidateQueries({ queryKey: ['prefix', prefixId] });
    if (oldZoneId) await queryClient.invalidateQueries({ queryKey: VRRP_QUERY_KEY(oldZoneId) });
    if (newZoneId && newZoneId !== oldZoneId)
      await queryClient.invalidateQueries({ queryKey: VRRP_QUERY_KEY(newZoneId) });
    navigate({ to: '/ipam/prefixes/$prefixId', params: { prefixId } });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Edit Prefix</CardTitle>
          <CardDescription>Update details for {prefix.prefix}</CardDescription>
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
              seedOption={zoneSeed}
              description="Assigning a zone lets this subnet advertise a VRRP floating IP to that zone's bridges."
            />
            <VrfCombobox control={control} name="vrfId" />
            <PrefixRoleCombobox control={control} name="prefixRoleId" />
            <FormSelect
              control={control}
              name="gatewayIpId"
              label="Gateway"
              options={gatewayOptions}
              placeholder="Select a gateway IP address"
              description="Default gateway for this subnet. DHCP routers derive solely from this assignment — without a gateway, DHCP clients (including netbooting devices) get no default route."
            />
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
            <div className="flex gap-2 pt-2">
              <Button type="submit" disabled={updateMutation.isPending || validateGatewayMutation.isPending}>
                {updateMutation.isPending || validateGatewayMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate({ to: '/ipam/prefixes/$prefixId', params: { prefixId } })}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <VrrpVipCard prefixId={prefixId} currentVrrpVipId={prefix.vrrpVipId} zoneId={prefix.zoneId} />

      <PrefixDhcpConfigCard prefixId={prefixId} />

      <PrefixDnsConfigCard prefixId={prefixId} />
    </div>
  );
}

function VrrpVipCard({
  prefixId,
  currentVrrpVipId,
  zoneId,
}: {
  prefixId: string;
  currentVrrpVipId: string | null;
  zoneId: string | null;
}) {
  const hasZone = zoneId !== null;
  const queryClient = useQueryClient();

  const { data: ipsData } = tsr.listIpsInPrefix.useQuery({
    queryKey: ['prefix', prefixId, 'ips'],
    queryData: { params: { id: prefixId } },
    enabled: hasZone,
  });

  const { data: bridgesData } = tsr.getBridges.useQuery({
    queryKey: ['bridges', zoneId],
    queryData: { query: { pageSize: 100, zoneId: zoneId ?? undefined } },
    enabled: hasZone,
  });

  const { data: bindingsData } = tsr.getPrefixVrrpBindings.useQuery({
    queryKey: ['prefix', prefixId, 'vrrp-bindings'],
    queryData: { params: { id: prefixId } },
    enabled: hasZone,
  });

  const setMutation = tsr.setPrefixVrrpVip.useMutation({ meta: { successMessage: 'VRRP VIP set' } });
  const clearMutation = tsr.clearPrefixVrrpVip.useMutation({ meta: { successMessage: 'VRRP VIP cleared' } });

  const { control, handleSubmit, reset, setValue } = useForm<VrrpFormData>({
    resolver: zodResolver(vrrpSchema),
    defaultValues: { vrrpVipId: '', bindings: [] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'bindings' });
  const watchedBindings = useWatch({ control, name: 'bindings' }) ?? [];

  const zoneBridges = bridgesData?.status === 200 ? bridgesData.body.data : [];
  const bridgeById = new Map(zoneBridges.map((bridge) => [bridge.id, bridge]));

  useEffect(() => {
    const current = bindingsData?.status === 200 ? bindingsData.body : [];
    reset({
      vrrpVipId: currentVrrpVipId ?? '',
      bindings: current.map((binding) => ({ bridgeId: binding.bridgeId, iface: binding.iface })),
    });
  }, [currentVrrpVipId, bindingsData, reset]);

  const ipOptions = ipsData?.status === 200 ? ipsData.body.map((ip) => ({ label: ip.address, value: ip.id })) : [];

  const bridgeOptionsFor = (index: number) => {
    const chosenElsewhere = new Set(
      watchedBindings.map((b, i) => (i === index ? '' : b?.bridgeId)).filter((id): id is string => Boolean(id)),
    );
    const own = watchedBindings[index]?.bridgeId ?? '';
    return zoneBridges
      .filter((bridge) => !chosenElsewhere.has(bridge.id) || bridge.id === own)
      .map((bridge) => ({ label: bridge.name, value: bridge.id }));
  };

  const ifaceOptionsFor = (index: number) => {
    const bridge = bridgeById.get(watchedBindings[index]?.bridgeId ?? '');
    return (bridge?.interfaces ?? []).map((iface) => {
      const ip = iface.ip_addresses?.[0]?.address ?? '';
      return { label: ip ? `${iface.name} (${ip})` : iface.name, value: iface.name };
    });
  };

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['prefix', prefixId] }),
      zoneId ? queryClient.invalidateQueries({ queryKey: VRRP_QUERY_KEY(zoneId) }) : Promise.resolve(),
    ]);
  };

  const onSubmit = async (formData: VrrpFormData) => {
    const hasHalfFilledRow = formData.bindings.some((binding) => (binding.bridgeId === '') !== (binding.iface === ''));
    if (hasHalfFilledRow) {
      toast.error('Each bridge binding needs both a bridge and an interface (or remove the row).');
      return;
    }
    const bindings = formData.bindings.filter((binding) => binding.bridgeId !== '' && binding.iface !== '');
    await setMutation.mutateAsync({
      params: { id: prefixId },
      body: { vrrpVipId: formData.vrrpVipId, bindings },
    });
    await invalidate();
  };

  const onClear = async () => {
    await clearMutation.mutateAsync({ params: { id: prefixId } });
    reset({ vrrpVipId: '', bindings: [] });
    await invalidate();
  };

  const pending = setMutation.isPending || clearMutation.isPending;
  const canAddBridge = hasZone && fields.length < zoneBridges.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>VRRP Virtual IP</CardTitle>
        <CardDescription>
          Floating IP the active bridge binds for this subnet — gives DHCP/DNS/TFTP/HTTP clients a stable address across
          bridge failover. Add the zone bridges that should hold it (typically the failover pair) and pick each
          one&apos;s NIC. Requires the prefix to be assigned to a zone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormSelect
            control={control}
            name="vrrpVipId"
            label="Virtual IP address"
            options={ipOptions}
            placeholder={hasZone ? 'Select an IP address from this subnet' : 'Assign this prefix to a zone first'}
            disabled={!hasZone}
          />

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Bridge bindings</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canAddBridge}
                onClick={() => append({ bridgeId: '', iface: '' })}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add bridge
              </Button>
            </div>

            {fields.length === 0 && (
              <p className="text-muted-foreground text-sm">
                {hasZone
                  ? 'No bridges bound yet — add one to advertise the VIP on it.'
                  : 'Assign this prefix to a zone first.'}
              </p>
            )}

            {fields.map((field, index) => (
              <div key={field.id} className="flex items-end gap-2 rounded-lg border p-3">
                <div className="grid flex-1 grid-cols-2 gap-3">
                  <FormSelect
                    control={control}
                    name={`bindings.${index}.bridgeId`}
                    label="Bridge"
                    options={bridgeOptionsFor(index)}
                    placeholder="Select a bridge"
                    onValueChange={() => setValue(`bindings.${index}.iface`, '')}
                    disabled={!hasZone}
                  />
                  <FormSelect
                    control={control}
                    name={`bindings.${index}.iface`}
                    label="Interface"
                    options={ifaceOptionsFor(index)}
                    placeholder={watchedBindings[index]?.bridgeId ? 'Select a NIC' : 'Pick a bridge first'}
                    disabled={!hasZone || !watchedBindings[index]?.bridgeId}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => remove(index)}
                  aria-label="Remove bridge binding"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>

          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={pending || !hasZone}>
              {pending ? 'Saving...' : 'Save'}
            </Button>
            {currentVrrpVipId && (
              <Button type="button" variant="outline" onClick={onClear} disabled={pending}>
                Clear
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
