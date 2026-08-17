import type { Server } from '@repo/api-client';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Cpu, ExternalLink, HardDrive, MemoryStick, Network, Power, Server as ServerIcon, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { DeviceStatusBadge } from '@repo/ui/components/device-status-badge';
import { Separator } from '@repo/ui/components/separator';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@repo/ui/components/sheet';
import { Skeleton } from '@repo/ui/components/skeleton';
import { formatPriceFromCentsToDollars, formatSize, perDriveSizeGb } from '@repo/utils/format';
import { tsr } from '~/lib/api';

const searchSchema = z.object({
  deviceId: z.string(),
});

export const Route = createFileRoute('/_app/dcim/servers/_active/server-details')({
  validateSearch: searchSchema,
  component: ServerDetailsSheet,
});

function SpecRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

function formatStorage(count: number | null | undefined, size: number | null | undefined, type: string) {
  const perDrive = perDriveSizeGb(count, size);
  if (perDrive == null) return null;
  return `${count}x ${formatSize(perDrive, 'GB', 2) ?? `${perDrive} GB`} ${type}`;
}

const ANIMATION_DURATION = 300;

function ServerDetailsSheet() {
  const { deviceId } = Route.useSearch();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(true);
  }, []);

  const closeSheet = () => {
    setOpen(false);
    setTimeout(
      () =>
        (navigate as (opts: Record<string, unknown>) => void)({
          to: '/dcim/servers',
          search: (prev: Record<string, unknown>) => {
            return Object.fromEntries(Object.entries(prev).filter(([k]) => k !== 'deviceId'));
          },
        }),
      ANIMATION_DURATION,
    );
  };

  const { data, isPending } = tsr.getServerById.useQuery({
    queryKey: ['server', deviceId],
    queryData: { params: { deviceId } },
  });

  const device = data?.status === 200 ? data.body : null;

  return (
    <Sheet
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) closeSheet();
      }}
    >
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-[50vw]">
        {isPending ? (
          <ServerDetailsSkeleton />
        ) : device ? (
          <ServerDetailsContent device={device} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground">Server not found.</p>
          </div>
        )}

        <SheetFooter className="mt-6">
          <Button variant="outline" onClick={closeSheet}>
            Close
          </Button>
          {device && (
            <Button asChild>
              <Link to="/dcim/servers/$deviceId" params={{ deviceId }}>
                <ExternalLink className="mr-2 h-4 w-4" />
                View Full Overview
              </Link>
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function ServerDetailsSkeleton() {
  return (
    <>
      <SheetHeader>
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-5 w-64" />
      </SheetHeader>
      <div className="mt-6 space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </>
  );
}

function ServerDetailsContent({ device }: { device: Server }) {
  const displayName = device.dcim?.nickname || device.name;
  const { cpu, gpu, memory, storage } = device.specs;
  const { networking, listing } = device;

  const storageLines = [
    formatStorage(storage.nvmeCount, storage.nvmeSize, 'NVMe'),
    formatStorage(storage.ssdCount, storage.ssdSize, 'SSD'),
    formatStorage(storage.hddCount, storage.hddSize, 'HDD'),
  ].filter(Boolean);

  const totalStorage = formatSize(storage.total, 'GB', 2);

  const gpuCount = gpu.count;
  const usePerGpu = !!(gpuCount && listing.onDemandPrice.perHour.perGpu);
  const unit = usePerGpu ? 'GPU/Hr' : '/Hr';
  const onDemand = usePerGpu ? listing.onDemandPrice.perHour.perGpu : listing.onDemandPrice.perHour.total;
  const floor = usePerGpu ? listing.interruptiblePrice.perHour.perGpu : listing.interruptiblePrice.perHour.total;

  return (
    <>
      <SheetHeader>
        <SheetTitle className="text-xl">{displayName}</SheetTitle>
        <SheetDescription className="flex flex-col gap-0.5">
          <span>{device.dcim?.nickname ?? device.name}</span>
          <span>ID: {device.id}</span>
        </SheetDescription>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {device.status?.label && <DeviceStatusBadge status={device.status.label} />}
          <DeviceStatusBadge status={device.powerStatus?.label || ''} icon={Power} />
          {device.role && <Badge variant="outline">{device.role}</Badge>}
          {device.ecoMode && <Badge variant="secondary">Eco Mode</Badge>}
          {device.isTeeCapable && <Badge variant="secondary">TEE Capable</Badge>}
        </div>
      </SheetHeader>

      <div className="mt-6 space-y-5">
        {device.zoneName && (
          <Section icon={ServerIcon} title="Data Center">
            <SpecRow label="Data Center" value={device.zoneName || undefined} />
          </Section>
        )}

        {gpu.model && (
          <Section icon={Zap} title="GPU">
            <SpecRow label="Model" value={gpu.model} />
            <SpecRow label="Count" value={gpu.count} />
          </Section>
        )}

        <Section icon={Cpu} title="CPU">
          <SpecRow label="Model" value={cpu.model} />
          <SpecRow label="Physical CPUs" value={cpu.count} />
          <SpecRow label="Total Cores" value={cpu.totalCores} />
          <SpecRow label="Total Threads" value={cpu.totalThreads} />
        </Section>

        {memory.total && (
          <Section icon={MemoryStick} title="Memory">
            <SpecRow label="Total" value={formatSize(memory.total, 'GB', 2)} />
          </Section>
        )}

        {(storageLines.length > 0 || totalStorage) && (
          <Section icon={HardDrive} title={`Storage${totalStorage ? ` (${totalStorage})` : ''}`}>
            {storageLines.map((line, i) => (
              <div key={i} className="flex items-center justify-between py-1">
                <span className="text-sm">{line}</span>
              </div>
            ))}
          </Section>
        )}

        <Section icon={Network} title="Networking">
          <SpecRow label="IPv4" value={networking.ipv4 || undefined} />
          <SpecRow label="IPv6" value={networking.ipv6 || undefined} />
          <SpecRow label="MAC Address" value={networking.mac || undefined} />
          <SpecRow label="IPMI IP" value={networking.ipmiIp || undefined} />
          {networking.vpcCapable && (
            <div className="flex items-center justify-between py-1">
              <span className="text-muted-foreground text-sm">VPC Capable</span>
              <Badge variant="success" className="text-xs">
                Yes
              </Badge>
            </div>
          )}
        </Section>

        <Section icon={Zap} title="Pricing & Listing">
          <div className="flex items-center justify-between py-1">
            <span className="text-muted-foreground text-sm">Status</span>
            <Badge variant={listing.isActive ? 'default' : 'outline'}>{listing.isActive ? 'Listed' : 'Unlisted'}</Badge>
          </div>
          {listing.isInterruptibleOnly && (
            <div className="flex items-center justify-between py-1">
              <span className="text-muted-foreground text-sm">Mode</span>
              <span className="text-sm font-medium text-amber-500">Interruptible Only</span>
            </div>
          )}
          {onDemand ? (
            <div className="flex items-center justify-between py-1">
              <span className="text-muted-foreground text-sm">On Demand</span>
              <span className="text-sm font-medium text-emerald-500">
                {formatPriceFromCentsToDollars(onDemand)} {unit}
              </span>
            </div>
          ) : null}
          {floor ? (
            <div className="flex items-center justify-between py-1">
              <span className="text-muted-foreground text-sm">Floor</span>
              <span className="text-muted-foreground text-sm font-medium">
                {formatPriceFromCentsToDollars(floor)} {unit}
              </span>
            </div>
          ) : null}
        </Section>

        <Section icon={Zap} title="Deployment">
          {device.deployment ? (
            <>
              <SpecRow label="Deployer" value={device.deployment.deployerEmail || undefined} />
              {device.deployment.reservation && (
                <>
                  <SpecRow label="Billing" value={device.deployment.reservation.billingFrequency} />
                  <SpecRow
                    label="$/hr"
                    value={
                      device.deployment.reservation.pricePerDeviceHour != null
                        ? `$${device.deployment.reservation.pricePerDeviceHour.toFixed(2)}`
                        : undefined
                    }
                  />
                </>
              )}
            </>
          ) : (
            <p className="text-muted-foreground py-1 text-sm">No active deployment.</p>
          )}
        </Section>

        {device.availableBaseLayers.length > 0 && (
          <>
            <Separator className="bg-border-dim" />
            <div>
              <h4 className="mb-2 text-sm font-medium">Available Base Layers ({device.availableBaseLayers.length})</h4>
              <div className="flex flex-wrap gap-1.5">
                {device.availableBaseLayers.map((layer) => (
                  <Badge key={layer.slug} variant="secondary" className="text-xs">
                    {layer.name}
                  </Badge>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <Separator className="bg-border-dim" />
      <div>
        <div className="mb-1 flex items-center gap-2">
          <Icon className="text-muted-foreground h-3.5 w-3.5" />
          <h4 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">{title}</h4>
        </div>
        {children}
      </div>
    </>
  );
}
