import { DhcpParseError, encodeIp } from './dhcp-options.js';

export type DhcpOptionKind = 'NONE' | 'ADDR_LIST' | 'NAME' | 'RFC1035_NAME';

export interface KnownOption {
  width: 0 | 1 | 2 | 4;
  kind: DhcpOptionKind;
}

const KNOWN_OPTIONS = new Map<number, KnownOption>([
  [1, { width: 0, kind: 'ADDR_LIST' }],
  [3, { width: 0, kind: 'ADDR_LIST' }],
  [6, { width: 0, kind: 'ADDR_LIST' }],
  [7, { width: 0, kind: 'ADDR_LIST' }],
  [12, { width: 0, kind: 'NAME' }],
  [13, { width: 2, kind: 'NONE' }],
  [15, { width: 0, kind: 'NAME' }],
  [17, { width: 0, kind: 'NAME' }],
  [22, { width: 2, kind: 'NONE' }],
  [23, { width: 1, kind: 'NONE' }],
  [26, { width: 2, kind: 'NONE' }],
  [35, { width: 4, kind: 'NONE' }],
  [38, { width: 4, kind: 'NONE' }],
  [40, { width: 0, kind: 'NAME' }],
  [64, { width: 0, kind: 'NAME' }],
  [66, { width: 0, kind: 'NAME' }],
  [67, { width: 0, kind: 'NAME' }],
  [100, { width: 0, kind: 'NAME' }],
  [101, { width: 0, kind: 'NAME' }],
  [114, { width: 0, kind: 'NAME' }],
  [119, { width: 0, kind: 'RFC1035_NAME' }],
  [121, { width: 0, kind: 'NONE' }],
  [150, { width: 0, kind: 'ADDR_LIST' }],
]);

export function knownOption(code: number): KnownOption {
  return KNOWN_OPTIONS.get(code) ?? { width: 0, kind: 'NONE' };
}

const RFC1035_MAX_LABEL = 63;
const RFC3397_MAX_VALUE = 255;
const IPV4_BITS = 32;

export function encodeDomainSearch(domains: string[]): Buffer {
  const out: number[] = [];
  for (const domain of domains) {
    appendCompressedName(out, domain);
  }
  if (out.length > RFC3397_MAX_VALUE) {
    throw new DhcpParseError(`option 119 value ${out.length} exceeds ${RFC3397_MAX_VALUE} bytes`);
  }
  return Buffer.from(out);
}

function appendCompressedName(out: number[], domain: string): void {
  const trimmed = domain.trim();
  if (trimmed === '' || trimmed === '.') {
    out.push(0x00);
    return;
  }
  const labels = trimmed.replace(/\.$/, '').split('.');
  // Reject empty labels up front: an empty label encodes to a lone 0x00 terminator, corrupting the list.
  for (const label of labels) {
    const length = Buffer.byteLength(label, 'ascii');
    if (length === 0 || length > RFC1035_MAX_LABEL) {
      throw new DhcpParseError(`invalid domain label ${JSON.stringify(label)} in option 119`);
    }
  }
  for (const label of labels) {
    const bytes = Buffer.from(label, 'ascii');
    out.push(bytes.length, ...bytes);
  }
  out.push(0x00);
}

export function encodeClasslessRoutes(tokens: string[]): Buffer {
  if (tokens.length === 0 || tokens.length % 2 !== 0) {
    throw new DhcpParseError(`option 121 requires dest/prefix,gateway token pairs, got ${tokens.length} tokens`);
  }
  const chunks: Buffer[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    chunks.push(encodeRoute(tokens[i], tokens[i + 1]));
  }
  return Buffer.concat(chunks);
}

function encodeRoute(destSpec: string, gateway: string): Buffer {
  const slash = destSpec.indexOf('/');
  if (slash < 0) {
    throw new DhcpParseError(`option 121 destination ${JSON.stringify(destSpec)} must be dest/prefix`);
  }
  const dest = destSpec.slice(0, slash).trim();
  const prefixRaw = destSpec.slice(slash + 1).trim();
  if (!/^\d+$/.test(prefixRaw)) {
    throw new DhcpParseError(`option 121 prefix ${JSON.stringify(prefixRaw)} must be an integer`);
  }
  const prefix = Number.parseInt(prefixRaw, 10);
  if (prefix > IPV4_BITS) {
    throw new DhcpParseError(`option 121 prefix ${prefix} out of range (0-${IPV4_BITS})`);
  }
  const destOctets = Math.ceil(prefix / 8);
  const destBytes = encodeIp(dest).subarray(0, destOctets);
  return Buffer.concat([Buffer.from([prefix]), destBytes, encodeIp(gateway)]);
}
