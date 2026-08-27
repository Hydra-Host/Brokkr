import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BRIDGE_SERVICES_JOBSPEC_ID, SHIPPED_JOBSPEC_IDS, type ShippedJobspecId } from '../schemas';

export { BRIDGE_SERVICES_JOBSPEC_ID, SHIPPED_JOBSPEC_IDS, type ShippedJobspecId };

/** Sample variable values that satisfy every required var in bridge-services.hcl. */
export const BRIDGE_SERVICES_SAMPLE_VARIABLES = {
  job_name: 'bridge-services-example',
  datacenter: 'dc1',
  zone_id: 'example-zone',
  bridge_api_image: 'example.com/brokkr/bridge-api:1.0.0',
  bind_image: 'example.com/brokkr/bind9:1.0.0',
  kea_image: 'example.com/brokkr/kea-dhcp:1.0.0',
} as const;

function assertShippedJobspecId(id: string): asserts id is ShippedJobspecId {
  if (!(SHIPPED_JOBSPEC_IDS as readonly string[]).includes(id)) {
    throw new Error(`Unknown shipped jobspec id: ${id}`);
  }
}

/** Resolve package-root `jobspecs/` from compiled (`dist/cjs/backend`) or source (`backend/`). */
function resolveJobspecsDir(): string {
  const fromDist = join(__dirname, '..', '..', '..', 'jobspecs');
  if (existsSync(fromDist)) return fromDist;
  const fromSrc = join(__dirname, '..', 'jobspecs');
  if (existsSync(fromSrc)) return fromSrc;
  throw new Error(`Nomad plugin jobspecs/ directory not found (looked beside ${__dirname})`);
}

/** Absolute path to a shipped HCL jobspec. */
export function getJobspecPath(id: string = BRIDGE_SERVICES_JOBSPEC_ID): string {
  assertShippedJobspecId(id);
  return join(resolveJobspecsDir(), `${id}.hcl`);
}

/** Load a shipped jobspec's HCL text from disk. */
export function loadJobspec(id: string = BRIDGE_SERVICES_JOBSPEC_ID): string {
  return readFileSync(getJobspecPath(id), 'utf8');
}
