import { describe, expect, it } from 'vitest';

import { PDU_PROFILES, classifyPduVendor, type SnmpTableField } from '../pdu-snmp-profiles';

function field(vendor: string, tableName: string, fieldName: string): SnmpTableField {
  const table = PDU_PROFILES[vendor].tables.find((t) => t.name === tableName);
  if (!table) throw new Error(`table not found: ${tableName}`);
  const found = table.fields.find((f) => f.name === fieldName);
  if (!found) throw new Error(`field not found: ${fieldName}`);
  return found;
}

describe('classifyPduVendor', () => {
  it('vertiv by device_type slug', () => {
    expect(
      classifyPduVendor({
        device_type: { slug: 'vertiv-geist-imd-5m', manufacturer: { slug: 'vertiv' } },
      }),
    ).toBe('vertiv-geist');
  });

  it('geist keyword in model', () => {
    expect(classifyPduVendor({ device_type: { model: 'Geist IMD' } })).toBe('vertiv-geist');
  });

  it('apc by manufacturer name', () => {
    expect(
      classifyPduVendor({
        device_type: { manufacturer: { name: 'APC by Schneider Electric' } },
      }),
    ).toBe('apc');
  });

  it('enconnex by slug', () => {
    expect(classifyPduVendor({ device_type: { slug: 'enconnex-cabinet-pdu' } })).toBe('enconnex');
  });

  it('unknown vendor is null', () => {
    expect(classifyPduVendor({ device_type: { slug: 'poweredge-r760' } })).toBeNull();
  });

  it('no data is null', () => {
    expect(classifyPduVendor(null)).toBeNull();
    expect(classifyPduVendor({})).toBeNull();
  });
});

describe('Vertiv-Geist profile', () => {
  it('registered with expected sysobjectid prefix', () => {
    expect('vertiv-geist' in PDU_PROFILES).toBe(true);
    expect(PDU_PROFILES['vertiv-geist'].sysobjectid_prefix).toBe('1.3.6.1.4.1.21239.5');
  });

  it('exposes all expected tables', () => {
    const tableNames = new Set(PDU_PROFILES['vertiv-geist'].tables.map((t) => t.name));
    for (const expected of [
      'pdu_phase',
      'pdu_breaker',
      'pdu_line',
      'pdu_outlet',
      'pdu_outlet_switch',
      'pdu_temp',
      'pdu_thd',
    ]) {
      expect(tableNames.has(expected)).toBe(true);
    }
  });

  it('phase voltage OID has divide-by-10 scaling', () => {
    const voltage = field('vertiv-geist', 'pdu_phase', 'voltage');
    expect(voltage.oid).toBe('1.3.6.1.4.1.21239.5.2.3.2.1.4');
    expect(voltage.conversion).toBe('float(1)');
    expect(voltage.is_tag).toBeFalsy();
  });

  it('every table has a name tag whose oid ends in .2', () => {
    for (const table of PDU_PROFILES['vertiv-geist'].tables) {
      const tagFields = table.fields.filter((f) => f.is_tag);
      expect(tagFields.length).toBe(1);
      expect(tagFields[0].name).toBe('name');
      expect(tagFields[0].oid.endsWith('.2')).toBe(true);
    }
  });

  it('phase current uses float(2)', () => {
    expect(field('vertiv-geist', 'pdu_phase', 'current').conversion).toBe('float(2)');
  });
});

describe('APC profile', () => {
  it('registered with expected tables', () => {
    const names = new Set(PDU_PROFILES['apc'].tables.map((t) => t.name));
    for (const expected of ['pdu_inlet', 'pdu_phase', 'pdu_outlet', 'pdu_bank', 'pdu_temp']) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it('phase current divides by 10', () => {
    expect(field('apc', 'pdu_phase', 'current').conversion).toBe('float(1)');
  });

  it('power fields multiply by 10 via float(-1)', () => {
    expect(field('apc', 'pdu_phase', 'real_power').conversion).toBe('float(-1)');
    expect(field('apc', 'pdu_phase', 'apparent_power').conversion).toBe('float(-1)');
    expect(field('apc', 'pdu_inlet', 'real_power').conversion).toBe('float(-1)');
    expect(field('apc', 'pdu_inlet', 'apparent_power').conversion).toBe('float(-1)');
  });
});

describe('Enconnex profile', () => {
  it('registered with expected tables', () => {
    const names = new Set(PDU_PROFILES['enconnex'].tables.map((t) => t.name));
    for (const expected of ['pdu_inlet', 'pdu_breaker', 'pdu_outlet']) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it('breaker scaling', () => {
    expect(field('enconnex', 'pdu_breaker', 'voltage').conversion).toBe('float(1)');
    expect(field('enconnex', 'pdu_breaker', 'current').conversion).toBe('float(2)');
  });

  it('only division/none conversions — no multiply', () => {
    const ok = new Set([null, undefined, 'float(1)', 'float(2)']);
    for (const table of PDU_PROFILES['enconnex'].tables) {
      for (const f of table.fields) {
        expect(ok.has(f.conversion ?? null) || ok.has(f.conversion ?? undefined)).toBe(true);
      }
    }
  });
});

describe('profile consistency', () => {
  it('every classified vendor has a registered profile', () => {
    for (const data of [
      { device_type: { slug: 'vertiv-geist-imd' } },
      { device_type: { manufacturer: { slug: 'apc' } } },
      { device_type: { slug: 'enconnex-pdu' } },
    ]) {
      const key = classifyPduVendor(data);
      expect(key).not.toBeNull();
      expect(key! in PDU_PROFILES).toBe(true);
    }
  });

  it('every OID is dotted numeric with no trailing index placeholder', () => {
    const numericParts = (oid: string) => oid.split('.').every((p) => /^\d+$/.test(p));
    for (const profile of Object.values(PDU_PROFILES)) {
      for (const f of profile.fields) expect(numericParts(f.oid)).toBe(true);
      for (const table of profile.tables) {
        for (const tf of table.fields) expect(numericParts(tf.oid)).toBe(true);
      }
    }
  });
});
