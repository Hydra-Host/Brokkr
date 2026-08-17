import { formatSize } from '@repo/utils';
import { Cpu, HardDrive, MemoryStick, Zap } from 'lucide-react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card';

interface DeviceSpecs {
  cpu: {
    model?: string | null;
    count?: number | null;
    coresPerCpu?: number | null;
    totalCores?: number | null;
    totalThreads?: number | null;
    threadsPerCpu?: number | null;
  };
  gpu: {
    model?: string | null;
    count?: number | null;
  };
  memory: {
    total?: number | null;
  };
  storage: {
    nvmeCount?: number | null;
    nvmeSize?: number | null;
    ssdCount?: number | null;
    ssdSize?: number | null;
    hddCount?: number | null;
    hddSize?: number | null;
    total?: number | null;
  };
}

function getDiskSummary(storage: DeviceSpecs['storage']): string {
  const parts: string[] = [];
  if (storage.nvmeCount) parts.push(`${storage.nvmeCount} NVMe`);
  if (storage.ssdCount) parts.push(`${storage.ssdCount} SSD`);
  if (storage.hddCount) parts.push(`${storage.hddCount} HDD`);
  return parts.length ? parts.join(', ') : 'No disks';
}

function getCpuInfo(cpu: DeviceSpecs['cpu']) {
  const count = cpu.count ?? 1;
  const cores = cpu.totalCores ?? (cpu.coresPerCpu ? cpu.coresPerCpu * count : 0);
  const threads = cpu.totalThreads ?? (cpu.threadsPerCpu ? cpu.threadsPerCpu * count : 0);
  return { model: cpu.model ?? 'Unknown CPU', count, cores, threads };
}

function hasAnySpec(specs: DeviceSpecs): boolean {
  return !!(specs.gpu.model || specs.cpu.model || specs.memory.total || specs.storage.total);
}

export function DeviceSpecsHoverCard({
  specs,
  title,
  children,
}: {
  specs: DeviceSpecs;
  title?: string;
  children: React.ReactNode;
}) {
  if (!hasAnySpec(specs)) {
    return <>{children}</>;
  }

  const cpuInfo = getCpuInfo(specs.cpu);

  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <div className="cursor-default text-left">{children}</div>
      </HoverCardTrigger>
      <HoverCardContent side="bottom" align="start" className="w-96 p-0 shadow-lg">
        <div className="bg-primary/5 border-b p-3">
          <h3 className="text-sm font-semibold">{title ?? 'Device'} Specifications</h3>
        </div>

        <div className="space-y-4 p-4">
          {specs.gpu.model && (
            <div className="flex items-start gap-3">
              <div className="mt-0.5">
                <Zap className="text-primary/70 h-5 w-5" />
              </div>
              <div className="space-y-1">
                <h4 className="text-sm font-medium">GPU</h4>
                <p className="text-muted-foreground line-clamp-2 text-sm">{specs.gpu.model}</p>
                {specs.gpu.count != null && (
                  <div className="mt-1 text-xs">
                    <span className="font-medium">{specs.gpu.count}</span> GPU
                    {specs.gpu.count > 1 ? 's' : ''}
                  </div>
                )}
              </div>
            </div>
          )}

          {specs.cpu.model && (
            <div className="flex items-start gap-3">
              <div className="mt-0.5">
                <Cpu className="text-primary/70 h-5 w-5" />
              </div>
              <div className="space-y-1">
                <h4 className="text-sm font-medium">CPU</h4>
                <p className="text-muted-foreground line-clamp-2 text-sm" title={cpuInfo.model}>
                  {cpuInfo.model}
                </p>
                <div className="mt-1 flex gap-4">
                  <div className="text-xs">
                    <span className="font-medium">{cpuInfo.count}</span> CPU
                    {cpuInfo.count > 1 ? 's' : ''}
                  </div>
                  {cpuInfo.cores > 0 && (
                    <div className="text-xs">
                      <span className="font-medium">{cpuInfo.cores}</span> Cores
                    </div>
                  )}
                  {cpuInfo.threads > 0 && (
                    <div className="text-xs">
                      <span className="font-medium">{cpuInfo.threads}</span> Threads
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {specs.memory.total != null && specs.memory.total > 0 && (
            <div className="flex items-start gap-3">
              <div className="mt-0.5">
                <MemoryStick className="text-primary/70 h-5 w-5" />
              </div>
              <div>
                <h4 className="text-sm font-medium">Memory</h4>
                <p className="text-sm">
                  <span className="font-medium">{formatSize(specs.memory.total, 'GB', 2)}</span>
                </p>
              </div>
            </div>
          )}

          {specs.storage.total != null && specs.storage.total > 0 && (
            <div className="flex items-start gap-3">
              <div className="mt-0.5">
                <HardDrive className="text-primary/70 h-5 w-5" />
              </div>
              <div className="space-y-1">
                <h4 className="text-sm font-medium">Storage</h4>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <div className="text-sm">
                    <span className="text-muted-foreground text-xs">Disks:</span>{' '}
                    <span>{getDiskSummary(specs.storage)}</span>
                  </div>
                  <div className="text-sm">
                    <span className="text-muted-foreground text-xs">Total:</span>{' '}
                    <span className="font-medium">{formatSize(specs.storage.total, 'GB', 2)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
