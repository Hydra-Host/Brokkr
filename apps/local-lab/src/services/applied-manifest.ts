import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { FleetPlanes } from '@repo/local-lab-contract';
import { z } from 'zod';

const AppliedRostersSchema = z.object({
  nodes: z.array(z.unknown()).default([]),
  bmNodes: z.array(z.unknown()).default([]),
});

/** the historical default, so a first bare-metal bring-up with no manifest still flips */
export const VM_ONLY: FleetPlanes = { vm: true, baremetal: false };

export function readAppliedPlanes(): FleetPlanes {
  const root = process.env.LOCAL_STATE || join(homedir(), '.local/share/local');
  const path = join(root, 'state/run/fleet-applied.json');
  try {
    const parsed = AppliedRostersSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) return VM_ONLY;
    return { vm: parsed.data.nodes.length > 0, baremetal: parsed.data.bmNodes.length > 0 };
  } catch {
    return VM_ONLY;
  }
}

export const planesEqual = (a: FleetPlanes, b: FleetPlanes): boolean => a.vm === b.vm && a.baremetal === b.baremetal;
