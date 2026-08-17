import type { ToastApi } from '@/lib/toast';

// Surface every control-action outcome so a failed or blocked start/stop is never silent —
// a 200 with ok=false did nothing (detail says why); a non-200 carries the error.
export function reportControl(
  toast: ToastApi,
  id: string,
  action: string,
  data: { status: number; body: { ok?: boolean; detail?: string; error?: string } },
): void {
  if (data.status === 200 && data.body.ok) toast.ok(data.body.detail ?? `${id}: ${action} ok`);
  else if (data.status === 200) toast.error(data.body.detail ?? `${id}: ${action} did nothing`);
  else toast.error(data.body.error ?? `${id}: ${action} failed`);
}
