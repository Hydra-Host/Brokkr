import { isRecord } from '@repo/utils';

import { readHandleLabel } from '../common/redis/redis-handle-label';

export function activeResourceCount(): number {
  return process.getActiveResourcesInfo().length;
}

// names what is still keeping the libuv loop referenced. Read from the undocumented handle list
// when available, falling back to the public resource-kind census.
export function describeActiveHandles(): string {
  const summary = resourceCensus();
  const handles = process._getActiveHandles?.();
  if (handles === undefined) return `${summary}; handle detail unavailable`;
  const details = handles.map(describeHandle).join(', ');
  return `${summary}; handles[${handles.length}]: ${details === '' ? 'none' : details}`;
}

function resourceCensus(): string {
  const resources = process.getActiveResourcesInfo();
  const counts = new Map<string, number>();
  for (const kind of resources) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const census = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, count]) => `${kind}=${count}`)
    .join(' ');
  return `resources[${resources.length}]: ${census === '' ? 'none' : census}`;
}

function describeHandle(handle: unknown): string {
  if (!isRecord(handle)) return `<${typeof handle}>`;
  const parts: string[] = [typeName(handle)];

  const label = readHandleLabel(handle);
  if (label !== null) parts.push(`label=${label}`);

  const fd = numberAt(handle, 'fd') ?? nestedFd(handle);
  if (fd !== null) parts.push(`fd=${fd}`);

  const remoteAddress = stringAt(handle, 'remoteAddress');
  if (remoteAddress !== null) parts.push(`remote=${remoteAddress}:${numberAt(handle, 'remotePort') ?? '?'}`);

  const localPort = numberAt(handle, 'localPort');
  if (localPort !== null) parts.push(`localPort=${localPort}`);

  const idleTimeout = numberAt(handle, '_idleTimeout');
  if (idleTimeout !== null) parts.push(`idleTimeout=${idleTimeout}`);

  const repeat = numberAt(handle, '_repeat');
  if (repeat !== null) parts.push(`repeat=${repeat}`);

  const onTimeout = handle._onTimeout;
  if (typeof onTimeout === 'function') parts.push(`onTimeout=${onTimeout.name === '' ? 'anonymous' : onTimeout.name}`);

  return `{${parts.join(' ')}}`;
}

function typeName(handle: Record<string, unknown>): string {
  const ctor = handle.constructor;
  if (typeof ctor === 'function' && ctor.name !== '') return ctor.name;
  return 'unknown';
}

function nestedFd(handle: Record<string, unknown>): number | null {
  const inner = handle._handle;
  return isRecord(inner) ? numberAt(inner, 'fd') : null;
}

function numberAt(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' ? value : null;
}

function stringAt(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}
