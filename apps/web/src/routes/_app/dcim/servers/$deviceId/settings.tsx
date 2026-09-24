import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { IpxeBuildTargetSchema, type Server } from '@repo/api-client';
import { ServerPriceForm, type ServerPriceFormSubmitData } from '@repo/domain-ui/form/server-price-form';
import { Label } from '@repo/ui/components/label';
import { Switch } from '@repo/ui/components/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/components/tabs';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { DecommissionedServerOverlay } from '~/components/decommissioned-server-overlay';
import { MobileTabSelect } from '~/components/mobile-tab-select';
import { tsr } from '~/lib/api';
import { BRAND_NAME } from '~/lib/branding';
import { ipxeTargetOptions } from '~/lib/enum-options';
import { DecommissionSection } from './-settings-decommission';

const parentRoute = getRouteApi('/_app/dcim/servers/$deviceId');

const SettingsTabSchema = z.enum(['settings', 'monetization', 'decommission']);
const TAB_NAMES: Record<z.infer<typeof SettingsTabSchema>, string> = {
  settings: 'Server Info',
  monetization: 'Monetization',
  decommission: 'Decommission',
};

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/settings')({
  validateSearch: z.object({ tab: SettingsTabSchema.optional() }),
  staticData: { breadcrumb: 'Settings' },
  component: ServerSettingsPage,
});

const serverInfoSchema = z.object({
  nickname: z.string().optional(),
  ipxeBuildTarget: z.union([z.literal(''), IpxeBuildTargetSchema]).optional(),
});

type ServerInfoFormData = z.infer<typeof serverInfoSchema>;

const IPXE_TARGET_OPTIONS = ipxeTargetOptions('Inherit from prefix (default)');

function ServerSettingsPage() {
  const device = parentRoute.useLoaderData();
  const params = Route.useParams();
  const { tab = 'settings' } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();

  useDocumentTitle('Settings');

  const selectTab = (value: string) => {
    void navigate({ search: (previous) => ({ ...previous, tab: SettingsTabSchema.parse(value) }), replace: true });
  };

  return (
    <div className="relative">
      <DecommissionedServerOverlay deletedAt={device.deletedAt} />
      <MobileTabSelect
        tabs={SettingsTabSchema.options.map((value) => ({ name: TAB_NAMES[value], value }))}
        value={tab}
        onValueChange={selectTab}
      />
      <Tabs value={tab} onValueChange={(value) => selectTab(String(value))} className="w-full">
        <div className="hidden sm:block">
          <TabsList className="mb-4">
            {SettingsTabSchema.options.map((value) => (
              <TabsTrigger key={value} value={value}>
                {TAB_NAMES[value]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="settings">
          <ServerInfoTab device={device} deviceId={params.deviceId} queryClient={queryClient} router={router} />
        </TabsContent>
        <TabsContent value="monetization">
          <MonetizationTab device={device} deviceId={params.deviceId} queryClient={queryClient} router={router} />
        </TabsContent>
        <TabsContent value="decommission">
          <DecommissionSection device={device} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ServerInfoTab({
  device,
  deviceId,
  queryClient,
  router,
}: {
  device: Server;
  deviceId: string;
  queryClient: ReturnType<typeof useQueryClient>;
  router: ReturnType<typeof useRouter>;
}) {
  const [ecoMode, setEcoMode] = useState(device.ecoMode);
  const [originalEcoMode] = useState(device.ecoMode);

  const form = useForm<ServerInfoFormData>({
    resolver: zodResolver(serverInfoSchema),
    defaultValues: {
      nickname: device.dcim?.nickname ?? '',
      ipxeBuildTarget: device.ipxeBuildTarget ?? '',
    },
  });

  const { mutateAsync: updateDeviceInfo, isPending } = tsr.updateServerInfo.useMutation({
    meta: { successMessage: 'Settings updated' },
  });

  const currentNickname = form.watch('nickname');
  const currentIpxeTarget = form.watch('ipxeBuildTarget');
  const originalIpxeTarget = device.ipxeBuildTarget ?? '';
  const hasChanges = useMemo(() => {
    return (
      currentNickname !== (device.dcim?.nickname ?? '') ||
      ecoMode !== originalEcoMode ||
      currentIpxeTarget !== originalIpxeTarget
    );
  }, [currentNickname, device.dcim?.nickname, ecoMode, originalEcoMode, currentIpxeTarget, originalIpxeTarget]);

  const handleSubmit = async (data: ServerInfoFormData) => {
    // '' (inherit) and undefined both map to null; any valid target passes through.
    const ipxeBuildTarget = data.ipxeBuildTarget || null;
    const ipxeChanged = (data.ipxeBuildTarget ?? '') !== originalIpxeTarget;
    await updateDeviceInfo({
      params: { deviceId },
      body: {
        nickname: data.nickname,
        ecoMode,
        ...(ipxeChanged ? { ipxeBuildTarget } : {}),
      },
    });

    queryClient.removeQueries({ queryKey: ['server', deviceId] });
    await router.invalidate();
  };

  return (
    <div className="my-8 space-y-10">
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-10">
        <div className="grid max-w-3xl grid-cols-1 gap-x-8 gap-y-10 md:grid-cols-3">
          <div>
            <h2 className="text-base leading-7 font-semibold">Internal Information</h2>
            <p className="text-muted-foreground mt-1 text-sm leading-6">
              Server information viewable only by members of your organization.
            </p>
          </div>
          <div className="md:col-span-2">
            <div className="max-w-sm">
              <FormInput control={form.control} name="nickname" label="Nickname" placeholder="Enter Nickname" />
            </div>
          </div>
        </div>

        <div className="grid max-w-3xl grid-cols-1 gap-x-8 gap-y-10 md:grid-cols-3">
          <div>
            <h2 className="text-base leading-7 font-semibold">iPXE Boot Target</h2>
            <p className="text-muted-foreground mt-1 text-sm leading-6">
              Per-device PXE boot firmware override. Inherit uses the prefix or system default.
            </p>
          </div>
          <div className="md:col-span-2">
            <div className="max-w-sm">
              <FormSelect
                control={form.control}
                name="ipxeBuildTarget"
                label="Boot target"
                options={IPXE_TARGET_OPTIONS}
                clearable
                placeholder="Inherit from prefix (default)"
              />
            </div>
          </div>
        </div>

        <div className="grid max-w-3xl grid-cols-1 gap-x-8 gap-y-10 md:grid-cols-3">
          <div>
            <h2 className="text-base leading-7 font-semibold">Eco Mode</h2>
            <p className="text-muted-foreground mt-1 text-sm leading-6">
              When Eco Mode is enabled, machines with unrented status (Inventory) will be automatically powered off to
              save energy.
            </p>
          </div>
          <div className="md:col-span-2">
            <div className="flex items-center gap-2">
              <Switch checked={ecoMode} onCheckedChange={setEcoMode} />
              <Label>Eco Mode Enabled</Label>
            </div>
          </div>
        </div>

        <div className="flex max-w-3xl justify-end">
          <FormSubmitButton pending={isPending} disabled={!hasChanges}>
            Save
          </FormSubmitButton>
        </div>
      </form>
    </div>
  );
}

function MonetizationTab({
  device,
  deviceId,
  queryClient,
  router,
}: {
  device: Server;
  deviceId: string;
  queryClient: ReturnType<typeof useQueryClient>;
  router: ReturnType<typeof useRouter>;
}) {
  const { mutateAsync: updateListing, isPending } = tsr.updateServerListing.useMutation({
    meta: { successMessage: 'Server monetization updated successfully' },
  });

  const handleSubmit = async (data: ServerPriceFormSubmitData) => {
    await updateListing({
      params: { deviceId },
      body: data,
    });

    queryClient.removeQueries({ queryKey: ['server', deviceId] });
    await router.invalidate();
  };

  return (
    <div className="my-8">
      <div className="grid max-w-3xl grid-cols-1 gap-x-8 gap-y-10 md:grid-cols-3">
        <div>
          <h2 className="text-base leading-7 font-semibold">Listing Information</h2>
          <p className="text-muted-foreground mt-1 text-sm leading-6">
            Modify the public listing of your device on {BRAND_NAME}.
          </p>
        </div>
        <div className="md:col-span-2">
          <ServerPriceForm devices={[device]} onSubmit={handleSubmit} isPending={isPending} />
        </div>
      </div>
    </div>
  );
}
