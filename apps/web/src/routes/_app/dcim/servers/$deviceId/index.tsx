import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { Cpu, HardDrive, MemoryStick, Network, Server as ServerIcon, Zap } from 'lucide-react';

import type { Server } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Separator } from '@repo/ui/components/separator';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { formatSize, perDriveSizeGb } from '@repo/utils';
import { Fragment, type ReactNode } from 'react';

const parentRoute = getRouteApi('/_app/dcim/servers/$deviceId');

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/')({
  staticData: { breadcrumb: 'Overview' },
  component: ServerOverview,
});

function SpecRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="flex items-center justify-between py-1.5">
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

type Specs = Server['specs'];

export const isDiscovered = (specs: Specs): boolean =>
  Boolean(specs.cpu.model || specs.gpu.model || specs.memory.total);

export function ComputeCardBody({ specs, deviceId }: { specs: Specs; deviceId: string }) {
  const { cpu, gpu, memory } = specs;

  if (!isDiscovered(specs)) {
    return (
      <div className="text-muted-foreground space-y-2 text-sm">
        <p>Hardware not discovered yet. This device has never reported a CPU, a GPU or memory.</p>
        <p>
          Start discovery with Collect in the header, then follow it under{' '}
          <Link to="/dcim/servers/$deviceId/discovery-runs" params={{ deviceId }} className="underline">
            Discovery runs
          </Link>
          .
        </p>
      </div>
    );
  }

  const sections: ReactNode[] = [];
  if (gpu.model) {
    sections.push(
      <>
        <div className="flex items-center gap-2 pb-1">
          <Zap className="text-muted-foreground h-3.5 w-3.5" />
          <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">GPU</span>
        </div>
        <SpecRow label="Model" value={gpu.model} />
        <SpecRow label="Count" value={gpu.count} />
      </>,
    );
  }
  if (cpu.model) {
    sections.push(
      <>
        <div className="flex items-center gap-2 pb-1">
          <Cpu className="text-muted-foreground h-3.5 w-3.5" />
          <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">CPU</span>
        </div>
        <SpecRow label="Model" value={cpu.model} />
        <SpecRow label="Physical CPUs" value={cpu.count} />
        <SpecRow label="Total Cores" value={cpu.totalCores} />
        <SpecRow label="Total Threads" value={cpu.totalThreads} />
      </>,
    );
  }
  if (memory.total) {
    sections.push(
      <>
        <div className="flex items-center gap-2 pb-1">
          <MemoryStick className="text-muted-foreground h-3.5 w-3.5" />
          <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">Memory</span>
        </div>
        <SpecRow label="Total" value={formatSize(memory.total, 'GB', 2)} />
      </>,
    );
  }

  return (
    <>
      {sections.map((section, i) => (
        <Fragment key={i}>
          {i > 0 && <Separator className="bg-border-dim my-2" />}
          {section}
        </Fragment>
      ))}
    </>
  );
}

function ServerOverview() {
  const device = parentRoute.useLoaderData();
  const displayName = device.dcim?.nickname || device.name;

  useDocumentTitle(displayName);

  const { storage } = device.specs;
  const { networking } = device;

  const storageLines = [
    formatStorage(storage.nvmeCount, storage.nvmeSize, 'NVMe'),
    formatStorage(storage.ssdCount, storage.ssdSize, 'SSD'),
    formatStorage(storage.hddCount, storage.hddSize, 'HDD'),
  ].filter(Boolean);

  const totalStorage = formatSize(storage.total, 'GB', 2);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ServerIcon className="h-4 w-4" />
            Compute
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <ComputeCardBody specs={device.specs} deviceId={device.id} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4" />
            Storage
          </CardTitle>
          {totalStorage && <CardDescription>Total: {totalStorage}</CardDescription>}
        </CardHeader>
        <CardContent>
          {storageLines.length > 0 ? (
            <div className="space-y-1">
              {storageLines.map((line, i) => (
                <div key={i} className="flex items-center justify-between py-1.5">
                  <span className="text-sm">{line}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No storage information available.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="h-4 w-4" />
            Networking
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <SpecRow label="IPv4" value={networking.ipv4 || undefined} />
          <SpecRow label="IPv6" value={networking.ipv6 || undefined} />
          <SpecRow label="MAC Address" value={networking.mac || undefined} />
          <SpecRow label="IPMI IP" value={networking.ipmiIp || undefined} />
          {networking.vpcCapable && (
            <div className="flex items-center justify-between py-1.5">
              <span className="text-muted-foreground text-sm">VPC Capable</span>
              <Badge variant="success" className="text-xs">
                Yes
              </Badge>
            </div>
          )}
          {!networking.ipv4 && !networking.ipv6 && !networking.mac && (
            <p className="text-muted-foreground text-sm">No networking information available.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Zap className="h-4 w-4" />
            Deployment
          </CardTitle>
        </CardHeader>
        <CardContent>
          {device.deployment ? (
            <div className="space-y-1">
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
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No active deployment.</p>
          )}
        </CardContent>
      </Card>

      {device.availableBaseLayers.length > 0 && (
        <Card className="md:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Available Base Layers</CardTitle>
            <CardDescription>
              {device.availableBaseLayers.length} base layer
              {device.availableBaseLayers.length !== 1 ? 's' : ''} available for provisioning.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {device.availableBaseLayers.map((layer) => (
                <Badge key={layer.slug} variant="secondary">
                  {layer.name}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
