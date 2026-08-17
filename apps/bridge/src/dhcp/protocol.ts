import {
  type DhcpOption,
  DhcpParseError,
  OPT_END,
  OPT_MAX_MSG_SIZE,
  OPT_MESSAGE_TYPE,
  OPT_OVERLOAD,
  OPT_SERVER_ID,
  encodeIp,
  encodeOptions,
  parseOptions,
} from './dhcp-options.js';

const OP_OFFSET = 0;
const HTYPE_OFFSET = 1;
const HLEN_OFFSET = 2;
const HOPS_OFFSET = 3;
const XID_OFFSET = 4;
const SECS_OFFSET = 8;
const FLAGS_OFFSET = 10;
const CIADDR_OFFSET = 12;
const YIADDR_OFFSET = 16;
const SIADDR_OFFSET = 20;
const GIADDR_OFFSET = 24;
const CHADDR_OFFSET = 28;
const SNAME_OFFSET = 44;
const FILE_OFFSET = 108;
const COOKIE_OFFSET = 236;
const OPTIONS_OFFSET = 240;

const CHADDR_FIELD_LEN = 16;
const SNAME_FIELD_LEN = 64;
const FILE_FIELD_LEN = 128;

const MAGIC_COOKIE = 0x63825363;

const DHCP_PACKET_MAX = 16384;
const DHCP_PACKET_MIN = 548;

const OVERLOAD_FILE = 0x1;
const OVERLOAD_SNAME = 0x2;
const OVERLOAD_OPTION_LEN = 3;

export const BOOTREQUEST = 1;
export const BOOTREPLY = 2;
export const HTYPE_ETHERNET = 1;

const FLAG_BROADCAST = 0x8000;

// RFC 2131 s2: replies SHOULD be padded to 576 octets (minus 20 IP + 8 UDP = 548 DHCP payload)
export const BOOTP_MIN_REPLY_LEN = DHCP_PACKET_MIN;

const ZERO_IP = '0.0.0.0';

export interface DhcpMessage {
  op: number;
  htype: number;
  hlen: number;
  hops: number;
  xid: number;
  secs: number;
  flags: number;
  broadcast: boolean;
  ciaddr: string;
  yiaddr: string;
  siaddr: string;
  giaddr: string;
  chaddr: string;
  messageType: number | null;
  options: Map<number, Buffer>;
}

export function formatMac(bytes: Buffer): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(':');
}

export function macToBytes(mac: string): Buffer {
  const parts = mac.split(/[:-]/);
  const buf = Buffer.alloc(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const value = Number.parseInt(parts[i], 16);
    if (!Number.isInteger(value) || value < 0 || value > 255 || !/^[0-9a-fA-F]{1,2}$/.test(parts[i])) {
      throw new DhcpParseError(`invalid MAC address: ${mac}`);
    }
    buf[i] = value;
  }
  return buf;
}

export function parsePacket(packet: Buffer): DhcpMessage {
  if (packet.length < OPTIONS_OFFSET) {
    throw new DhcpParseError(`packet ${packet.length} shorter than minimum ${OPTIONS_OFFSET}`);
  }
  const cookie = packet.readUInt32BE(COOKIE_OFFSET);
  if (cookie !== MAGIC_COOKIE) {
    throw new DhcpParseError(`bad magic cookie 0x${cookie.toString(16)}`);
  }
  const op = packet[OP_OFFSET];
  if (op !== BOOTREQUEST) {
    throw new DhcpParseError(`op ${op} is not BOOTREQUEST`);
  }
  const htype = packet[HTYPE_OFFSET];
  const hlen = packet[HLEN_OFFSET];
  if (hlen > CHADDR_FIELD_LEN) {
    throw new DhcpParseError(`hlen ${hlen} exceeds ${CHADDR_FIELD_LEN}-byte chaddr field`);
  }
  if (htype === 0 || hlen === 0) {
    throw new DhcpParseError(`htype ${htype} with hlen ${hlen} is invalid`);
  }

  const flags = packet.readUInt16BE(FLAGS_OFFSET);
  const options = parseOptionsWithOverload(packet);
  const messageTypeOpt = options.get(OPT_MESSAGE_TYPE);
  const messageType = messageTypeOpt && messageTypeOpt.length >= 1 ? messageTypeOpt[0] : null;

  return {
    op,
    htype,
    hlen,
    hops: packet[HOPS_OFFSET],
    xid: packet.readUInt32BE(XID_OFFSET),
    secs: packet.readUInt16BE(SECS_OFFSET),
    flags,
    broadcast: (flags & FLAG_BROADCAST) !== 0,
    ciaddr: decodeIpAt(packet, CIADDR_OFFSET),
    yiaddr: decodeIpAt(packet, YIADDR_OFFSET),
    siaddr: decodeIpAt(packet, SIADDR_OFFSET),
    giaddr: decodeIpAt(packet, GIADDR_OFFSET),
    chaddr: formatMac(packet.subarray(CHADDR_OFFSET, CHADDR_OFFSET + hlen)),
    messageType,
    options,
  };
}

function parseOptionsWithOverload(packet: Buffer): Map<number, Buffer> {
  const main = parseOptions(packet, OPTIONS_OFFSET);
  const overload = main.get(OPT_OVERLOAD);
  if (!overload || overload.length < 1) {
    return main;
  }
  const bits = overload[0];
  if (bits & OVERLOAD_FILE) {
    mergeMissing(main, safeParse(packet, FILE_OFFSET, FILE_OFFSET + FILE_FIELD_LEN));
  }
  if (bits & OVERLOAD_SNAME) {
    mergeMissing(main, safeParse(packet, SNAME_OFFSET, SNAME_OFFSET + SNAME_FIELD_LEN));
  }
  return main;
}

function mergeMissing(into: Map<number, Buffer>, from: Map<number, Buffer>): void {
  for (const [code, value] of from) {
    if (!into.has(code)) {
      into.set(code, value);
    }
  }
}

function safeParse(packet: Buffer, start: number, end: number): Map<number, Buffer> {
  try {
    return parseOptions(packet, start, end);
  } catch {
    return new Map();
  }
}

export interface DhcpReplyParams {
  messageType: number;
  yiaddr: string;
  serverId: string;
  siaddr?: string;
  /** RFC 2131 s4.3.1 Table 3: echo the client's ciaddr for RENEWING/REBINDING ACKs and INFORMs. */
  ciaddr?: string;
  options: DhcpOption[];
  bootfile?: string;
  serverName?: string;
  minLength?: number;
  forceBroadcast?: boolean;
}

export function buildReply(request: DhcpMessage, params: DhcpReplyParams): Buffer {
  const header = Buffer.alloc(OPTIONS_OFFSET);
  header[OP_OFFSET] = BOOTREPLY;
  header[HTYPE_OFFSET] = request.htype || HTYPE_ETHERNET;
  header[HLEN_OFFSET] = request.hlen;
  header.writeUInt32BE(request.xid, XID_OFFSET);
  header.writeUInt16BE(params.forceBroadcast ? request.flags | FLAG_BROADCAST : request.flags, FLAGS_OFFSET);
  writeIpAt(header, CIADDR_OFFSET, params.ciaddr ?? ZERO_IP);
  writeIpAt(header, YIADDR_OFFSET, params.yiaddr);
  writeIpAt(header, SIADDR_OFFSET, params.siaddr ?? ZERO_IP);
  writeIpAt(header, GIADDR_OFFSET, request.giaddr);
  macToBytes(request.chaddr).copy(header, CHADDR_OFFSET);

  if (params.bootfile !== undefined) {
    if (Buffer.byteLength(params.bootfile, 'ascii') >= FILE_FIELD_LEN) {
      throw new DhcpParseError(`bootfile name exceeds ${FILE_FIELD_LEN - 1} bytes`);
    }
    header.write(params.bootfile, FILE_OFFSET, 'ascii');
  }

  if (params.serverName !== undefined) {
    if (Buffer.byteLength(params.serverName, 'ascii') >= SNAME_FIELD_LEN) {
      throw new DhcpParseError(`server name exceeds ${SNAME_FIELD_LEN - 1} bytes`);
    }
    header.write(params.serverName, SNAME_OFFSET, 'ascii');
  }

  header.writeUInt32BE(MAGIC_COOKIE, COOKIE_OFFSET);

  const options: DhcpOption[] = [
    { code: OPT_MESSAGE_TYPE, value: Buffer.from([params.messageType]) },
    { code: OPT_SERVER_ID, value: encodeIp(params.serverId) },
    ...params.options,
  ];
  let optionBytes = encodeOptions(options);

  const maxMsgOpt = request.options.get(OPT_MAX_MSG_SIZE);
  const ceiling =
    maxMsgOpt && maxMsgOpt.length >= 2
      ? Math.min(Math.max(maxMsgOpt.readUInt16BE(0), DHCP_PACKET_MIN), DHCP_PACKET_MAX)
      : Number.POSITIVE_INFINITY;
  const mainBudget = ceiling - OPTIONS_OFFSET;

  if (optionBytes.length > mainBudget) {
    spillIntoOverloadFields(header, options, mainBudget, params.bootfile, params.serverName);
    optionBytes = encodeMainWithOverflow(options, mainBudget);
  }

  const minLength = params.minLength ?? BOOTP_MIN_REPLY_LEN;
  const total = OPTIONS_OFFSET + optionBytes.length;
  if (total < minLength) {
    optionBytes = Buffer.concat([optionBytes, Buffer.alloc(minLength - total)]);
  }

  return Buffer.concat([header, optionBytes]);
}

function tlvLength(option: DhcpOption): number {
  return 2 + option.value.length;
}

function mainSplitIndex(options: DhcpOption[], mainBudget: number): number {
  const reserved = mainBudget - OVERLOAD_OPTION_LEN - 1;
  let used = 0;
  let i = 0;
  for (; i < options.length; i++) {
    const next = used + tlvLength(options[i]);
    if (next > reserved) {
      break;
    }
    used = next;
  }
  return i;
}

function packField(options: DhcpOption[], fieldLen: number): Buffer | null {
  const need = options.reduce((sum, opt) => sum + tlvLength(opt), 0) + 1;
  if (need > fieldLen) {
    return null;
  }
  const field = Buffer.alloc(fieldLen);
  let offset = 0;
  for (const opt of options) {
    field[offset++] = opt.code;
    field[offset++] = opt.value.length;
    opt.value.copy(field, offset);
    offset += opt.value.length;
  }
  field[offset] = OPT_END;
  return field;
}

function spillIntoOverloadFields(
  header: Buffer,
  options: DhcpOption[],
  mainBudget: number,
  bootfile: string | undefined,
  serverName: string | undefined,
): void {
  if (bootfile !== undefined && bootfile.length > 0) {
    throw new DhcpParseError('cannot overload options into the file field: a bootfile name is set');
  }
  if (serverName !== undefined && serverName.length > 0) {
    throw new DhcpParseError('cannot overload options into the sname field: a server name is set');
  }

  const splitAt = mainSplitIndex(options, mainBudget);
  const spilled = options.slice(splitAt);

  const filePrefix = largestPrefixFitting(spilled, FILE_FIELD_LEN);
  const file = packField(spilled.slice(0, filePrefix), FILE_FIELD_LEN);
  const sname = packField(spilled.slice(filePrefix), SNAME_FIELD_LEN);
  if (!sname) {
    throw new DhcpParseError('overload overflow: options exceed file and sname capacity');
  }

  let bits = OVERLOAD_FILE;
  file.copy(header, FILE_OFFSET);
  if (filePrefix < spilled.length) {
    bits |= OVERLOAD_SNAME;
    sname.copy(header, SNAME_OFFSET);
  }

  options.splice(splitAt, options.length - splitAt, { code: OPT_OVERLOAD, value: Buffer.from([bits]) });
}

function largestPrefixFitting(options: DhcpOption[], fieldLen: number): number {
  let used = 1;
  let i = 0;
  for (; i < options.length; i++) {
    const next = used + tlvLength(options[i]);
    if (next > fieldLen) {
      break;
    }
    used = next;
  }
  return i;
}

function encodeMainWithOverflow(options: DhcpOption[], mainBudget: number): Buffer {
  const encoded = encodeOptions(options);
  if (encoded.length > mainBudget) {
    throw new DhcpParseError('overload overflow: option set exceeds total packet capacity');
  }
  return encoded;
}

function decodeIpAt(packet: Buffer, offset: number): string {
  return `${packet[offset]}.${packet[offset + 1]}.${packet[offset + 2]}.${packet[offset + 3]}`;
}

function writeIpAt(buf: Buffer, offset: number, ip: string): void {
  encodeIp(ip).copy(buf, offset);
}

export { FILE_FIELD_LEN, FILE_OFFSET, FLAG_BROADCAST, MAGIC_COOKIE, OPTIONS_OFFSET, SNAME_FIELD_LEN, SNAME_OFFSET };
