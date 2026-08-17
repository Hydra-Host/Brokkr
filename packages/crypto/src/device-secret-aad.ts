import { Buffer } from 'node:buffer';

export const DEVICE_SECRET_AAD_VERSION = 1;

/** `zoneKeyId` binds the blob to the sealing enrollment beyond `keyGen` — a blob can never open under a different enrollment even with matching generations. */
export interface DeviceSecretAadFields {
  zoneId: string;
  zoneKeyId: string;
  deviceId: string;
  purpose: string;
  kind: string;
  keyGen: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateFields(fields: DeviceSecretAadFields): void {
  for (const key of ['zoneId', 'zoneKeyId', 'deviceId', 'purpose', 'kind'] as const) {
    if (!isNonEmptyString(fields[key])) {
      throw new Error(`deviceSecretAad.${key} must be a non-empty string`);
    }
  }
  const { keyGen } = fields;
  if (typeof keyGen !== 'number' || !Number.isInteger(keyGen) || keyGen < 0) {
    throw new Error('deviceSecretAad.keyGen must be a non-negative integer');
  }
}

export function deviceSecretAad(fields: DeviceSecretAadFields): Buffer {
  validateFields(fields);
  const flat: Record<string, string | number> = {
    aad_v: DEVICE_SECRET_AAD_VERSION,
    device_id: fields.deviceId,
    key_gen: fields.keyGen,
    purpose: 'device-secret',
    secret_kind: fields.kind,
    secret_purpose: fields.purpose,
    zone_id: fields.zoneId,
    zone_key_id: fields.zoneKeyId,
  };
  const sorted: Record<string, string | number> = {};
  for (const key of Object.keys(flat).sort()) {
    const value = flat[key];
    if (value !== undefined) sorted[key] = value;
  }
  return Buffer.from(JSON.stringify(sorted), 'utf8');
}
