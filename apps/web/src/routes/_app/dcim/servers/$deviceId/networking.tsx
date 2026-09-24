import { DeviceNetplanQuerySchema, type NetplanPhase } from '@repo/api-client';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/components/tabs';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { z } from 'zod';
import { DeviceInterfaces } from '~/components/device-interfaces';
import { DeviceNetplanContent } from '~/components/device-netplan-content';
import { MobileTabSelect } from '~/components/mobile-tab-select';

const parentRoute = getRouteApi('/_app/dcim/servers/$deviceId');

const NetworkingTabSchema = z.enum(['interfaces', 'netplan']);
const TAB_NAMES: Record<z.infer<typeof NetworkingTabSchema>, string> = {
  interfaces: 'Interfaces',
  netplan: 'Netplan',
};

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/networking')({
  validateSearch: DeviceNetplanQuerySchema.extend({ tab: NetworkingTabSchema.optional() }),
  staticData: { breadcrumb: 'Networking' },
  component: ServerNetworking,
});

function ServerNetworking() {
  const device = parentRoute.useLoaderData();
  const { tab = 'interfaces', phase } = Route.useSearch();
  const navigate = Route.useNavigate();
  useDocumentTitle(`${device.dcim?.nickname || device.name} - Networking`);

  const selectTab = (value: string) => {
    void navigate({ search: (previous) => ({ ...previous, tab: NetworkingTabSchema.parse(value) }), replace: true });
  };
  const changePhase = (nextPhase: NetplanPhase) => {
    void navigate({ search: (previous) => ({ ...previous, phase: nextPhase }), replace: true });
  };

  return (
    <div>
      <MobileTabSelect
        tabs={NetworkingTabSchema.options.map((value) => ({ name: TAB_NAMES[value], value }))}
        value={tab}
        onValueChange={selectTab}
      />
      <Tabs value={tab} onValueChange={(value) => selectTab(String(value))} className="w-full">
        <div className="hidden sm:block">
          <TabsList className="mb-4">
            {NetworkingTabSchema.options.map((value) => (
              <TabsTrigger key={value} value={value}>
                {TAB_NAMES[value]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="interfaces">
          <DeviceInterfaces
            deviceId={device.id}
            description="Server network interface configuration"
            emptyDescription="No network interfaces are configured for this server."
          />
        </TabsContent>
        <TabsContent value="netplan">
          <DeviceNetplanContent deviceId={device.id} phase={phase} onPhaseChange={changePhase} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
