import {
  type BulkUpdateDcimInterface,
  type DeviceInterfaceWithIps,
  DcimInterfaceTypeSchema,
  INTERFACE_NAME_MESSAGE,
  INTERFACE_NAME_REGEX,
  MAC_ADDRESS_REGEX,
} from '@repo/api-client';

// sentinel for "no value" select options — base-ui Select forbids empty-string values
export const NONE = '__none__';

export function formatSpeed(speed: number | null): string {
  if (!speed) return '--';
  return speed >= 1000 ? `${speed / 1000}G` : `${speed}M`;
}

// ── draft state for in-cell editing ───────────────────────────────────────

export interface Draft {
  name: string;
  type: string;
  macAddress: string;
  speed: string;
  mtu: string;
  enabled: boolean;
  markConnected: boolean;
}

// unsaved row in the add-interface flow — a Draft plus a client-side key
export interface NewRow extends Draft {
  tempId: string;
}

// Monotonic client-side key for unsaved rows. Not crypto.randomUUID() — that
// throws outside a secure context (http), which boss is sometimes served over.
let newRowSeq = 0;

export function blankNewRow(): NewRow {
  return {
    tempId: `new-${newRowSeq++}`,
    name: '',
    type: NONE,
    macAddress: '',
    speed: '',
    mtu: '',
    enabled: true,
    markConnected: false,
  };
}

export function toDraft(i: DeviceInterfaceWithIps): Draft {
  return {
    name: i.name,
    type: i.type ?? NONE,
    macAddress: i.macAddress ?? '',
    speed: i.speed?.toString() ?? '',
    mtu: i.mtu?.toString() ?? '',
    enabled: i.enabled,
    markConnected: i.markConnected,
  };
}

export function parseIntOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isNaN(n) ? null : n;
}

// ── validation ─────────────────────────────────────────────────────────────

export const normMac = (s: string): string => s.trim().toLowerCase().replace(/[.:-]/g, '');

export interface RowErrors {
  name?: string;
  macAddress?: string;
  speed?: string;
  mtu?: string;
}

// is a not-yet-saved row worth validating/saving? (any field touched)
export const isActiveNewRow = (r: NewRow): boolean =>
  r.name.trim() !== '' || r.macAddress.trim() !== '' || r.speed.trim() !== '' || r.mtu.trim() !== '';

export function fieldErrors(
  name: string,
  macAddress: string,
  speed: string,
  mtu: string,
  nameCount: Map<string, number>,
  macCount: Map<string, number>,
): RowErrors {
  const e: RowErrors = {};
  const n = name.trim();
  if (!n) e.name = 'Name is required';
  else if ((nameCount.get(n) ?? 0) > 1) e.name = 'Duplicate name';
  // Match the contract's name guard client-side (INTERFACE_NAME_REGEX) so an invalid name is caught
  // here instead of surfacing as an opaque 400 from the server on save.
  else if (!INTERFACE_NAME_REGEX.test(n)) e.name = INTERFACE_NAME_MESSAGE;

  const m = macAddress.trim();
  if (m) {
    if (!MAC_ADDRESS_REGEX.test(m)) e.macAddress = 'Invalid MAC address';
    else if ((macCount.get(normMac(m)) ?? 0) > 1) e.macAddress = 'Duplicate MAC';
  }

  const s = parseIntOrNull(speed);
  if (speed.trim() && (s === null || s < 0)) e.speed = 'Invalid number';
  const u = parseIntOrNull(mtu);
  if (mtu.trim() && (u === null || u < 0)) e.mtu = 'Invalid number';
  return e;
}

export function validateEdits(args: {
  interfaces: DeviceInterfaceWithIps[];
  allInterfaces: DeviceInterfaceWithIps[];
  drafts: Record<string, Draft>;
  newRows: NewRow[];
  markedDelete: Set<string>;
}): { byId: Record<string, RowErrors>; byTempId: Record<string, RowErrors>; hasErrors: boolean } {
  const { interfaces, allInterfaces, drafts, newRows, markedDelete } = args;
  const tableIds = new Set(interfaces.map((i) => i.id));

  // effective (name, mac) of every interface that will exist after save
  const entries: { name: string; mac: string }[] = [];
  for (const i of allInterfaces) {
    if (markedDelete.has(i.id)) continue;
    const d = tableIds.has(i.id) ? drafts[i.id] : undefined;
    entries.push({ name: (d?.name ?? i.name).trim(), mac: normMac(d?.macAddress ?? i.macAddress ?? '') });
  }
  const activeNew = newRows.filter(isActiveNewRow);
  for (const r of activeNew) {
    if (r.name.trim()) entries.push({ name: r.name.trim(), mac: normMac(r.macAddress) });
  }

  const nameCount = new Map<string, number>();
  const macCount = new Map<string, number>();
  for (const e of entries) {
    if (e.name) nameCount.set(e.name, (nameCount.get(e.name) ?? 0) + 1);
    if (e.mac) macCount.set(e.mac, (macCount.get(e.mac) ?? 0) + 1);
  }

  const byId: Record<string, RowErrors> = {};
  for (const i of interfaces) {
    if (markedDelete.has(i.id)) continue;
    const d = drafts[i.id];
    if (!d) continue;
    const e = fieldErrors(d.name, d.macAddress, d.speed, d.mtu, nameCount, macCount);
    if (Object.keys(e).length) byId[i.id] = e;
  }
  const byTempId: Record<string, RowErrors> = {};
  for (const r of activeNew) {
    const e = fieldErrors(r.name, r.macAddress, r.speed, r.mtu, nameCount, macCount);
    if (Object.keys(e).length) byTempId[r.tempId] = e;
  }

  return { byId, byTempId, hasErrors: Object.keys(byId).length > 0 || Object.keys(byTempId).length > 0 };
}

// build an update body containing only the fields that differ from the persisted row
export function buildPatch(orig: DeviceInterfaceWithIps, d: Draft): Omit<BulkUpdateDcimInterface, 'id'> {
  const body: Omit<BulkUpdateDcimInterface, 'id'> = {};
  // Trim to match the create path (buildCreateBody) and fieldErrors, which both validate the trimmed
  // name — otherwise a trailing/leading-space name passes client validation then 400s on the server regex.
  const name = d.name.trim();
  if (name !== orig.name) body.name = name;
  const type = d.type === NONE ? null : DcimInterfaceTypeSchema.parse(d.type);
  if (type !== (orig.type ?? null)) body.type = type;
  const mac = d.macAddress.trim() || null;
  if (mac !== (orig.macAddress ?? null)) body.macAddress = mac;
  const speed = parseIntOrNull(d.speed);
  if (speed !== (orig.speed ?? null)) body.speed = speed;
  const mtu = parseIntOrNull(d.mtu);
  if (mtu !== (orig.mtu ?? null)) body.mtu = mtu;
  if (d.enabled !== orig.enabled) body.enabled = d.enabled;
  if (d.markConnected !== orig.markConnected) body.markConnected = d.markConnected;
  return body;
}
