export const IDENTIFIER_KINDS = [
  'mac',
  'ip',
  'ipmi_mac',
  'ipmi_ip',
  'system_uuid',
  'serial',
  'chassis_serial',
  'board_serial',
  'manufacturer',
] as const;

export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

export const MAC_KINDS: ReadonlySet<string> = new Set(['mac', 'ipmi_mac']);

// BMC USB/RNDIS NICs share firmware-default LAA MACs across identical hardware, so these must not be device-identity keys; malformed input is treated as usable.
export function isLocallyAdministeredMac(value: string): boolean {
  const first = value.replace(/-/g, ':').split(':', 1)[0] ?? '';
  if (!/^[0-9a-fA-F]+$/.test(first)) return false;
  return (parseInt(first, 16) & 0x02) !== 0;
}

// BIOS/SMBIOS filler strings repeat across machines and would collide as device:lookup keys; superset of the hub discovery transform's garbage lists (apps/api/src/brokkr-bridge/discovery/collectors/hardware-string.ts) — different path, kept separate deliberately.
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^to be filled/i,
  /^default string$/i,
  /^not applicable$/i,
  /^not specified$/i,
  /^unknown$/i,
  /^none$/i,
  /^0+$/,
  /^0123456789/,
  /^system (serial number|manufacturer|product name|version|sku number)$/i,
  /^free form asset tag$/i,
  /^chassis asset tag$/i,
];

const PLACEHOLDER_EXACT: ReadonlySet<string> = new Set(['na', 'n/a']);

export function isHardwarePlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_EXACT.has(trimmed.toLowerCase())) return true;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}
