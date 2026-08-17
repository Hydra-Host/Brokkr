export const DHCPDISCOVER = 1;
export const DHCPOFFER = 2;
export const DHCPREQUEST = 3;
export const DHCPDECLINE = 4;
export const DHCPACK = 5;
export const DHCPNAK = 6;
export const DHCPRELEASE = 7;
export const DHCPINFORM = 8;

export const OPT_PAD = 0;
export const OPT_SUBNET_MASK = 1;
export const OPT_ROUTER = 3;
export const OPT_DNS_SERVERS = 6;
export const OPT_HOSTNAME = 12;
export const OPT_BROADCAST = 28;
export const OPT_REQUESTED_IP = 50;
export const OPT_LEASE_TIME = 51;
export const OPT_OVERLOAD = 52;
export const OPT_MESSAGE_TYPE = 53;
export const OPT_SERVER_ID = 54;
export const OPT_PARAM_REQ_LIST = 55;
export const OPT_RENEWAL_TIME = 58;
export const OPT_REBINDING_TIME = 59;
export const OPT_MAX_MSG_SIZE = 57;
export const OPT_VENDOR_CLASS = 60;
export const OPT_VENDOR_ENCAP = 43;
export const OPT_TFTP_SERVER = 66;
export const OPT_BOOTFILE = 67;
export const OPT_USER_CLASS = 77;
export const OPT_FQDN = 81;
export const OPT_CLIENT_ARCH = 93;
export const OPT_END = 255;

export const PXE_PORT = 4011;

const MAX_OPTION_VALUE_LEN = 255;
const IPV4_BYTES = 4;
const UINT32_MAX = 0xffffffff;

export class DhcpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DhcpParseError';
  }
}

export interface DhcpOption {
  code: number;
  value: Buffer;
}

export function parseOptions(buf: Buffer, start: number, end: number = buf.length): Map<number, Buffer> {
  // RFC 3396: duplicate codes concatenate in encounter order. Fragments are joined ONCE at the
  // end — per-duplicate concat is O(N^2) copy amplification on the uncapped dgram receive path.
  const fragments = new Map<number, Buffer[]>();
  let offset = start;
  while (offset < end) {
    const code = buf[offset];
    if (code === OPT_PAD) {
      offset += 1;
      continue;
    }
    if (code === OPT_END) {
      break;
    }
    if (offset + 2 > end) {
      throw new DhcpParseError(`truncated option header for code ${code} at offset ${offset}`);
    }
    const len = buf[offset + 1];
    const valueStart = offset + 2;
    const valueEnd = valueStart + len;
    if (valueEnd > end) {
      throw new DhcpParseError(`option ${code} length ${len} runs past packet end`);
    }
    const fragment = buf.subarray(valueStart, valueEnd);
    const parts = fragments.get(code);
    if (parts !== undefined) parts.push(fragment);
    else fragments.set(code, [fragment]);
    offset = valueEnd;
  }
  const out = new Map<number, Buffer>();
  for (const [code, parts] of fragments) {
    // Buffer.from / Buffer.concat both copy, detaching the value from the packet buffer.
    out.set(code, parts.length === 1 ? Buffer.from(parts[0]) : Buffer.concat(parts));
  }
  return out;
}

export function encodeOptions(options: DhcpOption[]): Buffer {
  const chunks: Buffer[] = [];
  for (const { code, value } of options) {
    if (code === OPT_PAD || code === OPT_END) {
      throw new DhcpParseError(`option code ${code} is reserved (PAD/END) and cannot carry data`);
    }
    if (code < 0 || code > 254) {
      throw new DhcpParseError(`option code ${code} out of range`);
    }
    if (value.length > MAX_OPTION_VALUE_LEN) {
      throw new DhcpParseError(`option ${code} value ${value.length} exceeds ${MAX_OPTION_VALUE_LEN} bytes`);
    }
    chunks.push(Buffer.from([code, value.length]), value);
  }
  chunks.push(Buffer.from([OPT_END]));
  return Buffer.concat(chunks);
}

export function encodeIp(ip: string): Buffer {
  const octets = ip.split('.');
  if (octets.length !== IPV4_BYTES) {
    throw new DhcpParseError(`invalid IPv4 address: ${ip}`);
  }
  const buf = Buffer.alloc(IPV4_BYTES);
  for (let i = 0; i < IPV4_BYTES; i++) {
    const value = Number.parseInt(octets[i], 10);
    if (!Number.isInteger(value) || value < 0 || value > 255 || String(value) !== octets[i]) {
      throw new DhcpParseError(`invalid IPv4 address: ${ip}`);
    }
    buf[i] = value;
  }
  return buf;
}

export function encodeIps(ips: string[]): Buffer {
  if (ips.length === 0) {
    throw new DhcpParseError('encodeIps requires at least one address');
  }
  return Buffer.concat(ips.map(encodeIp));
}

export function decodeIp(buf: Buffer): string {
  if (buf.length !== IPV4_BYTES) {
    throw new DhcpParseError(`expected ${IPV4_BYTES}-byte IPv4 value, got ${buf.length}`);
  }
  return `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`;
}

export function encodeUint32(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > UINT32_MAX) {
    throw new DhcpParseError(`value ${n} out of uint32 range`);
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n, 0);
  return buf;
}
