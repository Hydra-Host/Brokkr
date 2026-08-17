import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import {
  AlertTriangle,
  Check,
  Clipboard,
  Crown,
  Database,
  KeyRound,
  MoreHorizontal,
  Network,
  Plus,
  Radio,
  Shield,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type {
  ZoneBridge,
  ZoneContact,
  ZoneDhcpPrefixSummary,
  ZoneRedisCredential,
  ZoneRegistrationTokenMetadata,
  ZoneVrrpPrefixSummary,
} from '@repo/api-client';

import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/components/alert-dialog';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { DataTable } from '@repo/ui/components/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { Skeleton } from '@repo/ui/components/skeleton';
import { Switch } from '@repo/ui/components/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/components/tooltip';

import { ZoneRedisCredentialDialog } from '@repo/ui/components/zone-redis-credential-dialog';
import { useCopyToClipboard } from '@repo/ui/hooks/use-copy-to-clipboard';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';
import { formatPhoneNumber } from '@repo/utils';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/zones/$zoneId/')({
  staticData: { breadcrumb: 'Overview' },
  component: ZoneOverview,
});

const contactColumns: ServerColumnDef<ZoneContact>[] = [
  {
    accessorKey: 'name',
    header: 'Name',
    sortField: 'name',
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <span className="font-semibold">{row.original.name || '-'}</span>
        {row.original.isShippingContact && (
          <Badge variant="secondary" className="text-xs">
            Shipping
          </Badge>
        )}
      </div>
    ),
  },
  {
    accessorKey: 'email',
    header: 'Email',
    sortField: 'email',
    cell: ({ row }) => row.original.email || '-',
  },
  {
    accessorKey: 'phone',
    header: 'Phone',
    sortField: 'phone',
    cell: ({ row }) => formatPhoneNumber(row.original.phone) || '-',
    breakpoint: 'tablet',
  },
  {
    accessorKey: 'contactType',
    header: 'Contact Type',
    sortField: 'contactType',
    cell: ({ row }) => row.original.contactType || '-',
    breakpoint: 'tablet',
  },
  {
    id: 'actions',
    header: '',
    size: 50,
    cell: ({ row }) => <ContactActions contact={row.original} />,
  },
];

const bridgeColumns: ColumnDef<ZoneBridge>[] = [
  {
    accessorKey: 'name',
    header: 'Name',
    cell: ({ row }) => (
      <Link
        to="/dcim/bridges/$bridgeId"
        params={{ bridgeId: row.original.id }}
        className="font-semibold hover:underline"
      >
        {row.original.name}
      </Link>
    ),
  },
  {
    id: 'online',
    header: 'Online',
    cell: ({ row }) => (
      <div className="flex items-center gap-1.5">
        <Badge variant={row.original.online ? 'success' : 'destructive'}>
          {row.original.online ? 'Online' : 'Offline'}
        </Badge>
        {row.original.is_leader ? (
          <Badge variant="info" className="gap-1">
            <Crown className="h-3 w-3" />
            Leader
          </Badge>
        ) : null}
      </div>
    ),
  },
  {
    accessorKey: 'id',
    header: 'ID',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.id}</span>,
  },
];

function ContactActions({ contact }: { contact: ZoneContact }) {
  const params = Route.useParams();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link
            to="/dcim/zones/$zoneId/contacts/$contactId/edit"
            params={{
              zoneId: params.zoneId,
              contactId: contact.id,
            }}
            className="w-full"
          >
            Edit Contact
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            to="/dcim/zones/$zoneId/contacts/$contactId/delete"
            params={{
              zoneId: params.zoneId,
              contactId: contact.id,
            }}
            className="text-destructive w-full"
          >
            Delete Contact
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ContactsSection({ zoneId }: { zoneId: string }) {
  const table = useServerTable<ZoneContact>({ name: 'zone-contacts', columns: contactColumns });

  const { data, isPending, isFetching } = tsr.getZoneContacts.useQuery({
    queryKey: ['zone', zoneId, 'contacts', table.query],
    queryData: { params: { zoneId }, query: table.query },
    placeholderData: keepPreviousData,
  });

  const items = data?.status === 200 ? data.body.data : [];
  const meta = data?.status === 200 ? data.body.meta : undefined;

  return (
    <ServerDataTable
      table={table}
      data={items}
      meta={meta}
      isPending={isPending}
      isFetching={isFetching && !isPending}
      searchPlaceholder="Search contacts..."
      searchLabel="Search contacts"
      emptyMessage="No contacts found."
    />
  );
}

function ZoneOverview() {
  const { zoneId } = Route.useParams();
  const navigate = useNavigate();
  const { data: zoneData, isPending: isZoneLoading } = tsr.getZoneById.useQuery({
    queryKey: ['zone', zoneId],
    queryData: { params: { zoneId } },
  });
  const zone = zoneData?.status === 200 ? zoneData.body : null;

  useDocumentTitle(zone?.name ?? 'Zone');

  if (isZoneLoading) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="py-8">
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!zone) {
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

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-6">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Contacts
            </CardTitle>
            <CardDescription>Manage contact information for this zone.</CardDescription>
          </div>
          <Button className="flex items-center gap-2" asChild>
            <Link to="/dcim/zones/$zoneId/contacts/create" params={{ zoneId }}>
              <Plus className="h-4 w-4" />
              Create Contact
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          <ContactsSection zoneId={zoneId} />
        </CardContent>
      </Card>

      <DhcpCard zoneId={zoneId} />

      <VrrpCard zoneId={zoneId} bridges={zone.bridges} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Network className="h-5 w-5" />
            Bridges
          </CardTitle>
          <CardDescription>Bridge devices assigned to this zone.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={bridgeColumns}
            data={zone.bridges}
            emptyMessage="No bridges assigned to this zone."
            onRowClick={(row) => navigate({ to: '/dcim/bridges/$bridgeId', params: { bridgeId: row.id } })}
          />
        </CardContent>
      </Card>

      <RegistrationTokensCard zoneId={zoneId} dataCenterName={zone.name} />

      <RedisCredentialCard zoneId={zoneId} />
    </div>
  );
}

const DHCP_QUERY_KEY = (zoneId: string) => ['zone', zoneId, 'dhcp-prefixes'];

function DhcpCard({ zoneId }: { zoneId: string }) {
  const { data, isPending, isError } = tsr.getZoneDhcpPrefixes.useQuery({
    queryKey: DHCP_QUERY_KEY(zoneId),
    queryData: { params: { zoneId } },
  });

  // Distinguish a genuine load failure from an empty result — otherwise a fetch error or non-200
  // renders the misleading "no prefixes" empty state instead of surfacing the error.
  const isLoadError = isError || (data !== undefined && data.status !== 200);
  const prefixes: ZoneDhcpPrefixSummary[] = data?.status === 200 ? data.body : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radio className="h-5 w-5" />
          DHCP
        </CardTitle>
        <CardDescription>
          Prefixes eligible for DHCP serving in this zone. Enable a prefix to start serving DHCP on it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : isLoadError ? (
          <p className="text-destructive text-sm">Failed to load DHCP prefixes. Try refreshing the page.</p>
        ) : prefixes.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No prefixes assigned to this zone. Assign a prefix via IPAM to enable DHCP.
          </p>
        ) : (
          <div className="divide-border-dim divide-y">
            {prefixes.map((prefix) => (
              <DhcpPrefixRow key={prefix.prefixId} prefix={prefix} zoneId={zoneId} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DhcpPrefixRow({ prefix, zoneId }: { prefix: ZoneDhcpPrefixSummary; zoneId: string }) {
  const queryClient = useQueryClient();
  const isEnabled = prefix.dhcpMode === 'AUTHORITATIVE' || prefix.dhcpMode === 'PROXY';

  const updateMutation = tsr.updatePrefixDhcpConfig.useMutation({ meta: { silent: true } });
  // Covers the whole read-modify-write, including the initial GET — updateMutation.isPending only
  // covers the PUT, so without this a second click during the GET would fire a duplicate toggle.
  const [isToggling, setIsToggling] = useState(false);

  const handleToggle = async (checked: boolean) => {
    setIsToggling(true);
    try {
      // Read-modify-write: fetch the full config, flip dhcpMode, write it back
      const configRes = await tsr.getPrefixDhcpConfig.query({
        params: { id: prefix.prefixId },
      });
      if (configRes.status !== 200) {
        toast.error('Failed to read DHCP config for this prefix.');
        return;
      }
      const config = configRes.body;
      // Enable defaults to AUTHORITATIVE, but never clobber an existing PROXY config (a stale summary
      // can show the switch off while the stored mode is PROXY) — PROXY is only set/cleared in the detail view.
      const newMode = checked ? (config.dhcpMode === 'PROXY' ? 'PROXY' : 'AUTHORITATIVE') : 'OFF';
      await updateMutation.mutateAsync({
        params: { id: prefix.prefixId },
        body: {
          dhcpMode: newMode,
          dhcpLeaseTtlSeconds: config.dhcpLeaseTtlSeconds,
          ipxeBuildTarget: config.ipxeBuildTarget,
          dhcpOptions: config.dhcpOptions,
          dhcpProxyAllowedMacs: config.dhcpProxyAllowedMacs,
          dhcpProxyPeerAuthoritative: config.dhcpProxyPeerAuthoritative,
          dhcpRelayAgentIp: config.dhcpRelayAgentIp,
        },
      });
      await queryClient.invalidateQueries({ queryKey: DHCP_QUERY_KEY(zoneId) });
      // Also refresh the prefix's own DHCP config query so the detail page (if cached) doesn't show a
      // stale mode/switch after a toggle here.
      await queryClient.invalidateQueries({ queryKey: ['prefix', prefix.prefixId, 'dhcp-config'] });
      toast.success(`DHCP ${checked ? 'enabled' : 'disabled'} for ${prefix.cidr}`);
    } catch {
      toast.error('Failed to update DHCP mode.');
    } finally {
      setIsToggling(false);
    }
  };

  return (
    <div className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3">
        <Link
          to="/dcim/zones/$zoneId/dhcp/$prefixId"
          params={{ zoneId, prefixId: prefix.prefixId }}
          className="font-mono text-sm hover:underline"
        >
          {prefix.cidr}
        </Link>
        {prefix.role && (
          <Badge variant="outline" className="text-xs">
            {prefix.role}
          </Badge>
        )}
        {prefix.dhcpMode && prefix.dhcpMode !== 'OFF' && (
          <Badge variant="secondary" className="text-xs">
            {prefix.dhcpMode}
          </Badge>
        )}
      </div>
      {prefix.dhcpEligible || isEnabled ? (
        // A stranded ON-but-ineligible prefix stays interactive so it can be turned OFF; once off it
        // drops to the disabled state below and can't be re-enabled while ineligible.
        <Switch checked={isEnabled} disabled={isToggling} onCheckedChange={(checked) => void handleToggle(checked)} />
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Switch checked={false} disabled />
            </span>
          </TooltipTrigger>
          <TooltipContent>DHCP needs a zoned, IPv4, non-NAT prefix</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export const VRRP_QUERY_KEY = (zoneId: string) => ['zone', zoneId, 'vrrp-prefixes'];

function VrrpCard({ zoneId, bridges }: { zoneId: string; bridges: ZoneBridge[] }) {
  const { data, isPending, isError } = tsr.getZoneVrrpPrefixes.useQuery({
    queryKey: VRRP_QUERY_KEY(zoneId),
    queryData: { params: { zoneId } },
  });

  const isLoadError = isError || (data !== undefined && data.status !== 200);
  const prefixes: ZoneVrrpPrefixSummary[] = data?.status === 200 ? data.body : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="h-5 w-5" />
          VRRP
        </CardTitle>
        <CardDescription>
          Prefixes with VRRP floating IPs in this zone. Each VIP is advertised to the zone bridges for leader-elected
          failover.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : isLoadError ? (
          <p className="text-destructive text-sm">Failed to load VRRP prefixes. Try refreshing the page.</p>
        ) : prefixes.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No prefixes with VRRP floating IPs in this zone. Assign a VIP via the prefix IPAM page.
          </p>
        ) : (
          <div className="divide-border-dim divide-y">
            {prefixes.map((prefix) => (
              <VrrpPrefixRow key={prefix.prefixId} prefix={prefix} bridges={bridges} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function VrrpPrefixRow({ prefix, bridges }: { prefix: ZoneVrrpPrefixSummary; bridges: ZoneBridge[] }) {
  const bridgeEntries = Object.entries(prefix.ifaceByBridge);
  const leaderBridge = bridges.find((b) => b.is_leader && b.online);

  return (
    <div className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3">
        <Link
          to="/ipam/prefixes/$prefixId"
          params={{ prefixId: prefix.prefixId }}
          className="font-mono text-sm hover:underline"
        >
          {prefix.cidr}
        </Link>
        {prefix.role && (
          <Badge variant="outline" className="text-xs">
            {prefix.role}
          </Badge>
        )}
        {prefix.vip ? (
          <Badge variant="secondary" className="text-xs">
            {prefix.vip}
          </Badge>
        ) : (
          <span className="text-muted-foreground text-xs">No VIP</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {bridgeEntries.length > 0 ? (
          bridgeEntries.map(([bridge, iface]) => {
            const isHolder = !!prefix.vip && leaderBridge?.name === bridge;
            return (
              <span
                key={bridge}
                className={isHolder ? 'flex items-center gap-1 text-xs font-medium' : 'text-muted-foreground text-xs'}
              >
                {isHolder && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Crown className="h-3 w-3 text-amber-500" />
                    </TooltipTrigger>
                    <TooltipContent>Leader — expected to hold this VIP</TooltipContent>
                  </Tooltip>
                )}
                {bridge}: {iface}
              </span>
            );
          })
        ) : (
          <span className="text-muted-foreground text-xs">No bindings</span>
        )}
      </div>
    </div>
  );
}

function errorStatus(error: unknown): number | null {
  return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
    ? error.status
    : null;
}

function RedisCredentialCard({ zoneId }: { zoneId: string }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [credential, setCredential] = useState<ZoneRedisCredential | null>(null);
  const [featureDisabled, setFeatureDisabled] = useState(false);

  const { mutateAsync: rotate, isPending } = tsr.rotateZoneRedisCredential.useMutation({ meta: { silent: true } });

  const reportRotateError = (status: number | null) => {
    if (status === 503) {
      setFeatureDisabled(true);
      toast.info('Redis ACL management is not enabled on this hub, so there is no credential to rotate.');
    } else if (status === 403) {
      toast.error('You do not have permission to rotate this zone’s Redis credential.');
    } else if (status === 404) {
      toast.error('Zone not found.');
    } else {
      toast.error('Could not rotate the Redis credential. Please try again.');
    }
  };

  const handleRotate = async () => {
    try {
      const res = await rotate({ params: { zoneId }, body: {} });
      if (res.status === 201) {
        setCredential(res.body);
      } else {
        reportRotateError(errorStatus(res));
      }
    } catch (error) {
      reportRotateError(errorStatus(error));
    } finally {
      setConfirmOpen(false);
    }
  };

  return (
    <Card>
      <ZoneRedisCredentialDialog credential={credential} onClose={() => setCredential(null)} />
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="sm:max-w-[440px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate Redis credential?</AlertDialogTitle>
            <AlertDialogDescription>
              A new password is generated for this zone&apos;s Redis ACL user and shown once. Bridges still using the
              old password lose Redis access immediately until reconfigured.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={isPending} onClick={() => void handleRotate()}>
              {isPending ? 'Rotating…' : 'Rotate credential'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            Redis Credential
          </CardTitle>
          <CardDescription>
            Per-zone Redis ACL user for the zone&apos;s bridge. Passwords are shown once at zone creation or rotation
            and are never retrievable. Requires Redis ACL management to be enabled on this hub.
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 whitespace-nowrap"
          disabled={featureDisabled}
          onClick={() => setConfirmOpen(true)}
        >
          Rotate credential
        </Button>
      </CardHeader>
      {featureDisabled && (
        <CardContent>
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Redis ACL management is off on this hub</AlertTitle>
            <AlertDescription>
              This hub is not managing per-zone Redis credentials, so there is nothing to rotate. An operator can enable
              it by setting <code>REDIS_ACL_MANAGEMENT_ENABLED=true</code> on the hub.
            </AlertDescription>
          </Alert>
        </CardContent>
      )}
    </Card>
  );
}

const TOKEN_QUERY_KEY = (zoneId: string) => ['zone', zoneId, 'registration-tokens'];

const tokenStatusVariant: Record<ZoneRegistrationTokenMetadata['status'], 'secondary' | 'default' | 'outline'> = {
  unused: 'default',
  consumed: 'secondary',
  expired: 'outline',
};

function RegistrationTokensCard({ zoneId, dataCenterName }: { zoneId: string; dataCenterName: string }) {
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [tokenToInvalidate, setTokenToInvalidate] = useState<ZoneRegistrationTokenMetadata | null>(null);
  const queryClient = useQueryClient();

  const { data, isPending } = tsr.listZoneRegistrationTokens.useQuery({
    queryKey: TOKEN_QUERY_KEY(zoneId),
    queryData: { params: { zoneId } },
  });

  const tokens = data?.status === 200 ? data.body : [];

  const { mutateAsync: mint, isPending: isMinting } = tsr.mintZoneRegistrationToken.useMutation();

  const refetchTokens = () => queryClient.invalidateQueries({ queryKey: TOKEN_QUERY_KEY(zoneId) });

  const handleMint = async () => {
    const res = await mint({ params: { zoneId }, body: {} });
    if (res.status === 201) {
      setMintedToken(res.body.token);
      await refetchTokens();
    }
  };

  const columns: ColumnDef<ZoneRegistrationTokenMetadata>[] = [
    {
      accessorKey: 'mintedByEmail',
      header: 'Minted by',
      cell: ({ row }) => row.original.mintedByEmail ?? row.original.mintedById,
    },
    {
      accessorKey: 'mintedAt',
      header: 'Minted at',
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm">{new Date(row.original.mintedAt).toLocaleString()}</span>
      ),
    },
    {
      accessorKey: 'expiresAt',
      header: 'Expires at',
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm">{new Date(row.original.expiresAt).toLocaleString()}</span>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <Badge variant={tokenStatusVariant[row.original.status]} className="text-xs capitalize">
          {row.original.status}
        </Badge>
      ),
    },
    {
      id: 'actions',
      header: '',
      size: 120,
      cell: ({ row }) =>
        row.original.status === 'unused' ? (
          <Button
            variant="outline"
            size="sm"
            className="text-destructive h-8 whitespace-nowrap"
            onClick={() => setTokenToInvalidate(row.original)}
          >
            Invalidate
          </Button>
        ) : null,
    },
  ];

  return (
    <Card>
      <MintedTokenDialog token={mintedToken} onClose={() => setMintedToken(null)} />
      <InvalidateTokenDialog
        zoneId={zoneId}
        token={tokenToInvalidate}
        onClose={() => setTokenToInvalidate(null)}
        onInvalidated={() => void refetchTokens()}
      />

      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-6">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            Registration Tokens
          </CardTitle>
          <CardDescription>
            Single-use bridge enrollment tokens for this data center. Each token is shown once at mint time and expires
            after 24 hours if unused.
          </CardDescription>
        </div>
        <Button size="sm" disabled={isMinting} className="shrink-0 whitespace-nowrap" onClick={() => void handleMint()}>
          {isMinting ? 'Minting…' : 'Mint registration token'}
        </Button>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="text-muted-foreground text-sm">Loading registration tokens…</div>
        ) : (
          <DataTable
            columns={columns}
            data={tokens}
            emptyMessage={`No registration tokens minted for ${dataCenterName}.`}
          />
        )}
      </CardContent>
    </Card>
  );
}

function MintedTokenDialog({ token, onClose }: { token: string | null; onClose: () => void }) {
  const { copy, copied, reset } = useCopyToClipboard();

  const handleCopy = () => {
    if (!token) return;
    void copy(token);
  };

  return (
    <Dialog
      open={token !== null}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Registration token minted</DialogTitle>
          <DialogDescription>
            Copy this token now and install it on the bridge as <code>BROKKR_REGISTRATION_TOKEN</code>.
          </DialogDescription>
        </DialogHeader>

        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>This is the only time you&apos;ll see this token.</AlertTitle>
          <AlertDescription>Store it securely — it cannot be retrieved again.</AlertDescription>
        </Alert>

        <pre className="bg-muted text-muted-foreground overflow-x-auto rounded-md p-4 font-mono text-xs break-all whitespace-pre-wrap select-all">
          {token}
        </pre>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={handleCopy} className="gap-2">
            {copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
            {copied ? 'Copied!' : 'Copy to clipboard'}
          </Button>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InvalidateTokenDialog({
  zoneId,
  token,
  onClose,
  onInvalidated,
}: {
  zoneId: string;
  token: ZoneRegistrationTokenMetadata | null;
  onClose: () => void;
  onInvalidated: () => void;
}) {
  const { mutateAsync, isPending } = tsr.invalidateZoneRegistrationToken.useMutation({
    meta: { successMessage: 'Registration token invalidated' },
  });

  const handleConfirm = async () => {
    if (!token) return;
    await mutateAsync({ params: { zoneId, tokenId: token.id } });
    onInvalidated();
    onClose();
  };

  return (
    <AlertDialog
      open={token !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent className="sm:max-w-[440px]">
        <AlertDialogHeader>
          <AlertDialogTitle>Invalidate registration token?</AlertDialogTitle>
          <AlertDialogDescription>
            This token will be expired immediately and can no longer be used to enroll a bridge. The audit record is
            preserved. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={isPending} onClick={() => void handleConfirm()}>
            {isPending ? 'Invalidating…' : 'Invalidate token'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
