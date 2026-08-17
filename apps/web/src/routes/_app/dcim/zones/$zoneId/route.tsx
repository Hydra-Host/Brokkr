import { createFileRoute, Link, Outlet, useMatches } from '@tanstack/react-router';
import { Edit2Icon, Pencil, Plus } from 'lucide-react';

import type { Zone } from '@repo/api-client';

import { Button } from '@repo/ui/components/button';
import { ButtonLink } from '@repo/ui/components/button-link';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { TypewriterText } from '@repo/ui/components/typewriter-text';

import { usePermissions } from '~/hooks/use-permissions';
import { tsr } from '~/lib/api';

export class ZoneLoadError extends Error {
  constructor(readonly status: number) {
    super(`Failed to load zone (status ${status})`);
    this.name = 'ZoneLoadError';
  }
}

export function shouldRetryZoneLoad(failureCount: number, error: unknown): boolean {
  if (error instanceof ZoneLoadError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 3;
}

export const Route = createFileRoute('/_app/dcim/zones/$zoneId')({
  staticData: {
    breadcrumb: (data) => {
      const zone = data as Zone | undefined;
      return zone?.name ?? 'Zone';
    },
  },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['zone', params.zoneId],
      queryFn: async () => {
        const res = await tsr.getZoneById.query({ params: { zoneId: params.zoneId } });
        if (res.status !== 200) throw new ZoneLoadError(res.status);
        return res;
      },
      retry: shouldRetryZoneLoad,
      retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 3000),
    });
    return response.body;
  },
  component: ZoneLayout,
});

function ZoneLayout() {
  const { zoneId } = Route.useParams();
  const hideHeader = useMatches().some((m) => m.staticData?.hideZoneHeader);

  const { data, isPending } = tsr.getZoneById.useQuery({
    queryKey: ['zone', zoneId],
    queryData: { params: { zoneId } },
  });

  if (hideHeader) {
    return (
      <div className="space-y-6">
        <Outlet />
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <Skeleton className="h-8 w-48" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">Zone not found.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const zone = data.body;

  return (
    <div className="space-y-6">
      <ZoneHeader zone={zone} />
      <Outlet />
    </div>
  );
}

function ZoneHeader({ zone }: { zone: Zone }) {
  const { can } = usePermissions();
  const addr = zone.primaryAddress;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-2">
          <CardTitle className="text-2xl">
            <TypewriterText text={zone.name} />
          </CardTitle>
          <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span>ID: {zone.id}</span>
            {addr?.timezone && <span>Timezone: {addr.timezone}</span>}
            {addr?.latitude != null && addr?.longitude != null && (
              <span>
                Coords: {addr.latitude.toFixed(4)}, {addr.longitude.toFixed(4)}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {can('device', 'create') && (
            <ButtonLink size="sm" to="/dcim/zones/$zoneId/commission" params={{ zoneId: zone.id }}>
              <Plus className="mr-2 h-4 w-4" />
              Commission Servers
            </ButtonLink>
          )}
          <ButtonLink variant="outline" size="sm" to="/dcim/zones/$zoneId/edit" params={{ zoneId: zone.id }}>
            <Edit2Icon className="mr-2 h-4 w-4" />
            Edit
          </ButtonLink>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="border-border rounded-lg border p-4">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-medium">Primary Address</h4>
              <Button variant="ghost" size="sm" className="h-7 px-2" asChild>
                <Link to="/dcim/zones/$zoneId/primary-address-edit" params={{ zoneId: zone.id }}>
                  <Pencil className="mr-1 h-3 w-3" />
                  Edit
                </Link>
              </Button>
            </div>
            <p className="text-muted-foreground text-sm">
              {zone.primaryAddress?.formattedAddress || 'No address on file'}
            </p>
          </div>
          <div className="border-border rounded-lg border p-4">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-medium">Shipping Address</h4>
              <Button variant="ghost" size="sm" className="h-7 px-2" asChild>
                <Link to="/dcim/zones/$zoneId/shipping-address-edit" params={{ zoneId: zone.id }}>
                  <Pencil className="mr-1 h-3 w-3" />
                  Edit
                </Link>
              </Button>
            </div>
            <p className="text-muted-foreground text-sm">
              {zone.shippingAddress?.formattedAddress || 'Same as primary address'}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
