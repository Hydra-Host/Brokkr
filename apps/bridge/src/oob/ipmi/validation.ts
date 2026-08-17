import { isIPv4, isIPv6 } from 'node:net';

import { getIpmiMonitoringConfig } from './ipmi.config.js';

const USERNAME_RE = /^[a-zA-Z0-9_\-.:{}/"]+\n?$/;
const USERNAME_MAX = 128;
const PART_MAX = 256;
const INT_RE = /^[+-]?\d(_?\d)*$/;
const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /[;&|`$(){}[\]<>]/,
  /\.\./,
  /^-/,
  /[\n\r]/,
  /\\x[0-9a-fA-F]{2}/,
  /\\[0-7]{3}/,
];

export class IPMIValidationError extends Error {}

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

function compressIpv6(groups: readonly number[]): string {
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

export function validateIp(ip: unknown): string {
  if (typeof ip !== 'string') {
    throw new IPMIValidationError(`Invalid IP address format: ${String(ip)}`);
  }
  const trimmed = ip.trim();
  if (isIPv4(trimmed)) return trimmed;

  let addr = trimmed;
  let zone = '';
  const pct = trimmed.indexOf('%');
  if (pct !== -1) {
    addr = trimmed.slice(0, pct);
    zone = trimmed.slice(pct + 1);
    if (zone === '' || zone.includes('%')) {
      throw new IPMIValidationError(`Invalid IP address format: ${ip}`);
    }
  }
  if (!isIPv6(addr)) {
    throw new IPMIValidationError(`Invalid IP address format: ${ip}`);
  }
  const canonical = canonicalIpv6(addr);
  return zone ? `${canonical}%${zone}` : canonical;
}

export function validateUsername(username: unknown): string {
  if (typeof username !== 'string') {
    throw new IPMIValidationError('Username must be a string');
  }
  if (!username) {
    throw new IPMIValidationError('Username cannot be empty');
  }
  if (username.length > USERNAME_MAX) {
    throw new IPMIValidationError('Username too long');
  }
  if (!USERNAME_RE.test(username)) {
    throw new IPMIValidationError('Username contains invalid characters');
  }
  return username;
}

export function validatePort(port: unknown): number {
  if (typeof port === 'string' && port !== port.trim()) {
    throw new IPMIValidationError('Invalid port number');
  }
  let portInt: number;
  if (typeof port === 'boolean') {
    portInt = port ? 1 : 0;
  } else if (typeof port === 'number' && Number.isFinite(port)) {
    portInt = Math.trunc(port);
  } else if (typeof port === 'string' && INT_RE.test(port)) {
    portInt = parseInt(port.replace(/_/g, ''), 10);
  } else {
    throw new IPMIValidationError('Invalid port number');
  }
  if (portInt < 1 || portInt > 65535) {
    throw new IPMIValidationError('Port must be between 1 and 65535');
  }
  return portInt;
}

export function validateCommandPart(part: string): string {
  if (!part || !part.trim()) {
    throw new IPMIValidationError('Empty command part');
  }
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(part)) {
      throw new IPMIValidationError(`Invalid characters in command part: ${part}`);
    }
  }
  if (part.length > PART_MAX) {
    throw new IPMIValidationError('Command part too long');
  }
  return part;
}

export function validateIpmiCommand(commandParts: readonly string[]): string[] {
  const first = commandParts[0];
  if (first === undefined) {
    throw new IPMIValidationError('Empty command');
  }

  const cfg = getIpmiMonitoringConfig();
  const base = first.toLowerCase();
  const allowedSubs = cfg.allowedIpmiCommands[base];
  if (allowedSubs === undefined) {
    throw new IPMIValidationError(`Command '${base}' not allowed`);
  }

  if (commandParts.length > 1) {
    const sub = (commandParts[1] ?? '').toLowerCase();
    if (!allowedSubs.includes(sub)) {
      throw new IPMIValidationError(`Subcommand '${sub}' not allowed for '${base}'`);
    }

    const third = commandParts[2];
    if (base === 'sdr' && sub === 'type' && third !== undefined) {
      const sdrType = third.toLowerCase();
      if (!cfg.allowedSdrTypes.includes(sdrType)) {
        throw new IPMIValidationError(`SDR type '${sdrType}' not allowed`);
      }
    } else if (base === 'dcmi' && sub === 'power' && third !== undefined) {
      const op = third.toLowerCase();
      if (!cfg.allowedDcmiOperations.includes(op)) {
        throw new IPMIValidationError(`DCMI operation '${op}' not allowed`);
      }
    } else if (base === 'chassis' && sub === 'power' && third !== undefined) {
      const op = third.toLowerCase();
      if (!cfg.allowedChassisPowerOps.includes(op)) {
        throw new IPMIValidationError(`Chassis power operation '${op}' not allowed`);
      }
    } else if ((base === 'user' || base === 'channel') && (sub === 'list' || sub === 'info')) {
      if (third !== undefined) {
        if (!INT_RE.test(third.trim())) {
          throw new IPMIValidationError(`Invalid channel number for ${base} ${sub}`);
        }
        const channel = parseInt(third.trim().replace(/_/g, ''), 10);
        if (channel < 1 || channel > 16) {
          throw new IPMIValidationError('Channel must be between 1 and 16');
        }
      }
    }
  } else if (!allowedSubs.includes(null)) {
    throw new IPMIValidationError(`Command '${base}' requires a subcommand`);
  }

  return commandParts.map((p) => validateCommandPart(p));
}
