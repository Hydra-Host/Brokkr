import { createHash } from 'node:crypto';

export const AGENT_TOKEN_HASH_PREFIX = 'agent-token:hash:';
export const AGENT_TOKEN_DEVICE_PREFIX = 'agent-token:device:';
export const AGENT_TOKEN_DISCOVERY_PREFIX = 'agent-token:discovery:';

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex');
}

export function hashKey(tokenHash: string): string {
  return `${AGENT_TOKEN_HASH_PREFIX}${tokenHash}`;
}

export function deviceKey(deviceId: string): string {
  return `${AGENT_TOKEN_DEVICE_PREFIX}${deviceId}`;
}

export function discoveryKey(discoveryId: string): string {
  return `${AGENT_TOKEN_DISCOVERY_PREFIX}${discoveryId}`;
}

function escapeJsonString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (code === 0x08) out += '\\b';
    else if (code === 0x09) out += '\\t';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0d) out += '\\r';
    else if (code < 0x20 || code > 0x7e) {
      if (code > 0xffff) {
        const cp = code - 0x10000;
        const hi = 0xd800 | (cp >> 10);
        const lo = 0xdc00 | (cp & 0x3ff);
        out += '\\u' + hi.toString(16).padStart(4, '0') + '\\u' + lo.toString(16).padStart(4, '0');
      } else {
        out += '\\u' + code.toString(16).padStart(4, '0');
      }
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function serializeValue(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return v.toString();
  if (typeof v === 'string') return escapeJsonString(v);
  if (Array.isArray(v)) return `[${v.map(serializeValue).join(', ')}]`;
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(obj)) {
      parts.push(`${escapeJsonString(k)}: ${serializeValue(obj[k])}`);
    }
    return `{${parts.join(', ')}}`;
  }
  throw new Error(`unsupported value type for token payload: ${typeof v}`);
}

export function serializeTokenPayload(payload: Record<string, unknown>): string {
  return serializeValue(payload);
}

export interface DeviceHashPayload {
  kind: 'device';
  device_id: string;
  issued_at: number;
}

export interface DiscoveryHashPayload {
  kind: 'discovery';
  discovery_id: string;
  issued_at: number;
  expires_at: number;
}

export interface DeviceReusePayload {
  token: string;
  hash: string;
  issued_at: number;
}

export interface DiscoveryReusePayload {
  token: string;
  hash: string;
  issued_at: number;
  expires_at: number;
}

export type TokenHashPayload = DeviceHashPayload | DiscoveryHashPayload;
export type TokenReusePayload = DeviceReusePayload | DiscoveryReusePayload;
