/** Boot trail for a failed OS wait; anything unreadable returns null, costing a diagnostic line, not the assertion. */

import { z } from 'zod';

import { CONTROL_CENTER_URL } from './spoke-ha';

const MachineRowSchema = z.object({ name: z.string(), deviceId: z.string().nullable() });

const BootTrailSchema = z.object({
  pxe: z.object({ outcome: z.string(), atMs: z.number() }).nullable(),
  chainReached: z.boolean().nullable(),
  chainAtMs: z.number().nullable(),
  readError: z.string().nullable(),
});

export type BootTrail = z.infer<typeof BootTrailSchema>;

export function formatBootTrailLine(trail: BootTrail): string {
  if (trail.readError !== null) return `boot trail unreadable: ${trail.readError}`;
  if (trail.pxe === null) return 'no PXE request seen';

  const pxe = `PXE ${trail.pxe.outcome} at ${new Date(trail.pxe.atMs).toISOString()}`;
  if (trail.chainReached !== true) return `${pxe}; iPXE chain not reached`;

  const chainAt = typeof trail.chainAtMs === 'number' ? ` at ${new Date(trail.chainAtMs).toISOString()}` : '';
  return `${pxe}; iPXE chain reached${chainAt}`;
}

// spoke-ha's ccGet is module-private and casts its body to the caller's type; this one hands the
// body back unknown so every read below goes through a schema.
async function ccJson(urlPath: string): Promise<unknown> {
  const response = await fetch(`${CONTROL_CENTER_URL}${urlPath}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return null;
  return await response.json();
}

export async function readBootTrailLine(deviceId: string): Promise<string | null> {
  try {
    const machines = z.array(MachineRowSchema).safeParse(await ccJson('/api/fleet/machines'));
    if (!machines.success) return null;

    const row = machines.data.find((machine) => machine.deviceId === deviceId);
    if (!row) return null;

    const trail = BootTrailSchema.safeParse(
      await ccJson(`/api/fleet/machines/${encodeURIComponent(row.name)}/boot-trail`),
    );
    return trail.success ? formatBootTrailLine(trail.data) : null;
  } catch {
    return null;
  }
}
