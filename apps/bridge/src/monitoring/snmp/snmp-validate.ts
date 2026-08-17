// Security boundary: enforces version/security-level/auth/priv allowlists to prevent SNMP auth bypass.

import { isIPv4, isIPv6 } from 'node:net';

import type { SnmpParams } from '../../snmp/auth';

export class SnmpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnmpValidationError';
  }
}

export interface SnmpValidatorAllowlists {
  allowedVersions: ReadonlyArray<string>;
  allowedSecurityLevels: ReadonlyArray<string>;
  allowedAuthProtocols: ReadonlyArray<string>;
  allowedPrivProtocols: ReadonlyArray<string>;
}

const OID_RE = /^[0-9]+(\.[0-9]+)+$/;
const INT_STR_RE = /^[+-]?\d(_?\d)*$/;

export function validateSnmpParams(params: Record<string, unknown>, config: SnmpValidatorAllowlists): SnmpParams {
  const rawVersion = params.version;
  const version = rawVersion === undefined ? '3' : String(rawVersion);
  if (!config.allowedVersions.includes(version)) {
    throw new SnmpValidationError(
      `SNMP version '${version}' not supported. Allowed: ${formatList(config.allowedVersions)}`,
    );
  }

  const validated: SnmpParams = { version };

  if (version === '1' || version === '2c') {
    const community = requiredCredential(params.community);
    if (community === null) {
      throw new SnmpValidationError('Community string required for SNMPv1/v2c');
    }
    validated.community = community;
    return validated;
  }

  const username = requiredCredential(params.username);
  if (username === null) {
    throw new SnmpValidationError('Username required for SNMPv3');
  }
  validated.username = username;

  const rawSecLevel = params.security_level;
  let securityLevel: unknown;
  if (rawSecLevel === undefined) {
    securityLevel = 'authPriv';
  } else {
    securityLevel = rawSecLevel;
  }
  if (!isAllowedString(securityLevel, config.allowedSecurityLevels)) {
    throw new SnmpValidationError(`Security level '${String(securityLevel)}' not supported`);
  }
  validated.security_level = securityLevel as string;

  if (securityLevel === 'authNoPriv' || securityLevel === 'authPriv') {
    const authProtocolRaw = requiredCredential(params.auth_protocol);
    if (authProtocolRaw === null) {
      throw new SnmpValidationError('auth_protocol required for authNoPriv/authPriv');
    }
    const authProtocol = authProtocolRaw.toUpperCase();
    if (!config.allowedAuthProtocols.includes(authProtocol)) {
      throw new SnmpValidationError(
        `Auth protocol '${authProtocol}' not supported. Allowed: ${formatList(config.allowedAuthProtocols)}`,
      );
    }
    validated.auth_protocol = authProtocol;

    const authPassphrase = requiredCredential(params.auth_passphrase);
    if (authPassphrase === null) {
      throw new SnmpValidationError('auth_passphrase required for authNoPriv/authPriv');
    }
    validated.auth_passphrase = authPassphrase;
  }

  if (securityLevel === 'authPriv') {
    const privProtocolRaw = requiredCredential(params.priv_protocol);
    if (privProtocolRaw === null) {
      throw new SnmpValidationError('priv_protocol required for authPriv');
    }
    const privProtocol = privProtocolRaw.toUpperCase();
    if (!config.allowedPrivProtocols.includes(privProtocol)) {
      throw new SnmpValidationError(
        `Priv protocol '${privProtocol}' not supported. Allowed: ${formatList(config.allowedPrivProtocols)}`,
      );
    }
    validated.priv_protocol = privProtocol;

    const privPassphrase = requiredCredential(params.priv_passphrase);
    if (privPassphrase === null) {
      throw new SnmpValidationError('priv_passphrase required for authPriv');
    }
    validated.priv_passphrase = privPassphrase;
  }

  return validated;
}

export function validateIpAddress(ipString: string): string {
  const trimmed = ipString.trim();
  if (isIPv4(trimmed) && isStrictIpv4(trimmed)) {
    return trimmed;
  }
  if (isIPv6(trimmed)) {
    return canonicalIpv6(trimmed);
  }
  throw new SnmpValidationError(`Invalid IP address format: ${ipString}`);
}

export function validateOid(oid: string): string {
  let cleaned = oid.trim();
  if (cleaned.startsWith('.')) {
    cleaned = cleaned.slice(1);
  }
  if (!OID_RE.test(cleaned)) {
    throw new SnmpValidationError(`Invalid OID format: ${cleaned}`);
  }
  return cleaned;
}

export function validatePort(port: unknown): number {
  const portInt = toInt(port);
  if (portInt === null) {
    throw new SnmpValidationError('Invalid port number');
  }
  if (portInt < 1 || portInt > 65535) {
    throw new SnmpValidationError('Port must be between 1 and 65535');
  }
  return portInt;
}

function requiredCredential(value: unknown): string | null {
  if (value == null || value === '' || value === false || value === 0) return null;
  if (typeof value === 'string') return value;
  return String(value);
}

function isAllowedString(value: unknown, allowed: ReadonlyArray<string>): value is string {
  return typeof value === 'string' && allowed.includes(value);
}

function formatList(items: ReadonlyArray<string>): string {
  return `[${items.map((s) => `'${s}'`).join(', ')}]`;
}

function isStrictIpv4(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (p.length === 0 || p.length > 3) return false;
    if (p.length > 1 && p.startsWith('0')) return false;
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i);
      if (c < 48 || c > 57) return false;
    }
    const n = Number(p);
    if (n > 255) return false;
  }
  return true;
}

function v4TailToGroups(token: string): number[] {
  const octets = token.split('.').map((o) => parseInt(o, 10));
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  return [a * 256 + b, c * 256 + d];
}

function expandIpv6(addr: string): number[] {
  const sides = addr.split('::');
  const tokensOf = (side: string): number[] => {
    const groups: number[] = [];
    for (const token of side.split(':')) {
      if (token === '') continue;
      if (token.includes('.')) {
        groups.push(...v4TailToGroups(token));
      } else {
        groups.push(parseInt(token, 16));
      }
    }
    return groups;
  };
  const left = tokensOf(sides[0] ?? '');
  if (sides.length === 1) return left;
  const right = tokensOf(sides[1] ?? '');
  const fill = new Array<number>(8 - left.length - right.length).fill(0);
  return [...left, ...fill, ...right];
}

function compressIpv6(groups: ReadonlyArray<number>): string {
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === 0) {
      if (curStart === -1) curStart = i;
      curLen++;
    } else {
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
      curStart = -1;
      curLen = 0;
    }
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen > 1) {
    return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
  }
  return hex.join(':');
}

function canonicalIpv6(addr: string): string {
  const groups = expandIpv6(addr);
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `::ffff:${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  }
  return compressIpv6(groups);
}

function toInt(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (!INT_STR_RE.test(trimmed)) return null;
    return parseInt(trimmed.replace(/_/g, ''), 10);
  }
  return null;
}
