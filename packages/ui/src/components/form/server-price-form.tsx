import { zodResolver } from '@hookform/resolvers/zod';
import { formatPriceFromCentsToDollars, HOURS_IN_WEEK } from '@repo/utils';
import { AlertTriangle } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { getUiBrandName } from '../../lib/brand';

import { Button } from '../button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../card';
import { Label } from '../label';
import { Switch } from '../switch';
import { FormMoneyInput } from './form-money-input';
import { FormSubmitButton } from './form-submit-button';

export type ServerPriceFormServer = {
  specs: {
    gpu: { model?: string | null; count?: number | null };
    cpu: { model?: string | null; count?: number | null };
  };
  availableBaseLayers: readonly unknown[];
  networking: { ipv4?: string | null; ipv6?: string | null; vpcCapable?: boolean | null };
  listing: {
    isActive?: boolean | null;
    isInterruptibleOnly?: boolean | null;
    onDemandPrice: { perHour: { total?: number | null } };
    interruptiblePrice: { perHour: { total?: number | null } };
  };
};

export interface ServerPriceFormSubmitData {
  hourlyPrice: number;
  floorHourlyPrice?: number;
  billingFrequency: 'Weekly';
  isListed: boolean;
  isInterruptibleOnly?: boolean;
}

interface ServerPriceFormProps<T extends ServerPriceFormServer> {
  devices: T[];
  onSubmit: (data: ServerPriceFormSubmitData) => Promise<void>;
  isPending: boolean;
  onCancel?: () => void;
}

const serverPriceFormSchema = z
  .object({
    onDemandWeeklyPrice: z.number(),
    floorWeeklyPrice: z.number().optional(),
    isListed: z.boolean(),
    isInterruptibleOnly: z.boolean(),
  })
  .superRefine((data, ctx) => {
    if (data.onDemandWeeklyPrice <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Price cannot be $0.00',
        path: ['onDemandWeeklyPrice'],
      });
    }
    if (
      data.floorWeeklyPrice !== undefined &&
      data.floorWeeklyPrice > 0 &&
      data.floorWeeklyPrice > data.onDemandWeeklyPrice
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Floor price cannot be greater than on demand price',
        path: ['floorWeeklyPrice'],
      });
    }
  });

type ServerPriceFormData = z.infer<typeof serverPriceFormSchema>;

function getServerModel(d: ServerPriceFormServer): string {
  return d.specs.gpu.model || d.specs.cpu.model || '';
}

function getServerUnitCount(d: ServerPriceFormServer): number {
  return d.specs.gpu.model ? (d.specs.gpu.count ?? 0) : (d.specs.cpu.count ?? 0);
}

export function isServerNotAvailableToList(d: ServerPriceFormServer): boolean {
  return d.availableBaseLayers.length === 0 || (!d.networking.ipv4 && !d.networking.ipv6 && !d.networking.vpcCapable);
}

export function ServerPriceForm<T extends ServerPriceFormServer>({
  devices,
  onSubmit,
  isPending,
  onCancel,
}: ServerPriceFormProps<T>) {
  const device = devices[0];
  const isBulkUpdate = devices.length > 1;

  const bulkDerived = useMemo(() => {
    if (!isBulkUpdate) return null;
    const models = devices.map(getServerModel);
    const unitCounts = devices.map(getServerUnitCount);
    return {
      models,
      unitCounts,
      hasMixedGpus: new Set(models).size > 1 || new Set(unitCounts).size > 1,
      hasMixedInterruptibleDevices:
        devices.some((d) => d.listing.isInterruptibleOnly) && devices.some((d) => !d.listing.isInterruptibleOnly),
      isNotAvailableToList: devices.some(isServerNotAvailableToList),
      maxOnDemandHourly: Math.max(...devices.map((d) => d.listing.onDemandPrice.perHour.total ?? 0)),
      maxFloorHourly: Math.max(...devices.map((d) => d.listing.interruptiblePrice.perHour.total ?? 0)),
    };
  }, [devices, isBulkUpdate]);

  const gpuCount = device.specs.gpu.count ?? 0;

  const resolvedIsNotAvailableToList = isBulkUpdate
    ? (bulkDerived?.isNotAvailableToList ?? false)
    : isServerNotAvailableToList(device);

  const defaultIsListed = (() => {
    if (resolvedIsNotAvailableToList) return false;
    if (isBulkUpdate) return true;
    return device.listing.isActive ?? false;
  })();

  const defaultOnDemandHourly = isBulkUpdate
    ? (bulkDerived?.maxOnDemandHourly ?? 0)
    : (device.listing.onDemandPrice.perHour.total ?? 0);

  const defaultFloorHourly = isBulkUpdate
    ? (bulkDerived?.maxFloorHourly ?? 0)
    : (device.listing.interruptiblePrice.perHour.total ?? 0);

  const form = useForm<ServerPriceFormData>({
    resolver: zodResolver(serverPriceFormSchema),
    defaultValues: {
      onDemandWeeklyPrice: defaultOnDemandHourly * HOURS_IN_WEEK,
      floorWeeklyPrice: defaultFloorHourly * HOURS_IN_WEEK,
      isListed: defaultIsListed,
      isInterruptibleOnly: device.listing.isInterruptibleOnly ?? false,
    },
  });

  const { control, setValue } = form;
  const watchedOnDemandPrice = useWatch({ control, name: 'onDemandWeeklyPrice' });
  const watchedFloorPrice = useWatch({ control, name: 'floorWeeklyPrice' });

  const updatePrice = useCallback(
    (field: 'onDemandWeeklyPrice' | 'floorWeeklyPrice', newCents: number) => {
      setValue(field, newCents);
    },
    [setValue],
  );

  const handleSubmit = async (data: ServerPriceFormData) => {
    await onSubmit({
      hourlyPrice: Math.round(data.onDemandWeeklyPrice / HOURS_IN_WEEK),
      floorHourlyPrice:
        data.floorWeeklyPrice && data.floorWeeklyPrice > 0
          ? Math.round(data.floorWeeklyPrice / HOURS_IN_WEEK)
          : undefined,
      billingFrequency: 'Weekly',
      isListed: data.isListed,
      isInterruptibleOnly: data.isInterruptibleOnly,
    });
  };

  const hasMixedGpus = bulkDerived?.hasMixedGpus ?? false;

  return (
    <form onSubmit={form.handleSubmit(handleSubmit)} className="max-w-lg space-y-6">
      {hasMixedGpus && (
        <div className="flex items-center gap-2 rounded-sm border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            You are attempting to group servers with different GPU models or GPU counts.
          </p>
        </div>
      )}

      <div>
        <p className="text-primary mb-2 font-semibold">On Demand</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormMoneyInput
            control={control}
            name="onDemandWeeklyPrice"
            label="GPU/Hour"
            disabled={!gpuCount}
            externalValue={gpuCount ? watchedOnDemandPrice / (HOURS_IN_WEEK * gpuCount) : 0}
            onValueChange={(cents) => updatePrice('onDemandWeeklyPrice', cents * HOURS_IN_WEEK * gpuCount)}
          />
          <FormMoneyInput
            control={control}
            name="onDemandWeeklyPrice"
            label="Server/Hour"
            externalValue={watchedOnDemandPrice / HOURS_IN_WEEK}
            onValueChange={(cents) => updatePrice('onDemandWeeklyPrice', cents * HOURS_IN_WEEK)}
          />
          <FormMoneyInput control={control} name="onDemandWeeklyPrice" label="Server/Week" />
        </div>
      </div>

      <div>
        <p className="text-primary mb-2 font-semibold">Floor Price</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormMoneyInput
            control={control}
            name="floorWeeklyPrice"
            label="GPU/Hour"
            disabled={!gpuCount}
            externalValue={gpuCount && watchedFloorPrice ? watchedFloorPrice / (HOURS_IN_WEEK * gpuCount) : 0}
            onValueChange={(cents) => updatePrice('floorWeeklyPrice', cents * HOURS_IN_WEEK * gpuCount)}
          />
          <FormMoneyInput
            control={control}
            name="floorWeeklyPrice"
            label="Server/Hour"
            externalValue={watchedFloorPrice ? watchedFloorPrice / HOURS_IN_WEEK : 0}
            onValueChange={(cents) => updatePrice('floorWeeklyPrice', cents * HOURS_IN_WEEK)}
          />
          <FormMoneyInput control={control} name="floorWeeklyPrice" label="Server/Week" />
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-center space-x-2">
          <Switch
            checked={form.watch('isListed')}
            onCheckedChange={(checked) => form.setValue('isListed', checked)}
            disabled={resolvedIsNotAvailableToList}
          />
          <Label>List in {getUiBrandName()} Inventory</Label>
        </div>
        {resolvedIsNotAvailableToList && (
          <p className="text-sm text-amber-500">
            Price, IP Address, and at least one Base OS Layer are required to list on {getUiBrandName()}
          </p>
        )}

        <div className="flex items-center space-x-2">
          <Switch
            checked={form.watch('isInterruptibleOnly')}
            onCheckedChange={(checked) => form.setValue('isInterruptibleOnly', checked)}
          />
          <Label>List as Interruptible Only</Label>
        </div>
        {bulkDerived?.hasMixedInterruptibleDevices && (
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-8 w-8 shrink-0 text-amber-500" />
            <p className="text-sm text-amber-500">
              Some of your selected servers are interruptible and some are not. The interruptible setting you choose
              will be applied to all selected servers.
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 pt-4">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <FormSubmitButton pending={isPending} disabled={hasMixedGpus}>
          Update Monetization
        </FormSubmitButton>
      </div>

      {isBulkUpdate && bulkDerived && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Selected Servers</CardTitle>
            <CardDescription>Review the selected servers and their current pricing.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="border-border rounded-sm border">
              <table className="w-full text-sm">
                <thead className="bg-bg-primary/50 sticky top-0 z-10">
                  <tr className="border-border border-b">
                    <th className="px-4 py-2 text-left font-medium">Model</th>
                    <th className="px-4 py-2 text-right font-medium">Unit/hour ($)</th>
                    <th className="px-4 py-2 text-right font-medium">Weekly ($)</th>
                  </tr>
                </thead>
              </table>
              <div className="max-h-[120px] overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {bulkDerived.models.map((model, i) => {
                      const count = bulkDerived.unitCounts[i] ?? 0;
                      return (
                        <tr key={i} className={i !== bulkDerived.models.length - 1 ? 'border-border border-b' : ''}>
                          <td className="w-[33.33%] px-4 py-2">{model || '-'}</td>
                          <td className="w-[33.33%] px-4 py-2 text-right">
                            {count && watchedOnDemandPrice
                              ? formatPriceFromCentsToDollars(watchedOnDemandPrice / HOURS_IN_WEEK / count)
                              : '-'}
                          </td>
                          <td className="w-[33.33%] px-4 py-2 text-right">
                            {watchedOnDemandPrice ? formatPriceFromCentsToDollars(watchedOnDemandPrice) : '-'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="text-muted-foreground mt-2 text-xs">*Weekly prices based on 168 hours per week</p>
          </CardContent>
        </Card>
      )}
    </form>
  );
}
