import { zodResolver } from '@hookform/resolvers/zod';
import { BgpSessionStatusSchema } from '@repo/api-client';
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
import {
  AsnCombobox,
  BgpPeerGroupCombobox,
  DeviceCombobox,
  IpAddressCombobox,
  PrefixListCombobox,
} from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';
import { enumOptions } from '~/lib/enum-options';

const createSessionSchema = z.object({
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

type CreateSessionFormData = z.infer<typeof createSessionSchema>;

export const Route = createFileRoute('/_app/bgp/sessions/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateBgpSessionPage,
});

function CreateBgpSessionPage() {
  useDocumentTitle('Create BGP Session');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: createSession, isPending } = tsr.createBgpSession.useMutation({
    meta: { successMessage: 'BGP session created' },
  });

  const { control, handleSubmit } = useForm<CreateSessionFormData>({
    resolver: zodResolver(createSessionSchema),
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

  const onSubmit = async (data: CreateSessionFormData) => {
    await createSession({
      body: {
        name: data.name,
        status: data.status,
        description: data.description || undefined,
        deviceId: data.deviceId || undefined,
        localAsnId: data.localAsnId || undefined,
        remoteAsnId: data.remoteAsnId || undefined,
        localAddressId: data.localAddressId || undefined,
        remoteAddressId: data.remoteAddressId || undefined,
        peerGroupId: data.peerGroupId || undefined,
        prefixListInId: data.prefixListInId || undefined,
        prefixListOutId: data.prefixListOutId || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['bgp-sessions'] });
    navigate({ to: '/bgp/sessions' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>BGP Session Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="name" label="Name" />
            <FormSelect
              control={control}
              name="status"
              label="Status"
              options={enumOptions(BgpSessionStatusSchema)}
              placeholder="Select status"
            />
            <FormTextarea control={control} name="description" label="Description" />
            <DeviceCombobox control={control} name="deviceId" label="Device" />
            <AsnCombobox control={control} name="localAsnId" label="Local ASN" />
            <AsnCombobox control={control} name="remoteAsnId" label="Remote ASN" />
            <IpAddressCombobox control={control} name="localAddressId" label="Local address" />
            <IpAddressCombobox control={control} name="remoteAddressId" label="Remote address" />
            <BgpPeerGroupCombobox control={control} name="peerGroupId" label="Peer group" />
            <PrefixListCombobox control={control} name="prefixListInId" label="Prefix list (in)" />
            <PrefixListCombobox control={control} name="prefixListOutId" label="Prefix list (out)" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create BGP Session'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/bgp/sessions' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
