import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { FleetMode } from '@repo/local-lab-contract';

export function readAppliedMode(): FleetMode {
  const root = process.env.LOCAL_STATE || join(homedir(), '.local/share/local');
  const path = join(root, 'state/run/fleet-applied.json');
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (raw && typeof raw === 'object' && 'mode' in raw && raw.mode === 'baremetal') return 'baremetal';
    return 'vm';
  } catch {
    return 'vm';
  }
}
