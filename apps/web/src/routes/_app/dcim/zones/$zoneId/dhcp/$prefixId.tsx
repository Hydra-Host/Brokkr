import type { DhcpReservation, IpRange, PrefixDhcpServing } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@repo/ui/components/table';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PrefixDhcpConfigCard } from '~/components/prefix-dhcp-config-card';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/zones/$zoneId/dhcp/$prefixId')({
  staticData: { breadcrumb: 'DHCP' },
  component: ZoneDhcpDetail,
});

// URL zone-ownership guard (security): the prefix must belong to the URL zone, or the page renders a
// DHCP admin view under the wrong zone (cross-zone access); a zoneless prefix never matches.
export function prefixBelongsToZone(prefixZoneId: string | null, urlZoneId: string): boolean {
  return prefixZoneId !== null && prefixZoneId === urlZoneId;
}

export function isPrefixLoadError(status: number | undefined, isError: boolean): boolean {
  return isError || (status !== undefined && status !== 200 && status !== 404);
}

function ZoneDhcpDetail() {
  const { prefixId, zoneId } = Route.useParams();

  const {
    data: prefixData,
    isPending: isPrefixLoading,
    isError: isPrefixError,
  } = tsr.getPrefix.useQuery({
    queryKey: ['prefix', prefixId],
    queryData: { params: { id: prefixId } },
  });

  const prefix =
    prefixData?.status === 200 && prefixBelongsToZone(prefixData.body.zoneId, zoneId) ? prefixData.body : null;
  const isLoadError = isPrefixLoadError(prefixData?.status, isPrefixError);

  if (isPrefixLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-64" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (isLoadError) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-destructive">Failed to load this prefix. Try refreshing the page.</p>
        </CardContent>
      </Card>
    );
  }

  if (!prefix) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-muted-foreground">Prefix not found.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm">
        <Link to="/dcim/zones/$zoneId" params={{ zoneId }} className="text-muted-foreground hover:text-foreground">
          Zone
        </Link>
        <span className="text-muted-foreground">/</span>
        <span>
          DHCP — <span className="font-mono">{prefix.prefix}</span>
        </span>
      </div>

      {/* Policy section: DHCP config + derived serving + IP ranges */}
      <PrefixDhcpConfigCard prefixId={prefixId} />
      <DerivedServingCard prefixId={prefixId} />
      <IpRangesCard prefixId={prefixId} />

      {/* Bottom: reservations (left) and leases (right) */}
      <div className="grid gap-6 lg:grid-cols-2">
        <ReservationsCard prefixId={prefixId} />
        <PrefixDhcpLeasesCard prefixId={prefixId} />
      </div>
    </div>
  );
}

// ─── Derived serving info (read-only) ───────────────────────────────────

function DerivedServingCard({ prefixId }: { prefixId: string }) {
  const { data, isPending } = tsr.getPrefixDhcpServing.useQuery({
    queryKey: ['prefix', prefixId, 'dhcp-serving'],
    queryData: { params: { id: prefixId } },
  });

  const serving: PrefixDhcpServing | null = data?.status === 200 ? data.body : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Derived Serving Info</CardTitle>
        <CardDescription>
          Read-only values derived by the bridge from zone topology. These cannot be edited directly.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : !serving ? (
          // serving is null on any non-200 / fetch error — the sole failure branch (no separate
          // loadFailed to make it redundant); the else narrows serving non-null.
          <p className="text-destructive text-sm">Failed to load serving info.</p>
        ) : (
          <div className="space-y-2">
            <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
              <span className="text-muted-foreground text-sm">Next server (TFTP)</span>
              <span className="text-sm font-medium">
                {serving.nextServer ? (
                  <span className="font-mono">{serving.nextServer}</span>
                ) : (
                  <span className="text-muted-foreground">--</span>
                )}
              </span>
            </div>
            <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
              <span className="text-muted-foreground text-sm">DNS servers</span>
              <span className="text-sm font-medium">
                {serving.dnsServers.length > 0 ? (
                  <span className="font-mono">{serving.dnsServers.join(', ')}</span>
                ) : (
                  <span className="text-muted-foreground">--</span>
                )}
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── IP ranges (display-only with link to IPAM management) ──────────────

function IpRangesCard({ prefixId }: { prefixId: string }) {
  const { data, isPending } = tsr.listIpRanges.useQuery({
    queryKey: ['ip-ranges', { prefixId }],
    queryData: { query: { prefixId } },
  });

  const loadFailed = !isPending && (!data || data.status !== 200);
  const ranges: IpRange[] = data?.status === 200 ? data.body : [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle>IP Ranges</CardTitle>
          <CardDescription>Address ranges within this prefix used for DHCP allocation.</CardDescription>
        </div>
        <Link
          to="/ipam/prefixes/$prefixId"
          params={{ prefixId }}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm"
        >
          Manage in IPAM
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : loadFailed ? (
          <p className="text-destructive text-sm">Failed to load IP ranges.</p>
        ) : ranges.length === 0 ? (
          <p className="text-muted-foreground text-sm">No IP ranges defined for this prefix.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Start</TableHead>
                <TableHead>End</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Purpose</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ranges.map((range) => (
                <TableRow key={range.id}>
                  <TableCell className="font-mono">{range.start}</TableCell>
                  <TableCell className="font-mono">{range.end}</TableCell>
                  <TableCell>
                    <Badge variant={range.status === 'ACTIVE' ? 'default' : 'outline'}>{range.status}</Badge>
                  </TableCell>
                  <TableCell>{range.purpose ?? <span className="text-muted-foreground">--</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Reservations (read-only with device/interface links) ───────────────

function ReservationsCard({ prefixId }: { prefixId: string }) {
  const { data, isPending } = tsr.getPrefixDhcpReservations.useQuery({
    queryKey: ['prefix', prefixId, 'dhcp-reservations'],
    queryData: { params: { id: prefixId } },
  });

  const loadFailed = !isPending && (!data || data.status !== 200);
  const reservations: DhcpReservation[] = data?.status === 200 ? data.body : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reservations</CardTitle>
        <CardDescription>Static DHCP reservations derived from device interface addresses.</CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : loadFailed ? (
          <p className="text-destructive text-sm">Failed to load reservations.</p>
        ) : reservations.length === 0 ? (
          <p className="text-muted-foreground text-sm">No DHCP reservations for this prefix.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>MAC</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Hostname</TableHead>
                <TableHead>iPXE Target</TableHead>
                <TableHead>Links</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reservations.map((r) => (
                <TableRow key={r.mac}>
                  <TableCell className="font-mono">{r.mac}</TableCell>
                  <TableCell className="font-mono">{r.ip}</TableCell>
                  <TableCell>{r.hostname ?? <span className="text-muted-foreground">--</span>}</TableCell>
                  <TableCell>{r.ipxeBuildTarget ?? <span className="text-muted-foreground">--</span>}</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Link
                        to="/dcim/servers/$deviceId"
                        params={{ deviceId: r.deviceId }}
                        className="text-muted-foreground hover:text-foreground text-xs underline"
                      >
                        Device
                      </Link>
                      <Link
                        to="/dcim/interfaces/$interfaceId"
                        params={{ interfaceId: r.interfaceId }}
                        className="text-muted-foreground hover:text-foreground text-xs underline"
                      >
                        Interface
                      </Link>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ─── DHCP leases (live bridge state) ─────────────────────────────────────

/** Format an epoch-seconds expiry as a short relative string (leases are short-lived). */
function formatExpiry(expiresAtSeconds: number, nowSeconds: number): string {
  const deltaSec = Math.round(expiresAtSeconds - nowSeconds);
  if (deltaSec <= 0) return 'expired';
  if (deltaSec < 60) return `in ${deltaSec}s`;
  if (deltaSec < 3600) return `in ${Math.round(deltaSec / 60)}m`;
  return `in ${Math.round(deltaSec / 3600)}h`;
}

/** Ticks once per second so relative-time strings stay fresh between data refetches. */
function useClockSeconds(): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function PrefixDhcpLeasesCard({ prefixId }: { prefixId: string }) {
  const nowSeconds = useClockSeconds();

  const { data, isPending } = tsr.getPrefixDhcpLeases.useQuery({
    queryKey: ['prefix-dhcp-leases', prefixId],
    queryData: { params: { id: prefixId } },
    // Leases are live bridge state and expire on a ~10-minute TTL; keep the view fresh.
    refetchInterval: 30_000,
  });

  const loadFailed = !isPending && (!data || data.status !== 200);
  const leases = data?.status === 200 ? data.body : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>DHCP Leases</CardTitle>
        <CardDescription>
          Active leases the zone&apos;s bridge currently holds for addresses in this prefix.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : loadFailed ? (
          <p className="text-destructive text-sm">Couldn&apos;t load DHCP leases. Refresh to retry.</p>
        ) : leases.length === 0 ? (
          <p className="text-muted-foreground text-sm">No active DHCP leases.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>IP</TableHead>
                <TableHead>MAC</TableHead>
                <TableHead>Hostname</TableHead>
                <TableHead>Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leases.map((lease) => (
                <TableRow key={`${lease.ip}-${lease.mac}`}>
                  <TableCell className="font-mono">{lease.ip}</TableCell>
                  <TableCell className="font-mono">{lease.mac}</TableCell>
                  <TableCell>{lease.hostname ?? <span className="text-muted-foreground">--</span>}</TableCell>
                  <TableCell title={new Date(lease.expiresAt * 1000).toLocaleString()}>
                    {formatExpiry(lease.expiresAt, nowSeconds)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
