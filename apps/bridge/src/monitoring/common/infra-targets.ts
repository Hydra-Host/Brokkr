import { isRecord } from '@repo/utils';

export const KIND_SERVER = 'server';
export const KIND_PDU = 'pdu';
export const KIND_CDU = 'cdu';

export const ROLE_TO_KIND: Record<string, string> = {
  pdu: KIND_PDU,
  'rack-pdu': KIND_PDU,
  cdu: KIND_CDU,
  'coolant-distribution-unit': KIND_CDU,
};

const ROLE_KEYS = ['role', 'device_role'] as const;

export function extractRole(deviceData: unknown): string | null {
  if (!isRecord(deviceData)) return null;
  for (const key of ROLE_KEYS) {
    const value = deviceData[key];
    if (isRecord(value)) {
      const slug = value.slug;
      const name = value.name;
      const chosen = slug ? slug : name ? name : null;
      if (chosen) {
        return String(chosen).toLowerCase();
      }
    } else if (typeof value === 'string' && value.length > 0) {
      return value.toLowerCase();
    }
  }
  return null;
}

export function classifyRole(role: string | null | undefined): string {
  if (role === null || role === undefined) return KIND_SERVER;
  const key = role.toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROLE_TO_KIND, key) ? ROLE_TO_KIND[key] : KIND_SERVER;
}

export interface ClassifiedTarget {
  deviceId: string;
  role: string | null;
  kind: string;
}

export interface InfraTargetsCache {
  scan(pattern: string, jobId?: string): Promise<string[]>;
  get(key: string, jobId?: string): Promise<string | null>;
}

export interface InfraTargetsDeps {
  iterActiveDeviceIds(cache: InfraTargetsCache, jobId?: string): AsyncIterable<string>;
  getCachedDeviceData(
    cache: InfraTargetsCache,
    deviceId: string,
    jobId?: string,
  ): Promise<Record<string, unknown> | null>;
}

export async function* iterClassifiedTargets(
  cache: InfraTargetsCache,
  deps: InfraTargetsDeps,
  jobId = '',
): AsyncIterableIterator<ClassifiedTarget> {
  for await (const deviceId of deps.iterActiveDeviceIds(cache, jobId)) {
    const data = await deps.getCachedDeviceData(cache, deviceId, jobId);
    const role = extractRole(data);
    yield { deviceId, role, kind: classifyRole(role) };
  }
}
