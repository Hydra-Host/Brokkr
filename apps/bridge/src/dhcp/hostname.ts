import { type DhcpMessage } from './protocol.js';

import { toDnsLabel } from '../dns/dns-server.service.js';
import { OPT_FQDN, OPT_HOSTNAME } from './dhcp-options.js';

const MAX_LABEL_LEN = 63;
const MAX_NAME_LEN = 255;
const FQDN_FIXED_LEN = 3;
const FQDN_FLAG_CANONICAL = 0x04;

export function parseClientHostname(request: DhcpMessage): string | null {
  const fqdn = request.options.get(OPT_FQDN);
  if (fqdn !== undefined && fqdn.length >= FQDN_FIXED_LEN) {
    const fromFqdn = parseFqdnOption(fqdn);
    if (fromFqdn) return fromFqdn;
  }

  const hostname = request.options.get(OPT_HOSTNAME);
  if (hostname !== undefined) {
    return parseHostnameOption(hostname);
  }

  return null;
}

function parseFqdnOption(opt: Buffer): string | null {
  if (opt.length < FQDN_FIXED_LEN) return null;
  const flags = opt[0];

  let leftmost: string | null;
  if ((flags & FQDN_FLAG_CANONICAL) !== 0) {
    leftmost = readCanonicalLeftmostLabel(opt);
  } else {
    let ascii = opt.subarray(FQDN_FIXED_LEN).toString('ascii');
    ascii = stripTrailingNul(ascii);
    leftmost = ascii.split('.')[0];
  }

  if (leftmost === null) return null;
  return sanitizeLabel(leftmost);
}

function readCanonicalLeftmostLabel(opt: Buffer): string | null {
  let offset = FQDN_FIXED_LEN;
  let assembled = 0;
  let first: string | null = null;

  while (offset < opt.length) {
    const labelLen = opt[offset];
    if (labelLen === 0) break;
    if (offset + 1 + labelLen > opt.length) return null;
    if (labelLen > MAX_LABEL_LEN) return null;
    assembled += labelLen + 1;
    if (assembled > MAX_NAME_LEN - 1) return null;
    const label = opt.subarray(offset + 1, offset + 1 + labelLen).toString('ascii');
    if (first === null) first = label;
    offset += 1 + labelLen;
  }

  return first;
}

function parseHostnameOption(opt: Buffer): string | null {
  if (opt.length === 0) return null;
  let text = opt.toString('latin1');
  text = stripTrailingNul(text);
  const leftmost = text.split('.')[0];
  return sanitizeLabel(leftmost);
}

function stripTrailingNul(value: string): string {
  return value.replace(/\0+$/, '');
}

function sanitizeLabel(raw: string): string | null {
  const label = toDnsLabel(raw);
  if (label.length === 0 || label.length > MAX_LABEL_LEN) return null;
  if (label[0] === '-' || label[label.length - 1] === '-') return null;
  if (!/^[a-z0-9-]+$/.test(label)) return null;
  return label;
}
