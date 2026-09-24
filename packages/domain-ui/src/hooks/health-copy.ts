import type { DeviceHealthSummary } from '@repo/api-client';
import { isRecord } from '@repo/utils';
import { httpStatusOf } from './api-errors';

export function relativeTime(iso: string, nowMs: number): string {
  const minutes = Math.round(Math.max(0, nowMs - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function healthSummaryLine(summary: DeviceHealthSummary, nowMs: number): string {
  if (summary.source === 'none' || summary.checkedAt === null) return 'No health check is known for this device.';
  if (summary.source === 'snapshot') return `Last checked ${relativeTime(summary.checkedAt, nowMs)}.`;
  return `Last change ${relativeTime(summary.checkedAt, nowMs)}. No check result in the last 10 minutes is known.`;
}

export const HEALTH_REQUESTED_MESSAGE =
  'Check requested. A new row appears only if a result changed; the snapshot updates within 10 minutes.';

const FALLBACK_BY_STATUS: Record<number, string> = {
  400: 'The bridge cannot probe this device.',
  403: 'You do not have permission to perform this action.',
  409: 'The stored BMC credential was rejected. Update the credential before requesting another check, because each check logs in again.',
  429: 'A check was requested less than five minutes ago. The scheduled check runs every five minutes.',
};

export function healthRequestMessage(error: unknown): string {
  const status = httpStatusOf(error);
  const apiMessage =
    isRecord(error) && isRecord(error.body) && typeof error.body.message === 'string' ? error.body.message : null;
  if (status !== undefined && apiMessage !== null) return apiMessage;
  return (status !== undefined ? FALLBACK_BY_STATUS[status] : undefined) ?? 'The health check could not be requested.';
}
