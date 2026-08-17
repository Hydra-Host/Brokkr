import * as snmp from 'net-snmp';
import { describe, expect, it } from 'vitest';

import { decodeVarbind } from '../varbind.js';

describe('decodeVarbind', () => {
  it('decodes Integer as Integer32', () => {
    expect(decodeVarbind({ oid: '1.3.6.1.2.1.1.7.0', type: snmp.ObjectType.Integer, value: 72 })).toEqual({
      oid: '1.3.6.1.2.1.1.7.0',
      type: 'Integer32',
      value: 72,
    });
  });

  it('decodes Counter as Counter32', () => {
    expect(decodeVarbind({ oid: '1.3.6.1.2.1.2.2.1.10.1', type: snmp.ObjectType.Counter, value: 123456 })).toEqual({
      oid: '1.3.6.1.2.1.2.2.1.10.1',
      type: 'Counter32',
      value: 123456,
    });
  });

  it('decodes Gauge as Gauge32', () => {
    expect(decodeVarbind({ oid: '1.3.6.1.2.1.2.2.1.5.1', type: snmp.ObjectType.Gauge, value: 1000000000 })).toEqual({
      oid: '1.3.6.1.2.1.2.2.1.5.1',
      type: 'Gauge32',
      value: 1000000000,
    });
  });

  it('decodes TimeTicks as an integer', () => {
    expect(decodeVarbind({ oid: '1.3.6.1.2.1.1.3.0', type: snmp.ObjectType.TimeTicks, value: 4711 })).toEqual({
      oid: '1.3.6.1.2.1.1.3.0',
      type: 'TimeTicks',
      value: 4711,
    });
  });

  it('decodes Counter64 buffers into numbers when within safe range', () => {
    const buffer = Buffer.from([0, 0, 0, 0, 0, 0, 1, 44]);
    expect(decodeVarbind({ oid: '1.3.6.1.2.1.31.1.1.1.6.1', type: snmp.ObjectType.Counter64, value: buffer })).toEqual({
      oid: '1.3.6.1.2.1.31.1.1.1.6.1',
      type: 'Counter64',
      value: 300,
    });
  });

  it('decodes Counter64 buffers beyond Number.MAX_SAFE_INTEGER as numbers', () => {
    const buffer = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const decoded = decodeVarbind({ oid: '1.3.6.1.2.1.31.1.1.1.6.1', type: snmp.ObjectType.Counter64, value: buffer });
    expect(decoded.type).toBe('Counter64');
    expect(typeof decoded.value).toBe('number');
  });

  it('decodes IpAddress as the dotted-quad string', () => {
    expect(decodeVarbind({ oid: '1.3.6.1.2.1.4.20.1.1', type: snmp.ObjectType.IpAddress, value: '10.0.0.1' })).toEqual({
      oid: '1.3.6.1.2.1.4.20.1.1',
      type: 'IpAddress',
      value: '10.0.0.1',
    });
  });

  it('decodes OID values as ObjectIdentifier', () => {
    expect(decodeVarbind({ oid: '1.3.6.1.2.1.1.2.0', type: snmp.ObjectType.OID, value: '1.3.6.1.4.1.674' })).toEqual({
      oid: '1.3.6.1.2.1.1.2.0',
      type: 'ObjectIdentifier',
      value: '1.3.6.1.4.1.674',
    });
  });

  it('decodes printable OctetString buffers as text', () => {
    expect(
      decodeVarbind({ oid: '1.3.6.1.2.1.1.1.0', type: snmp.ObjectType.OctetString, value: Buffer.from('iDRAC9') }),
    ).toEqual({
      oid: '1.3.6.1.2.1.1.1.0',
      type: 'OctetString',
      value: 'iDRAC9',
    });
  });

  it('decodes non-UTF8 OctetString buffers as latin-1', () => {
    expect(
      decodeVarbind({
        oid: '1.3.6.1.2.1.1.1.0',
        type: snmp.ObjectType.OctetString,
        value: Buffer.from([0xff, 0xfe, 0x01]),
      }),
    ).toEqual({
      oid: '1.3.6.1.2.1.1.1.0',
      type: 'OctetString',
      value: 'ÿþ',
    });
  });

  it('decodes Opaque buffers as 0x-prefixed hex', () => {
    expect(decodeVarbind({ oid: '1.3.6.1.4.1.1', type: snmp.ObjectType.Opaque, value: Buffer.from('raw') })).toEqual({
      oid: '1.3.6.1.4.1.1',
      type: 'Opaque',
      value: '0x726177',
    });
  });

  it('falls back to the net-snmp type name and stringified value for other types', () => {
    const decoded = decodeVarbind({ oid: '1.3.6.1.4.1.2', type: snmp.ObjectType.Boolean, value: true });
    expect(decoded.type).toBe('Boolean');
    expect(decoded.value).toBe('true');
  });
});
