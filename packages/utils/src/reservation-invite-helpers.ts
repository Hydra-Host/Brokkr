import { BillingFrequency } from './enums';
import { getBillingFrequencyHours } from './format';

export type NoticePeriodUnit = 'minutes' | 'hours' | 'days' | 'weeks';

const UNIT_TO_MS: Record<NoticePeriodUnit, number> = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
};

export function calculateNoticePeriodMs(value: number, unit: NoticePeriodUnit): number {
  return value * UNIT_TO_MS[unit];
}

export function parseNoticePeriodMs(ms: number): { value: number; unit: NoticePeriodUnit } {
  if (ms >= UNIT_TO_MS.weeks && ms % UNIT_TO_MS.weeks === 0) {
    return { value: ms / UNIT_TO_MS.weeks, unit: 'weeks' };
  }
  if (ms >= UNIT_TO_MS.days && ms % UNIT_TO_MS.days === 0) {
    return { value: ms / UNIT_TO_MS.days, unit: 'days' };
  }
  if (ms >= UNIT_TO_MS.hours && ms % UNIT_TO_MS.hours === 0) {
    return { value: ms / UNIT_TO_MS.hours, unit: 'hours' };
  }
  return { value: ms / UNIT_TO_MS.minutes, unit: 'minutes' };
}

export const DC_SALES_SUPPLIER_MARGIN = 0.049;

export type CalculatedField = 'buyerPrice' | 'supplierPrice' | 'margin';

interface PriceCalculationResult {
  buyerPrice: number;
  supplierPrice: number;
  margin: number;
}

export function calculatePrices(
  buyerPrice: number,
  supplierPrice: number,
  margin: number,
  calculatedField: CalculatedField,
): PriceCalculationResult {
  switch (calculatedField) {
    case 'margin': {
      const m = buyerPrice > 0 ? (buyerPrice - supplierPrice) / buyerPrice : 0;
      return { buyerPrice, supplierPrice, margin: Math.round(m * 10000) / 10000 };
    }
    case 'buyerPrice': {
      const bp = margin < 1 ? Math.round(supplierPrice / (1 - margin)) : 0;
      return { buyerPrice: bp, supplierPrice, margin };
    }
    case 'supplierPrice': {
      const sp = Math.round(buyerPrice * (1 - margin));
      return { buyerPrice, supplierPrice: sp, margin };
    }
  }
}

export function scalePricesForFrequencyChange(
  buyerPrice: number,
  supplierPrice: number,
  fromFrequency: BillingFrequency,
  toFrequency: BillingFrequency,
): { buyerPrice: number; supplierPrice: number } {
  const fromHours = getBillingFrequencyHours(fromFrequency);
  const toHours = getBillingFrequencyHours(toFrequency);

  if (fromHours === 0 || toHours === 0) {
    return { buyerPrice, supplierPrice };
  }

  const ratio = toHours / fromHours;
  return {
    buyerPrice: Math.round(buyerPrice * ratio),
    supplierPrice: Math.round(supplierPrice * ratio),
  };
}

export function formatBillingFrequencyCopy(billingFrequency: string): string {
  switch (billingFrequency) {
    case BillingFrequency.MONTHLY:
      return 'Device/Month';
    case BillingFrequency.WEEKLY:
      return 'Device/Week';
    default:
      return '';
  }
}

export const NOTICE_PERIOD_UNIT_OPTIONS: { label: string; value: NoticePeriodUnit }[] = [
  { label: 'Minutes', value: 'minutes' },
  { label: 'Hours', value: 'hours' },
  { label: 'Days', value: 'days' },
];
