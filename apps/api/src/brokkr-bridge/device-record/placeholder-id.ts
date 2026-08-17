import { createHash } from 'node:crypto';
import type { IpxeIdentifierBundle } from '../types/render-request.types';

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// Frozen — regenerating it would change every existing placeholder's identity.
export const PLACEHOLDER_NAMESPACE_UUID = '6f4a1f9e-2c3d-5b7a-9e10-4d2c8f6b3a51';

// Must be stable per bundle (retries resolve to the same placeholder); normalization must match deviceLookup()'s canonical form.
export function placeholderIdFromBundle(bundle: IpxeIdentifierBundle): string {
  const canonical = JSON.stringify({
    mac: normalizeMac(bundle.mac),
    ipmi_mac: normalizeMac(bundle.ipmi_mac),
    system_uuid: bundle.system_uuid?.toLowerCase() ?? null,
    serial: bundle.serial?.toLowerCase() ?? null,
    chassis_serial: bundle.chassis_serial?.toLowerCase() ?? null,
    board_serial: bundle.board_serial?.toLowerCase() ?? null,
  });
  return uuidv5(canonical, PLACEHOLDER_NAMESPACE_UUID);
}

export function uuidv5(name: string, namespace: string): string {
  const namespaceBytes = uuidToBytes(namespace);
  const hash = createHash('sha1').update(namespaceBytes).update(Buffer.from(name, 'utf8')).digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return bytesToUuid(bytes);
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`Invalid namespace UUID: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function normalizeMac(mac: string | undefined): string | null {
  if (!mac) return null;
  return mac.toLowerCase().replace(/:/g, '-');
}
