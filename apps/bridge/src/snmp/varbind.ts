import * as snmp from 'net-snmp';

export interface Varbind {
  readonly oid: string;
  readonly type: string;
  readonly value: number | string;
}

function bufferToHex(buffer: Buffer): string {
  return `0x${buffer.toString('hex')}`;
}

function decodeOctetString(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    return value.toString('latin1');
  }
  return String(value);
}

function decodeCounter64(value: unknown): number {
  if (typeof value === 'number') return value;
  if (Buffer.isBuffer(value)) {
    let big = 0n;
    for (const byte of value) {
      big = (big << 8n) | BigInt(byte);
    }
    return Number(big);
  }
  return Number(value);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function opaquePrettyPrint(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    return bufferToHex(value);
  }
  return String(value);
}

export function decodeVarbind(varbind: snmp.Varbind): Varbind {
  const oid = String(varbind.oid);
  const { type, value } = varbind;

  if (type === snmp.ObjectType.Integer) {
    return { oid, type: 'Integer32', value: toNumber(value) };
  }
  if (type === snmp.ObjectType.Counter) {
    return { oid, type: 'Counter32', value: toNumber(value) };
  }
  if (type === snmp.ObjectType.Counter64) {
    return { oid, type: 'Counter64', value: decodeCounter64(value) };
  }
  if (type === snmp.ObjectType.TimeTicks) {
    return { oid, type: 'TimeTicks', value: toNumber(value) };
  }
  if (type === snmp.ObjectType.Gauge) {
    return { oid, type: 'Gauge32', value: toNumber(value) };
  }
  if (type === snmp.ObjectType.IpAddress) {
    return { oid, type: 'IpAddress', value: String(value) };
  }
  if (type === snmp.ObjectType.OID) {
    return { oid, type: 'ObjectIdentifier', value: String(value) };
  }
  if (type === snmp.ObjectType.Opaque) {
    return { oid, type: 'Opaque', value: opaquePrettyPrint(value) };
  }
  if (type === snmp.ObjectType.OctetString) {
    return { oid, type: 'OctetString', value: decodeOctetString(value) };
  }

  const typeName = snmp.ObjectType[type] ?? `Unknown(${type})`;
  return { oid, type: typeName, value: opaquePrettyPrint(value) };
}
