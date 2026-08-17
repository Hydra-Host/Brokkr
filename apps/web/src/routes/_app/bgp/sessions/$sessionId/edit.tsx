import { zodResolver } from '@hookform/resolvers/zod';
import { BgpSessionStatusSchema } from '@repo/api-client';
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
import {
  AsnCombobox,
  BgpPeerGroupCombobox,
  DeviceCombobox,
  IpAddressCombobox,
  PrefixListCombobox,
} from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';
import { enumOptions } from '~/lib/enum-options';

const editSessionSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  status: BgpSessionStatusSchema,
  description: z.string(),
  deviceId: z.string(),
  localAsnId: z.string(),
  remoteAsnId: z.string(),
  localAddressId: z.string(),
  remoteAddressId: z.string(),
  peerGroupId: z.string(),
  prefixListInId: z.string(),
  prefixListOutId: z.string(),
});

type EditSessionFormData = z.infer<typeof editSessionSchema>;

export const Route = createFileRoute('/_app/bgp/sessions/$sessionId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditBgpSessionPage,
});

function EditBgpSessionPage() {
  const { sessionId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getBgpSession.useQuery({
    queryKey: ['bgp-session', sessionId],
    queryData: { params: { id: sessionId } },
  });

  const updateMutation = tsr.updateBgpSession.useMutation({
    meta: { successMessage: 'BGP session updated' },
  });

  const session = data?.status === 200 ? data.body : null;

  const { data: deviceData } = tsr.getServerById.useQuery({
    queryKey: ['server', session?.deviceId],
    queryData: { params: { deviceId: session?.deviceId ?? '' } },
    enabled: !!session?.deviceId,
  });
  const { data: localAddressData } = tsr.getIpAddress.useQuery({
    queryKey: ['ip-address', session?.localAddressId],
    queryData: { params: { id: session?.localAddressId ?? '' } },
    enabled: !!session?.localAddressId,
  });
  const { data: remoteAddressData } = tsr.getIpAddress.useQuery({
    queryKey: ['ip-address', session?.remoteAddressId],
    queryData: { params: { id: session?.remoteAddressId ?? '' } },
    enabled: !!session?.remoteAddressId,
  });

  const deviceLabel = deviceData?.status === 200 ? (deviceData.body.name ?? deviceData.body.id) : undefined;
  const localAddressLabel = localAddressData?.status === 200 ? localAddressData.body.address : undefined;
  const remoteAddressLabel = remoteAddressData?.status === 200 ? remoteAddressData.body.address : undefined;

  const { control, handleSubmit, reset } = useForm<EditSessionFormData>({
    resolver: zodResolver(editSessionSchema),
    defaultValues: {
      name: '',
      status: 'ACTIVE',
      description: '',
      deviceId: '',
      localAsnId: '',
      remoteAsnId: '',
      localAddressId: '',
      remoteAddressId: '',
      peerGroupId: '',
      prefixListInId: '',
      prefixListOutId: '',
    },
  });

  useEffect(() => {
    if (session) {
      reset({
        name: session.name,
        status: session.status,
        description: session.description ?? '',
        deviceId: session.deviceId ?? '',
        localAsnId: session.localAsnId ?? '',
        remoteAsnId: session.remoteAsnId ?? '',
        localAddressId: session.localAddressId ?? '',
        remoteAddressId: session.remoteAddressId ?? '',
        peerGroupId: session.peerGroupId ?? '',
        prefixListInId: session.prefixListInId ?? '',
        prefixListOutId: session.prefixListOutId ?? '',
      });
    }
  }, [session, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!session) return null;

  const onSubmit = async (formData: EditSessionFormData) => {
    await updateMutation.mutateAsync({
      params: { id: sessionId },
      body: {
        name: formData.name,
        status: formData.status,
        description: formData.description || undefined,
        deviceId: formData.deviceId || undefined,
        localAsnId: formData.localAsnId || undefined,
        remoteAsnId: formData.remoteAsnId || undefined,
        localAddressId: formData.localAddressId || undefined,
        remoteAddressId: formData.remoteAddressId || undefined,
        peerGroupId: formData.peerGroupId || undefined,
        prefixListInId: formData.prefixListInId || undefined,
        prefixListOutId: formData.prefixListOutId || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['bgp-sessions'] });
    await queryClient.invalidateQueries({ queryKey: ['bgp-session', sessionId] });
    navigate({ to: '/bgp/sessions/$sessionId', params: { sessionId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit BGP Session</CardTitle>
        <CardDescription>Update details for {session.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="name" label="Name" />
          <FormSelect
            control={control}
            name="status"
            label="Status"
            options={enumOptions(BgpSessionStatusSchema)}
            placeholder="Select status"
          />
          <FormTextarea control={control} name="description" label="Description" />
          <DeviceCombobox
            control={control}
            name="deviceId"
            label="Device"
            seedOption={
              session.deviceId ? { value: session.deviceId, label: deviceLabel ?? session.deviceId } : undefined
            }
          />
          <AsnCombobox control={control} name="localAsnId" label="Local ASN" />
          <AsnCombobox control={control} name="remoteAsnId" label="Remote ASN" />
          <IpAddressCombobox
            control={control}
            name="localAddressId"
            label="Local address"
            seedOption={
              session.localAddressId
                ? { value: session.localAddressId, label: localAddressLabel ?? session.localAddressId }
                : undefined
            }
          />
          <IpAddressCombobox
            control={control}
            name="remoteAddressId"
            label="Remote address"
            seedOption={
              session.remoteAddressId
                ? { value: session.remoteAddressId, label: remoteAddressLabel ?? session.remoteAddressId }
                : undefined
            }
          />
          <BgpPeerGroupCombobox control={control} name="peerGroupId" label="Peer group" />
          <PrefixListCombobox control={control} name="prefixListInId" label="Prefix list (in)" />
          <PrefixListCombobox control={control} name="prefixListOutId" label="Prefix list (out)" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/bgp/sessions/$sessionId', params: { sessionId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
