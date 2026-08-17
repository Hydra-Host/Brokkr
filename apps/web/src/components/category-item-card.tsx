import { GradientBorder } from '@/components/gradient-border';
import { PluginSlot } from '@/plugin-host/plugin-slot';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { cn } from '@repo/ui/utils';
import {
  capitalizeFirstLetter,
  formatBillingFrequency,
  formatMillisecondsToDuration,
  formatPriceFromCentsToDollars,
  formatSize,
  getInventoryStatusTextColor,
} from '@repo/utils/format';
import { Link } from '@tanstack/react-router';

export interface CategoryItemCardProps {
  id: string;
  name: string;
  gpuModel?: string | null;
  gpuCount?: number | null;
  cpuModel?: string | null;
  cpuCount?: number | null;
  cpuCoreCount?: number | null;
  memory?: number | null;
  ssdCount?: number | null;
  ssdSize?: number | null;
  hddCount?: number | null;
  hddSize?: number | null;
  nvmeCount?: number | null;
  nvmeSize?: number | null;
  location?: string | null;
  status: string;
  priceAmount?: number | null;
  interruptiblePriceAmount?: number | null;
  inInventory: boolean;
  primaryIP4?: string | null;
  primaryIP6?: string | null;
  interruptibleOnly: boolean;
  isTeeCapable: boolean;
  vpcCapable: boolean;
  isInterruptibleDeployment: boolean;
  interruptibleNoticePeriod?: number | null;
  category?: string;
  userEmail?: string;
}

function DetailListItem({ name, value }: { name: string; value: string | number | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex justify-between py-2">
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="text-card-foreground">{value}</dd>
    </div>
  );
}

export function PrivateCategoryItemCard({
  id,
  name,
  gpuModel,
  gpuCount,
  cpuModel,
  cpuCount,
  cpuCoreCount,
  memory,
  ssdCount,
  ssdSize,
  hddCount,
  hddSize,
  nvmeCount,
  nvmeSize,
  location,
  status,
  priceAmount,
  interruptiblePriceAmount,
  inInventory,
  primaryIP4,
  primaryIP6,
  interruptibleOnly,
  isTeeCapable,
  vpcCapable,
  isInterruptibleDeployment,
  interruptibleNoticePeriod,
  category,
  userEmail,
}: CategoryItemCardProps) {
  const provisionable = Boolean(
    status === 'on demand' && inInventory && priceAmount && priceAmount !== 0 && (primaryIP4 || primaryIP6),
  );

  return (
    <div key={id} className="h-full rounded-xl hover:scale-[1.01]">
      <div className="relative h-full rounded-xl">
        {interruptibleOnly && (
          <div className="text-muted absolute top-0 right-0 left-0 z-10 rounded-t-xl bg-amber-500 py-0.5 text-center text-xs font-medium">
            Interruptible Only
          </div>
        )}
        <div className="bg-card border-border flex h-full flex-col rounded-xl border">
          <div className="flex-1">
            <div className="px-5 pt-5">
              <p className="text-[1.75rem] font-bold">{gpuModel ?? cpuModel ?? name ?? 'Server'}</p>
              {(isTeeCapable || vpcCapable) && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {isTeeCapable && <Badge variant="success">TEE Capable</Badge>}
                  {vpcCapable && <Badge variant="secondary">Clusterable</Badge>}
                </div>
              )}
            </div>
            <div>
              <dl className="mb-5 flex flex-col divide-y px-5">
                <DetailListItem name="GPUs" value={gpuModel ? `${gpuCount}x ${gpuModel}` : null} />
                <DetailListItem
                  name="CPUs"
                  value={cpuModel ? `${cpuCount}x ${cpuModel} | ${cpuCoreCount} cores` : null}
                />
                <DetailListItem name="Memory" value={memory ? `${formatSize(memory, 'GB', 2)}` : null} />

                <DetailListItem name="SSD Total" value={ssdSize ? formatSize(ssdSize, 'GB', 2) : null} />
                <DetailListItem name="SSD Disks" value={ssdCount} />
                <DetailListItem name="HDD Total" value={hddSize ? formatSize(hddSize, 'GB', 2) : null} />
                <DetailListItem name="HDD Disks" value={hddCount} />
                <DetailListItem name="NVMe Total" value={nvmeSize ? formatSize(nvmeSize, 'GB', 2) : null} />
                <DetailListItem name="NVMe Disks" value={nvmeCount} />
                <DetailListItem name="Location" value={location ? location.replace(/_/g, ' ') : ''} />
              </dl>
            </div>
          </div>
          <div className="border-t" />
          <div className="flex flex-col gap-5 p-5">
            {!interruptibleOnly && (
              <div className="flex justify-between">
                <p className={cn(getInventoryStatusTextColor(status))}>{capitalizeFirstLetter(status)}</p>
                {priceAmount && priceAmount !== 0 && priceAmount !== null && (
                  <p className="text-semibold text-card-foreground">
                    {formatPriceFromCentsToDollars(priceAmount)}
                    <span className="ml-1">{formatBillingFrequency(gpuCount ?? null)}</span>
                  </p>
                )}
              </div>
            )}
            {(!isInterruptibleDeployment || interruptibleOnly) && interruptiblePriceAmount && (
              <div className="flex justify-between">
                <p className="text-amber-500">Interruptible</p>
                {interruptiblePriceAmount !== 0 && interruptiblePriceAmount !== null && (
                  <p className="text-semibold text-card-foreground">
                    {formatPriceFromCentsToDollars(interruptiblePriceAmount)}
                    <span className="ml-1">{formatBillingFrequency(gpuCount ?? null)}</span>
                  </p>
                )}
              </div>
            )}
            {isInterruptibleDeployment && interruptibleNoticePeriod != null && interruptibleNoticePeriod > 0 && (
              <div className="flex justify-between">
                <p className="text-muted-foreground text-sm">Provision Delay</p>
                <p className="text-card-foreground text-sm">
                  {formatMillisecondsToDuration(interruptibleNoticePeriod)}
                </p>
              </div>
            )}
            {provisionable ? (
              <Link to="/inventory/$deviceId" params={{ deviceId: id }} preload="intent">
                <GradientBorder>
                  <Button className="bg-primary hover:bg-primary/90 text-primary-foreground w-full rounded-lg text-base">
                    Rent Now
                  </Button>
                </GradientBorder>
              </Link>
            ) : (
              <GradientBorder>
                <Button className="bg-primary hover:bg-primary/90 text-primary-foreground w-full rounded-lg text-base">
                  Reserve
                </Button>
              </GradientBorder>
            )}
            <PluginSlot
              name="inventory-item-cta"
              category={category}
              userEmail={userEmail}
              device={{
                name: name ?? 'Server',
                gpuModel,
                gpuCount,
                cpuModel,
                cpuCount,
                cpuCoreCount,
                memory,
                ssdSize,
                hddSize,
                nvmeSize,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
