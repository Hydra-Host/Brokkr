import { HOURS_IN_MONTH, HOURS_IN_MONTH_INDUSTRY_STANDARD, HOURS_IN_WEEK, MIB_PER_GIB } from './constants';
import { BillingFrequency, ContractType, DeviceStatus, InvoiceStatus, NetTerms, TransactionStatus } from './enums';

export { formatContractType } from './contract-type';

const CONTRACT_TYPE_FINE_PRINT = {
  [ContractType.ON_DEMAND]: '*If you cancel early, we refund the unused portion of the billing cycle.',
  [ContractType.INTERRUPTIBLE]:
    '*Interruptible servers may be reclaimed after the notice period. Unused time is refunded.',
  [ContractType.RESERVED_ROLLING]: '*Reserved Rolling cancellations are non-refundable for the current billing cycle.',
  [ContractType.RESERVED]: '',
} as const satisfies Record<ContractType, string>;

export function getContractTypeFinePrint(contractType: string) {
  return CONTRACT_TYPE_FINE_PRINT[contractType as ContractType] ?? '';
}

type ReservationInvitePricing = {
  billingFrequency: string;
  price: number | null;
};

type PriceDetail = {
  perGpu?: number | null;
  total: number | null;
};

type InventoryListingPricing = {
  specs: {
    gpu: {
      count: number | null;
    };
  };
  listing: {
    isInterruptibleOnly: boolean;
    interruptiblePrice: {
      perHour: PriceDetail;
      perWeek: PriceDetail;
    };
    onDemandPrice: {
      perHour: PriceDetail;
      perWeek: PriceDetail;
    };
  };
};

export function formatPhoneNumber(e164: string | null | undefined): string {
  if (!e164) return '';
  const match = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (match) return `(${match[1]}) ${match[2]}-${match[3]}`;
  return e164;
}

export function capitalizeFirstLetter(word: string | null | undefined): string {
  if (!word) return '';
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function truncateString(str: string | null | undefined, maxLength: number): string | null {
  if (!str) return null;
  return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
}

export function sanitizeKey(key: string) {
  return key
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

export function getUserInitials(name: string | null, email?: string): string {
  if (name) {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }
  if (email) {
    return email[0]?.toUpperCase() ?? '?';
  }
  return '?';
}

export function normalizeGpuModel(gpuModel: string) {
  if (!gpuModel) return '';
  return gpuModel.replace('NVIDIA GeForce ', '').replace('NVIDIA ', '').toLowerCase();
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-CA');
}

export function formatShortDate(date: Date | string | null): string {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatShortDateTime(date: Date | string | null): string {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatMillisecondsToDuration(ms: number): string {
  const minutes = Math.floor(ms / (1000 * 60));
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  if (days >= 1) {
    return days === 1 ? '1 day' : `${days} days`;
  }

  if (hours >= 1) {
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }

  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

const moneyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(amount: number) {
  return moneyFormatter.format(amount);
}

export function formatPriceFromCentsToDollars(price: number) {
  return moneyFormatter.format(price / 100);
}

export function formatPrice(price: number) {
  return moneyFormatter.format(price);
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'] as const;

type SizeUnit = (typeof SIZE_UNITS)[number];

// Steps are 1024 despite the "GB"/"TB" labels (product convention, not SI);
// use `formatSize` when a human reads the result.
export function convertSize(value: number | bigint, from: SizeUnit = 'B', to: SizeUnit = 'GB'): number {
  return Number(value) * 1024 ** (SIZE_UNITS.indexOf(from) - SIZE_UNITS.indexOf(to));
}

// `convertSize` with the largest unit keeping the value >= 1; trailing zeros
// dropped so whole values read "512 GB", not "512.0 GB".
export function formatSize(value?: number | bigint | null, from: SizeUnit = 'B', decimals = 1): string | null {
  if (value == null) return null;
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return null;

  // clamps at the last unit, so a magnitude past EB still lands on a real label.
  let unit: SizeUnit = from;
  for (const candidate of SIZE_UNITS.slice(SIZE_UNITS.indexOf(from))) {
    unit = candidate;
    if (convertSize(value, from, candidate) < 1024) break;
  }

  const scaled = convertSize(value, from, unit);
  return `${trimTrailingZeros(scaled.toFixed(decimals))} ${unit}`;
}

export interface DemandRequestDeviceSpecsInput {
  gpuModel?: string | null;
  gpuCount?: number | null;
  cpuModel?: string | null;
  cpuCount?: number | null;
  cpuCoreCount?: number | null;
  memory?: number | null;
  ssdSize?: number | null;
  hddSize?: number | null;
  nvmeSize?: number | null;
}

export function formatDemandRequestDeviceSpecs({
  gpuModel,
  gpuCount,
  cpuModel,
  cpuCount,
  cpuCoreCount,
  memory,
  ssdSize,
  hddSize,
  nvmeSize,
}: DemandRequestDeviceSpecsInput): string {
  return [
    `${gpuCount ? gpuCount + 'x ' : ''}${gpuModel || ''}`.trim(),
    `${cpuCount ? cpuCount + 'x ' : ''}${cpuModel || ''}${cpuCoreCount ? ` (${cpuCoreCount} cores)` : ''}`.trim(),
    memory ? `${formatSize(memory, 'GB', 2)} RAM` : '',
    ssdSize ? `${formatSize(ssdSize, 'GB', 2)} SSD` : '',
    hddSize ? `${formatSize(hddSize, 'GB', 2)} HDD` : '',
    nvmeSize ? `${formatSize(nvmeSize, 'GB', 2)} NVMe` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** Only touches digits after the point, so `decimals: 0` can't turn 100 into 1. */
function trimTrailingZeros(fixed: string): string {
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

export function parseSize(input: string | null | undefined): number | null {
  if (input == null) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgtpe]?i?b)?\s*$/i.exec(input);
  if (!match) return null;
  const unit = (match[2] ?? 'b').toUpperCase().replace('I', '');
  const index = SIZE_UNITS.findIndex((candidate) => candidate === unit);
  if (index === -1) return null;
  const bytes = Math.round(Number(match[1]) * 1024 ** index);
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > Number.MAX_SAFE_INTEGER) return null;
  return bytes;
}

// The denormalized scalars are TOTALS across every drive of the type; the mean is
// exact for uniform drives, approximate for mixed (`StorageDrive` rows are exact).
export function perDriveSizeGb(count?: number | null, totalSizeGb?: number | null): number | null {
  if (!count || !totalSizeGb) return null;
  return Math.round(totalSizeGb / count);
}

// `{count} × {per-drive size}`. `empty` covers a type the device has none of (those
// scalars come back 0/0, not null); pass `null` to defer to a caller's own fallback.
export function formatDriveCountSize(
  count?: number | null,
  totalSizeGb?: number | null,
  empty: string | null = '--',
): string | null {
  const perDrive = perDriveSizeGb(count, totalSizeGb);
  if (perDrive != null) return `${count} × ${formatSize(perDrive, 'GB')}`;
  if (count) return String(count);
  if (totalSizeGb) return formatSize(totalSizeGb, 'GB');
  return empty;
}

// `2 × 931.5 GB; 2 × 3.5 TB` — one group per distinct rendered size, smallest first.
// Prefer over `formatDriveCountSize` when `StorageDrive` rows are loaded (mixed sets have no single per-drive size).
export function formatDriveSizeGroups(
  sizesBytes: readonly (string | number | bigint)[],
  empty: string | null = '--',
): string | null {
  const groups = new Map<string, { count: number; bytes: number }>();
  for (const raw of sizesBytes) {
    const bytes = Number(raw);
    const label = formatSize(bytes);
    if (!label) continue;
    const group = groups.get(label);
    if (group) group.count += 1;
    else groups.set(label, { count: 1, bytes });
  }
  if (groups.size === 0) return empty;
  return [...groups]
    .sort(([, a], [, b]) => a.bytes - b.bytes)
    .map(([label, { count }]) => `${count} × ${label}`)
    .join('; ');
}

// Exact per-drive grouping when `StorageDrive` rows are loaded, else the averaged
// scalars; every device/server/router summary renders through this so they can't drift.
export function formatStorageTypeSize(
  drives: readonly { type: string; sizeBytes: string | number | bigint }[] | null | undefined,
  type: string,
  fallbackCount?: number | null,
  fallbackTotalSizeGb?: number | null,
  empty: string | null = '--',
): string | null {
  const sizes = (drives ?? []).filter((drive) => drive.type === type).map((drive) => drive.sizeBytes);
  return sizes.length
    ? formatDriveSizeGroups(sizes, empty)
    : formatDriveCountSize(fallbackCount, fallbackTotalSizeGb, empty);
}

export function mibSizesToGib(mibSizes: number[]): number[] {
  return [...new Set(mibSizes.map((mib) => Math.round(mib / MIB_PER_GIB)))];
}

export function formatIpAddress(ip: string) {
  return ip.split('/')[0];
}

export function formatBillingFrequency(gpuCount: number | null) {
  if (Boolean(gpuCount) === true) {
    return 'per card-hour';
  }
  return 'per hour';
}

export function formatCreditCardName(brand: string) {
  switch (brand.toLowerCase()) {
    case 'amex':
      return 'American Express';
    case 'diners':
      return 'Diners Club';
    case 'discover':
      return 'Discover';
    case 'eftpos_au':
      return 'EFTPOS';
    case 'jcb':
      return 'JCB';
    case 'mastercard':
      return 'Mastercard';
    case 'unionpay':
      return 'UnionPay';
    case 'visa':
      return 'Visa';
    default:
      return 'Card';
  }
}

export function formatCategoryTitle(category: string) {
  return category.toUpperCase();
}

export const formatBillingFrequencyInterval = (billingFrequency: string) => {
  switch (billingFrequency) {
    case BillingFrequency.HOURLY:
      return 'Hourly';
    case BillingFrequency.WEEKLY:
      return 'Weekly';
    case BillingFrequency.MONTHLY:
      return 'Monthly';
    default:
      return 'Unknown';
  }
};

export function getBillingFrequencyHours(billingFrequency: string) {
  switch (billingFrequency) {
    case BillingFrequency.MONTHLY:
      return HOURS_IN_MONTH;
    case BillingFrequency.WEEKLY:
      return HOURS_IN_WEEK;
    default:
      return 0;
  }
}

export function getBillingCadenceFromBillingFrequency(billingFrequency: BillingFrequency) {
  switch (billingFrequency) {
    case BillingFrequency.WEEKLY:
      return 'P1W';
    case BillingFrequency.MONTHLY:
      return 'P1M';
    default:
      return 'P1W';
  }
}

export const getHoursForISO8601Duration = (cadence: string) => {
  switch (cadence) {
    case 'P1W':
      return HOURS_IN_WEEK;
    case 'P1M':
      return HOURS_IN_MONTH_INDUSTRY_STANDARD;
    default:
      return 0;
  }
};

export const formatCollectionMethod = (collectionMethod: string) => {
  switch (collectionMethod) {
    case 'CHARGED_AUTOMATICALLY':
      return 'Charged Auto';
    case 'SEND_INVOICE':
      return 'Send Invoice';
    default:
      return 'Unknown';
  }
};

export function mapNetTermsToNumberOfDays(netTerms: string) {
  switch (netTerms) {
    case NetTerms.P7D:
      return 7;
    case NetTerms.P15D:
      return 15;
    case NetTerms.P30D:
      return 30;
    default:
      return null;
  }
}

export const formatNetTermsToNumberOfDays = (netTerms: NetTerms) => {
  switch (netTerms) {
    case NetTerms.P7D:
      return '7 Days';
    case NetTerms.P15D:
      return '15 Days';
    case NetTerms.P30D:
      return '30 Days';
    default:
      return '';
  }
};

export function getRoleBadgeVariant(role: string) {
  switch (role) {
    case 'Owner':
      return 'default' as const;
    case 'Admin':
      return 'secondary' as const;
    default:
      return 'outline' as const;
  }
}

export function getInventoryStatusTextColor(status: string) {
  switch (status) {
    case 'on demand':
      return 'text-emerald-500';
    case 'reserve':
      return 'text-blue-500';
    case 'preorder':
      return 'text-blue-500';
    default:
      return 'text-blue-500';
  }
}

export function getDeviceStatusBadgeVariant(status: string) {
  switch (capitalizeFirstLetter(status)) {
    case DeviceStatus.Provisioned:
    case DeviceStatus.Active:
    case DeviceStatus.Running:
      return 'success';
    case DeviceStatus.Queued:
    case DeviceStatus.Provisioning:
    case DeviceStatus.Rebooting:
    case DeviceStatus.ShuttingDown:
    case DeviceStatus.Starting:
    case DeviceStatus.Maintenance:
    case 'Awaiting approval':
      return 'warning';
    case DeviceStatus.Inventory:
    case DeviceStatus.Staged:
      return 'info';
    case DeviceStatus.Deprovisioning:
      return 'price';
    case DeviceStatus.Failed:
    case DeviceStatus.Error:
      return 'destructive';
    case DeviceStatus.PoweredOff:
      return 'secondary';
    default:
      return 'secondary';
  }
}

export function getDatacenterStatusBadgeVariant(status: string) {
  switch (status.toLowerCase()) {
    case 'active':
      return 'success';
    case 'planned':
      return 'secondary';
    case 'staging':
      return 'warning';
    case 'deprovisioning':
    case 'retired':
      return 'destructive';
    default:
      return 'default';
  }
}

export function getInvoiceStatusBadgeVariant(status: string) {
  switch (status) {
    case InvoiceStatus.PAID:
      return 'success';
    case InvoiceStatus.DRAFT:
      return 'default';
    case InvoiceStatus.VOIDED:
      return 'outline';
    case InvoiceStatus.UNCOLLECTIBLE:
    case InvoiceStatus.OVERDUE:
      return 'destructive';
    case InvoiceStatus.PAYMENT_PROCESSING:
    case InvoiceStatus.ISSUING:
    case InvoiceStatus.GATHERING:
      return 'warning';
    case InvoiceStatus.ISSUED:
      return 'secondary';
    default:
      return 'warning';
  }
}

export function getSubscriptionStatusBadgeVariant(status: string) {
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'CANCELLED':
      return 'destructive';
    case 'NEW':
      return 'secondary';
    default:
      return 'outline';
  }
}

export function getTransactionStatusBadgeVariant(status: string) {
  switch (status) {
    case TransactionStatus.SETTLED:
      return 'success';
    case TransactionStatus.FAILED:
      return 'destructive';
    default:
      return 'secondary';
  }
}

export function getBridgeStatusBadgeVariant(status: string) {
  switch (status.toLowerCase()) {
    case 'active':
      return 'success';
    case 'planned':
    case 'staged':
      return 'info';
    case 'deprovisioning':
      return 'price';
    case 'failed':
    case 'offline':
      return 'destructive';
    default:
      return 'secondary';
  }
}

export function getBridgeTypeBadgeVariant(type: string) {
  switch (type) {
    case 'managed':
      return 'info';
    case 'self-hosted':
      return 'purple';
    default:
      return 'secondary';
  }
}

export function getBridgeRequestStatusBadgeVariant(status: string) {
  switch (status.toUpperCase()) {
    case 'PENDING':
      return 'warning';
    case 'APPROVING':
      return 'info';
    case 'APPROVED':
      return 'success';
    case 'REJECTED':
      return 'destructive';
    default:
      return 'secondary';
  }
}

export function getPrefixTypeBadgeVariant(type: string) {
  switch (type) {
    case 'public':
      return 'info';
    default:
      return 'purple';
  }
}

export function getPrefixRoleBadgeVariant(role: string) {
  switch (role) {
    case 'primary':
      return 'success';
    default:
      return 'price';
  }
}

export function getIpamStatusBadgeVariant(status: string) {
  switch (status) {
    case 'ACTIVE':
      return 'default' as const;
    case 'RESERVED':
      return 'secondary' as const;
    case 'DEPRECATED':
      return 'destructive' as const;
    default:
      return 'outline' as const;
  }
}

export function getStatusPulseEffect(status: string) {
  switch (capitalizeFirstLetter(status)) {
    case DeviceStatus.Provisioning:
    case DeviceStatus.Rebooting:
    case DeviceStatus.ShuttingDown:
    case DeviceStatus.Starting:
    case DeviceStatus.Deprovisioning:
      return 'animate-pulse';
    default:
      return '';
  }
}

export const formatInterval = (interval: string) => {
  switch (interval) {
    case 'day':
      return 'Daily';
    case 'week':
      return 'Weekly';
    case 'month':
      return 'Monthly';
    case 'year':
      return 'Yearly';
    default:
      return 'Unknown';
  }
};

export const formatSubscriptionStatus = (status: string) => {
  switch (status) {
    case 'incomplete':
      return 'Incomplete';
    case 'incomplete_expired':
      return 'Incomplete Expired';
    case 'trialing':
      return 'Trialing';
    case 'active':
      return 'Active';
    case 'past_due':
      return 'Past Due';
    case 'canceled':
      return 'Canceled';
    case 'unpaid':
      return 'Unpaid';
    case 'paused':
      return 'Paused';
    default:
      return 'Unknown';
  }
};

export function formatReservationInviteBillingFrequencyInterval(reservationInvite: ReservationInvitePricing) {
  switch (reservationInvite.billingFrequency) {
    case BillingFrequency.WEEKLY:
      return 'per week';
    default:
      return 'per month';
  }
}

export function formatReservationInvitePrice(reservationInvite: ReservationInvitePricing, gpuCount: number | null) {
  if (reservationInvite.price == null) return 'Price unavailable';

  const billingFrequencyHours = getBillingFrequencyHours(reservationInvite.billingFrequency);
  if (billingFrequencyHours === 0) {
    return formatPriceFromCentsToDollars(reservationInvite.price);
  }

  return formatPriceFromCentsToDollars(
    gpuCount
      ? reservationInvite.price / billingFrequencyHours / gpuCount
      : reservationInvite.price / billingFrequencyHours,
  );
}

export function getWeeklyOrInvitePrice(
  listing: InventoryListingPricing,
  isInterruptible: boolean,
  reservationInvite?: ReservationInvitePricing,
) {
  switch (true) {
    case reservationInvite?.price != null:
      return formatPriceFromCentsToDollars(reservationInvite.price);
    case listing.listing.isInterruptibleOnly || isInterruptible:
      return formatPriceFromCentsToDollars(listing.listing.interruptiblePrice.perWeek.total!);
    default:
      return formatPriceFromCentsToDollars(listing.listing.onDemandPrice.perWeek.total!);
  }
}

export function getHourlyOrInvitePrice(
  listing: InventoryListingPricing,
  isInterruptible: boolean,
  reservationInvite?: ReservationInvitePricing,
) {
  switch (true) {
    case reservationInvite?.price != null:
      return formatReservationInvitePrice(reservationInvite, listing.specs.gpu.count);
    case listing.listing.isInterruptibleOnly || isInterruptible:
      return formatPriceFromCentsToDollars(
        listing.listing.interruptiblePrice.perHour.perGpu ?? listing.listing.interruptiblePrice.perHour.total!,
      );
    default:
      return formatPriceFromCentsToDollars(
        listing.listing.onDemandPrice.perHour.perGpu ?? listing.listing.onDemandPrice.perHour.total!,
      );
  }
}

export function mapStatusToDeploymentStatus(status: string) {
  switch (status) {
    case 'deprovisioning':
      return 'deprovisioning';
    case 'failed':
      return 'failed';
    case 'inventory':
      return 'queued';
    case 'maintenance':
      return 'maintenance';
    case 'offline':
      return 'offline';
    case 'provisioned':
      return 'provisioned';
    case 'provisioning':
      return 'provisioning';
    case 'rebooting':
      return 'rebooting';
    case 'queued':
      return 'queued';
    default:
      return 'unknown';
  }
}
