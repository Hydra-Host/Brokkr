import { isRecord } from '@repo/utils';

export const SNMP_COMMUNITY_ENV = 'PDU_SNMP_COMMUNITY';

export interface SnmpField {
  name: string;
  oid: string;
  conversion?: string | null;
}

export interface SnmpTableField {
  name: string;
  oid: string;
  is_tag?: boolean;
  conversion?: string | null;
}

export interface SnmpTable {
  name: string;
  index_as_tag: boolean;
  fields: SnmpTableField[];
}

export interface PduSnmpProfile {
  vendor: string;
  sysobjectid_prefix: string;
  fields: SnmpField[];
  tables: SnmpTable[];
}

const VERTIV_GEIST: PduSnmpProfile = {
  vendor: 'vertiv-geist',
  sysobjectid_prefix: '1.3.6.1.4.1.21239.5',
  fields: [
    { name: 'uptime_seconds', oid: '1.3.6.1.2.1.1.3.0', conversion: 'float(2)' },
    { name: 'active_alarm_count', oid: '1.3.6.1.4.1.21239.5.2.1.13.0' },
    { name: 'active_warning_count', oid: '1.3.6.1.4.1.21239.5.2.1.14.0' },
    { name: 'availability', oid: '1.3.6.1.4.1.21239.5.2.3.1.1.5.1' },
    { name: 'total_real_power_watts', oid: '1.3.6.1.4.1.21239.5.2.3.1.1.9.1' },
    { name: 'total_apparent_power_va', oid: '1.3.6.1.4.1.21239.5.2.3.1.1.10.1' },
    { name: 'total_power_factor', oid: '1.3.6.1.4.1.21239.5.2.3.1.1.11.1' },
    { name: 'total_energy_wh', oid: '1.3.6.1.4.1.21239.5.2.3.1.1.12.1' },
  ],
  tables: [
    {
      name: 'pdu_phase',
      index_as_tag: true,
      fields: [
        { name: 'name', oid: '1.3.6.1.4.1.21239.5.2.3.2.1.2', is_tag: true },
        { name: 'voltage', oid: '1.3.6.1.4.1.21239.5.2.3.2.1.4', conversion: 'float(1)' },
        { name: 'current', oid: '1.3.6.1.4.1.21239.5.2.3.2.1.8', conversion: 'float(2)' },
        { name: 'real_power', oid: '1.3.6.1.4.1.21239.5.2.3.2.1.12' },
        { name: 'apparent_power', oid: '1.3.6.1.4.1.21239.5.2.3.2.1.13' },
        { name: 'power_factor', oid: '1.3.6.1.4.1.21239.5.2.3.2.1.14' },
        { name: 'energy', oid: '1.3.6.1.4.1.21239.5.2.3.2.1.15' },
        { name: 'balance', oid: '1.3.6.1.4.1.21239.5.2.3.2.1.17' },
        { name: 'crest_factor', oid: '1.3.6.1.4.1.21239.5.2.3.2.1.19', conversion: 'float(2)' },
        { name: 'load_percent', oid: '1.3.6.1.4.1.21239.5.2.3.2.1.28', conversion: 'float(2)' },
        { name: 'frequency', oid: '1.3.6.1.4.1.21239.5.2.3.2.1.29', conversion: 'float(2)' },
      ],
    },
    {
      name: 'pdu_breaker',
      index_as_tag: true,
      fields: [
        { name: 'name', oid: '1.3.6.1.4.1.21239.5.2.3.3.1.2', is_tag: true },
        { name: 'current', oid: '1.3.6.1.4.1.21239.5.2.3.3.1.4', conversion: 'float(2)' },
        { name: 'loss_of_load', oid: '1.3.6.1.4.1.21239.5.2.3.3.1.21' },
        { name: 'load_percent', oid: '1.3.6.1.4.1.21239.5.2.3.3.1.28', conversion: 'float(2)' },
      ],
    },
    {
      name: 'pdu_line',
      index_as_tag: true,
      fields: [
        { name: 'name', oid: '1.3.6.1.4.1.21239.5.2.3.4.1.2', is_tag: true },
        { name: 'current', oid: '1.3.6.1.4.1.21239.5.2.3.4.1.4', conversion: 'float(2)' },
      ],
    },
    {
      name: 'pdu_outlet',
      index_as_tag: true,
      fields: [
        { name: 'name', oid: '1.3.6.1.4.1.21239.5.2.3.6.1.2', is_tag: true },
        { name: 'voltage', oid: '1.3.6.1.4.1.21239.5.2.3.6.1.4', conversion: 'float(1)' },
        { name: 'current', oid: '1.3.6.1.4.1.21239.5.2.3.6.1.8', conversion: 'float(2)' },
        { name: 'real_power', oid: '1.3.6.1.4.1.21239.5.2.3.6.1.12' },
        { name: 'apparent_power', oid: '1.3.6.1.4.1.21239.5.2.3.6.1.13' },
        { name: 'power_factor', oid: '1.3.6.1.4.1.21239.5.2.3.6.1.14' },
        { name: 'energy', oid: '1.3.6.1.4.1.21239.5.2.3.6.1.15' },
        { name: 'load_percent', oid: '1.3.6.1.4.1.21239.5.2.3.6.1.28', conversion: 'float(2)' },
      ],
    },
    {
      name: 'pdu_outlet_switch',
      index_as_tag: true,
      fields: [
        { name: 'name', oid: '1.3.6.1.4.1.21239.5.2.3.5.1.2', is_tag: true },
        { name: 'switch_state', oid: '1.3.6.1.4.1.21239.5.2.3.5.1.4' },
        { name: 'relay_failure', oid: '1.3.6.1.4.1.21239.5.2.3.5.1.5' },
      ],
    },
    {
      name: 'pdu_temp',
      index_as_tag: true,
      fields: [
        { name: 'name', oid: '1.3.6.1.4.1.21239.5.2.4.1.2', is_tag: true },
        { name: 'temperature_celsius', oid: '1.3.6.1.4.1.21239.5.2.4.1.5', conversion: 'float(1)' },
      ],
    },
    {
      name: 'pdu_thd',
      index_as_tag: true,
      fields: [
        { name: 'name', oid: '1.3.6.1.4.1.21239.5.2.9.1.2', is_tag: true },
        { name: 'temperature_celsius', oid: '1.3.6.1.4.1.21239.5.2.9.1.5', conversion: 'float(1)' },
        { name: 'humidity_percent', oid: '1.3.6.1.4.1.21239.5.2.9.1.6' },
        { name: 'dew_point_celsius', oid: '1.3.6.1.4.1.21239.5.2.9.1.7', conversion: 'float(1)' },
      ],
    },
  ],
};

const APC: PduSnmpProfile = {
  vendor: 'apc',
  sysobjectid_prefix: '1.3.6.1.4.1.318',
  fields: [
    { name: 'uptime_seconds', oid: '1.3.6.1.2.1.1.3.0', conversion: 'float(2)' },
    { name: 'outlet_count', oid: '1.3.6.1.4.1.318.1.1.12.1.7.0' },
    { name: 'phase_count', oid: '1.3.6.1.4.1.318.1.1.12.1.9.0' },
    { name: 'total_power_watts', oid: '1.3.6.1.4.1.318.1.1.12.1.16.0' },
  ],
  tables: [
    {
      name: 'pdu_inlet',
      index_as_tag: true,
      fields: [
        { name: 'real_power', oid: '1.3.6.1.4.1.318.1.1.26.4.3.1.5', conversion: 'float(-1)' },
        { name: 'apparent_power', oid: '1.3.6.1.4.1.318.1.1.26.4.3.1.6', conversion: 'float(-1)' },
        { name: 'energy', oid: '1.3.6.1.4.1.318.1.1.26.4.3.1.9' },
        { name: 'power_factor', oid: '1.3.6.1.4.1.318.1.1.26.4.3.1.17' },
      ],
    },
    {
      name: 'pdu_phase',
      index_as_tag: true,
      fields: [
        { name: 'current', oid: '1.3.6.1.4.1.318.1.1.26.6.3.1.5', conversion: 'float(1)' },
        { name: 'voltage', oid: '1.3.6.1.4.1.318.1.1.26.6.3.1.6' },
        { name: 'real_power', oid: '1.3.6.1.4.1.318.1.1.26.6.3.1.7', conversion: 'float(-1)' },
        { name: 'apparent_power', oid: '1.3.6.1.4.1.318.1.1.26.6.3.1.8', conversion: 'float(-1)' },
        { name: 'power_factor', oid: '1.3.6.1.4.1.318.1.1.26.6.3.1.9' },
        { name: 'energy', oid: '1.3.6.1.4.1.318.1.1.26.6.3.1.10' },
      ],
    },
    {
      name: 'pdu_outlet',
      index_as_tag: true,
      fields: [
        { name: 'current', oid: '1.3.6.1.4.1.318.1.1.26.8.3.1.5', conversion: 'float(1)' },
        { name: 'real_power', oid: '1.3.6.1.4.1.318.1.1.26.8.3.1.6' },
      ],
    },
    {
      name: 'pdu_bank',
      index_as_tag: true,
      fields: [{ name: 'current', oid: '1.3.6.1.4.1.318.1.1.12.2.3.1.1.2', conversion: 'float(1)' }],
    },
    {
      name: 'pdu_temp',
      index_as_tag: true,
      fields: [
        { name: 'name', oid: '1.3.6.1.4.1.318.1.1.26.10.2.2.1.3', is_tag: true },
        { name: 'temperature_celsius', oid: '1.3.6.1.4.1.318.1.1.26.10.2.2.1.5', conversion: 'float(1)' },
        { name: 'humidity_percent', oid: '1.3.6.1.4.1.318.1.1.26.10.2.2.1.6' },
      ],
    },
  ],
};

const ENCONNEX: PduSnmpProfile = {
  vendor: 'enconnex',
  sysobjectid_prefix: '1.3.6.1.4.1.52251.10.1',
  fields: [],
  tables: [
    {
      name: 'pdu_inlet',
      index_as_tag: true,
      fields: [
        { name: 'real_power', oid: '1.3.6.1.4.1.52251.10.1.2.1.1.4' },
        { name: 'apparent_power', oid: '1.3.6.1.4.1.52251.10.1.2.1.1.5' },
        { name: 'energy', oid: '1.3.6.1.4.1.52251.10.1.2.1.1.8' },
        { name: 'power_factor', oid: '1.3.6.1.4.1.52251.10.1.2.1.1.9' },
        { name: 'current', oid: '1.3.6.1.4.1.52251.10.1.2.1.1.11', conversion: 'float(2)' },
      ],
    },
    {
      name: 'pdu_breaker',
      index_as_tag: true,
      fields: [
        { name: 'voltage', oid: '1.3.6.1.4.1.52251.10.1.2.2.1.3', conversion: 'float(1)' },
        { name: 'current', oid: '1.3.6.1.4.1.52251.10.1.2.2.1.11', conversion: 'float(2)' },
        { name: 'load_percent', oid: '1.3.6.1.4.1.52251.10.1.2.2.1.17' },
        { name: 'real_power', oid: '1.3.6.1.4.1.52251.10.1.2.2.1.19' },
        { name: 'apparent_power', oid: '1.3.6.1.4.1.52251.10.1.2.2.1.20' },
        { name: 'energy', oid: '1.3.6.1.4.1.52251.10.1.2.2.1.21' },
        { name: 'power_factor', oid: '1.3.6.1.4.1.52251.10.1.2.2.1.23' },
        { name: 'frequency', oid: '1.3.6.1.4.1.52251.10.1.2.2.1.24', conversion: 'float(1)' },
        { name: 'temperature_celsius', oid: '1.3.6.1.4.1.52251.10.1.2.2.1.25' },
      ],
    },
    {
      name: 'pdu_outlet',
      index_as_tag: true,
      fields: [
        { name: 'name', oid: '1.3.6.1.4.1.52251.10.1.5.1.1.2', is_tag: true },
        { name: 'current', oid: '1.3.6.1.4.1.52251.10.1.5.1.1.5', conversion: 'float(2)' },
        { name: 'switch_state', oid: '1.3.6.1.4.1.52251.10.1.5.1.1.6' },
        { name: 'apparent_power', oid: '1.3.6.1.4.1.52251.10.1.5.1.1.12' },
        { name: 'real_power', oid: '1.3.6.1.4.1.52251.10.1.5.1.1.13' },
        { name: 'energy', oid: '1.3.6.1.4.1.52251.10.1.5.1.1.14' },
        { name: 'power_factor', oid: '1.3.6.1.4.1.52251.10.1.5.1.1.16' },
        { name: 'temperature_celsius', oid: '1.3.6.1.4.1.52251.10.1.5.1.1.17' },
      ],
    },
  ],
};

export const PDU_PROFILES: Readonly<Record<string, PduSnmpProfile>> = {
  'vertiv-geist': VERTIV_GEIST,
  apc: APC,
  enconnex: ENCONNEX,
};

const VENDOR_MATCHERS: ReadonlyArray<readonly [readonly string[], string]> = [
  [['vertiv', 'geist'], 'vertiv-geist'],
  [['apc', 'schneider'], 'apc'],
  [['enconnex', 'eaton'], 'enconnex'],
];

export function deviceTypeStrings(deviceData: unknown): string[] {
  if (!isRecord(deviceData)) {
    return [];
  }
  const out: string[] = [];
  const dt = deviceData.device_type;
  if (isRecord(dt)) {
    for (const key of ['slug', 'model'] as const) {
      const val = dt[key];
      if (typeof val === 'string') {
        out.push(val.toLowerCase());
      }
    }
    const manufacturer = dt.manufacturer;
    if (isRecord(manufacturer)) {
      for (const key of ['slug', 'name'] as const) {
        const val = manufacturer[key];
        if (typeof val === 'string') {
          out.push(val.toLowerCase());
        }
      }
    }
  } else if (typeof dt === 'string') {
    out.push(dt.toLowerCase());
  }
  return out;
}

export function classifyPduVendor(deviceData: unknown): string | null {
  const haystack = deviceTypeStrings(deviceData).join(' ');
  if (!haystack) {
    return null;
  }
  for (const [fragments, key] of VENDOR_MATCHERS) {
    if (fragments.some((fragment) => haystack.includes(fragment))) {
      return key;
    }
  }
  return null;
}
