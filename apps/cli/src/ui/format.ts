import chalk from 'chalk';
import { customizationsSchema } from '../core/deployments/schemas.js';

export function dim(str: string): string {
  return str;
}

// base 2 — the GiB scalars this receives step to TB at 1024, not 1000.
export function formatSizeGB(sizeInGB: number | null): string {
  if (!sizeInGB || sizeInGB === 0) return '—';
  if (sizeInGB >= 1024) return `${(sizeInGB / 1024).toFixed(1).replace(/\.0$/, '')} TB`;
  return `${sizeInGB} GB`;
}

export function formatStorageLine(count: number | null, sizeGB: number | null, type: string): string | null {
  if (!count || !sizeGB) return null;
  return `${count}x ${formatSizeGB(sizeGB)} ${type}`;
}

export function centsToDollars(cents: number | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatTenantType(type: string): string {
  return type === 'SupplyCustomer' ? 'Supply' : 'Demand';
}

export function ok(msg: string): void {
  console.log(`  ${chalk.green('✓')} ${msg}`);
}

export function fail(msg: string): never {
  console.error(`  ${chalk.red('✗')} ${msg}`);
  process.exit(1);
}

export function warn(msg: string): void {
  console.log(`  ${chalk.yellow(msg)}`);
}

export function info(label: string, value: string): void {
  console.log(`  ${label}: ${value}`);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function parseToggle(value: string, flagName: string): boolean {
  if (value !== 'on' && value !== 'off') {
    fail(`Invalid ${flagName} value "${value}". Must be: on, off`);
  }
  return value === 'on';
}

export function parseCsvFlag(value: string | undefined, emptyErrorMessage: string): string[] | undefined {
  if (value === undefined) return undefined;
  const parsed = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parsed.length === 0) fail(emptyErrorMessage);
  return parsed;
}

export function parseCustomizationsFlag(value: string | undefined): Record<string, string | string[]> | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail('Invalid --customizations JSON. Must be a JSON object keyed by layer group slug.');
  }
  const validated = customizationsSchema.safeParse(parsed);
  if (!validated.success) {
    fail(`Invalid --customizations: ${validated.error.issues.map((i) => i.message).join(', ')}`);
  }
  return validated.data ?? null;
}

const INTERNAL_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
];

export function validateHttpsUrl(url: string, label: string = 'URL'): void {
  let isValid = true;
  let protocol = '';
  try {
    const parsed = new URL(url);
    protocol = parsed.protocol;
  } catch {
    isValid = false;
  }
  if (!isValid) fail(`${label} must be a valid URL`);
  if (protocol !== 'https:') fail(`${label} must use HTTPS protocol`);
}

export function validateSsrfSafeHttpsUrl(url: string, label: string = 'URL'): void {
  validateHttpsUrl(url, label);
  const { hostname } = new URL(url);
  if (INTERNAL_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname))) {
    fail(`${label} cannot point to an internal or reserved address`);
  }
}
