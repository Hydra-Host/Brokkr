import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { Clipboard, ClipboardCheck, ExternalLink, Network } from 'lucide-react';

import type { Interface } from '@repo/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { formatIpAddress } from '@repo/utils';

import { useCopyToClipboard } from '@repo/ui/hooks/use-copy-to-clipboard';

const parentRoute = getRouteApi('/_app/dcim/bridges/$bridgeId');

export const Route = createFileRoute('/_app/dcim/bridges/$bridgeId/')({
  staticData: { breadcrumb: 'Overview' },
  component: BridgeOverview,
});

type NetBucket = 'primary' | 'management' | 'virtual';

interface NetIp {
  id?: string;
  address: string;
  mac: string;
  prefix: NonNullable<NonNullable<Interface['ip_addresses']>[number]['prefix']> | null;
}

function BridgeOverview() {
  const bridge = parentRoute.useLoaderData();
  useDocumentTitle(bridge.name ?? 'Bridge');

  const buckets: Record<NetBucket, NetIp[]> = { primary: [], management: [], virtual: [] };
  for (const iface of bridge.interfaces ?? []) {
    for (const ip of iface.ip_addresses ?? []) {
      const prefix = ip.prefix ?? null;
      const bucket: NetBucket =
        iface.type === 'VIRTUAL' ? 'virtual' : prefix?.role === 'management' ? 'management' : 'primary';
      buckets[bucket].push({ id: ip.id, address: ip.address, mac: iface.mac_address, prefix });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Network className="h-5 w-5" />
          Network
        </CardTitle>
        <CardDescription>IP addresses grouped by their containing prefix&apos;s network role.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <NetColumn title="Primary" ips={buckets.primary} detailed />
          <NetColumn title="Management" ips={buckets.management} detailed />
          <NetColumn title="Virtual" ips={buckets.virtual} />
        </div>
      </CardContent>
    </Card>
  );
}

// A single network column. `detailed` columns (Primary/Management) show each
// IP's containing prefix and interface MAC beneath it; Virtual shows the IP alone.
function NetColumn({ title, ips, detailed }: { title: string; ips: NetIp[]; detailed?: boolean }) {
  return (
    <div className="space-y-2">
      <div className="text-muted-foreground text-xs font-bold tracking-wide uppercase">{title}</div>
      {ips.length === 0 ? (
        <div className="text-muted-foreground text-sm">--</div>
      ) : (
        <div className="space-y-3">
          {ips.map((ip) => (
            <div key={`${ip.address}-${ip.mac}`} className="space-y-0.5">
              <div className="flex items-center gap-1.5">
                {ip.id ? (
                  <Link
                    to="/ipam/ip-addresses/$ipAddressId"
                    params={{ ipAddressId: ip.id }}
                    className="text-primary font-mono text-xs break-all hover:underline"
                  >
                    {formatIpAddress(ip.address)}
                  </Link>
                ) : (
                  <span className="font-mono text-xs break-all">{formatIpAddress(ip.address)}</span>
                )}
                {/* Clipboard API is secure-context-only; hide the copy affordance on plain HTTP. */}
                {window.isSecureContext && <CopyButton value={formatIpAddress(ip.address)} />}
                {/* External-link icon browses to the live host over https. */}
                <a
                  href={
                    formatIpAddress(ip.address).includes(':')
                      ? `https://[${formatIpAddress(ip.address)}]`
                      : `https://${formatIpAddress(ip.address)}`
                  }
                  target="_blank"
                  rel="noreferrer"
                  title="Open host"
                  className="text-muted-foreground hover:text-foreground shrink-0"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
              {detailed && (
                <>
                  {ip.prefix ? (
                    <Link
                      to="/ipam/prefixes/$prefixId"
                      params={{ prefixId: ip.prefix.id }}
                      className="text-primary block font-mono text-xs break-all hover:underline"
                    >
                      {ip.prefix.prefix}
                    </Link>
                  ) : (
                    <div className="text-muted-foreground font-mono text-xs">--</div>
                  )}
                  <div className="text-muted-foreground font-mono text-xs break-all">{ip.mac || '--'}</div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  // Shared clipboard hook: transient "copied" feedback + a toast on failure (insecure context / denied
  // permission), replacing the hand-rolled useState + setTimeout + leaking timeout handle.
  const { copy, copied } = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => void copy(value)}
      title="Copy IP"
      className="text-muted-foreground hover:text-foreground shrink-0"
    >
      {copied ? <ClipboardCheck className="h-3.5 w-3.5 text-emerald-500" /> : <Clipboard className="h-3.5 w-3.5" />}
    </button>
  );
}
