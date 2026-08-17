import { describe, expect, it } from 'vitest';

import { ALL_MEASUREMENTS } from '../../common/scrape-plan.service';
import {
  jsonstr,
  renderOwnedDevicesConf,
  type OwnedDevice,
  type RenderConfig,
} from '../telegraf-config-renderer.service';

const BASELINE_CONFIG: RenderConfig = {
  bridge_api_url: 'https://bridge-api.test:443',
  poll_interval: '30s',
  timeout: '10s',
};

const STANZAS_PER_DEVICE = 2;

function device(id: string, extras: Partial<OwnedDevice> = {}): OwnedDevice {
  return {
    device_id: id,
    ...extras,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count += 1;
    i += needle.length;
  }
  return count;
}

describe('determinism', () => {
  it('same input → byte-identical output', () => {
    const devices = [device('42'), device('7')];
    expect(renderOwnedDevicesConf(devices, BASELINE_CONFIG)).toBe(renderOwnedDevicesConf(devices, BASELINE_CONFIG));
  });

  it('devices sorted by id — out-of-order matches sorted', () => {
    const outOfOrder = [device('zz'), device('aa'), device('mm')];
    const inOrder = [...outOfOrder].sort((a, b) => (a.device_id < b.device_id ? -1 : 1));
    expect(renderOwnedDevicesConf(outOfOrder, BASELINE_CONFIG)).toBe(renderOwnedDevicesConf(inOrder, BASELINE_CONFIG));
  });
});

describe('empty device list', () => {
  it('no input stanzas emitted', () => {
    const out = renderOwnedDevicesConf([], BASELINE_CONFIG);
    expect(out).not.toContain('[[inputs.http]]');
    expect(out).toContain('Device count: 0');
  });
});

describe('single device', () => {
  it('emits two stanzas (icmp + sensors)', () => {
    const out = renderOwnedDevicesConf([device('42')], BASELINE_CONFIG);
    expect(countOccurrences(out, '[[inputs.http]]')).toBe(STANZAS_PER_DEVICE);
  });

  it('device_id in tags for both stanzas', () => {
    const out = renderOwnedDevicesConf([device('42')], BASELINE_CONFIG);
    expect(countOccurrences(out, 'device_id = "42"')).toBe(STANZAS_PER_DEVICE);
  });

  it('targets icmp + aggregate sensors endpoints', () => {
    const out = renderOwnedDevicesConf([device('42')], BASELINE_CONFIG);
    expect(out).toContain('/api/monitoring/ping');
    expect(out).toContain('/api/monitoring/device/sensors');
  });

  it('renders without credentials — OwnedDevice carries none', () => {
    const out = renderOwnedDevicesConf(
      [device('42'), device('pdu-1', { kind: 'pdu', pdu_profile: 'apc', bmc_ip: '10.4.0.2' })],
      BASELINE_CONFIG,
    );
    expect(out).not.toContain('username');
    expect(out).not.toContain('password');
  });
});

describe('sensor blocks', () => {
  it('one json_v2 block per ALL_MEASUREMENTS entry', () => {
    const out = renderOwnedDevicesConf([device('42')], BASELINE_CONFIG);
    for (const measurement of ALL_MEASUREMENTS) {
      expect(out).toContain(`measurement_name = "${measurement}"`);
      expect(out).toContain(`path = "${measurement}"`);
    }
  });

  it('chassis sensors tag by sensor; GPU sensors tag by gpu_index', () => {
    const out = renderOwnedDevicesConf([device('42')], BASELINE_CONFIG);
    expect(countOccurrences(out, 'tags = ["sensor"]')).toBe(6);
    expect(countOccurrences(out, 'tags = ["gpu_index"]')).toBe(4);
  });

  it('no vendor-specific endpoints in the rendered config', () => {
    const out = renderOwnedDevicesConf([device('42')], BASELINE_CONFIG);
    for (const marker of ['DellGPUSensors', 'GraphicsControllers', 'HGX_GPU', '/Chassis/GPU_']) {
      expect(out).not.toContain(marker);
    }
  });
});

describe('special-char escaping in device_id', () => {
  it.each<[string, string]>([
    ['a"b', '\\"'],
    ['a\\b', '\\\\'],
    ['a\nb', '\\n'],
    ['dev-9f3a_12', 'dev-9f3a_12'],
  ])('device_id %j → contains substring %j', (id, expected) => {
    const out = renderOwnedDevicesConf([device(id)], BASELINE_CONFIG);
    expect(out).toContain(expected);
  });
});

describe('CDU device', () => {
  const cdu = (): OwnedDevice => device('cdu-1', { kind: 'cdu' });

  it('still two stanzas', () => {
    const out = renderOwnedDevicesConf([cdu()], BASELINE_CONFIG);
    expect(countOccurrences(out, '[[inputs.http]]')).toBe(STANZAS_PER_DEVICE);
  });

  it('sensors POST body carries kind:cdu', () => {
    const out = renderOwnedDevicesConf([cdu()], BASELINE_CONFIG);
    expect(out).toContain('"kind": "cdu"');
  });

  it('emits CDU blocks, not server blocks', () => {
    const out = renderOwnedDevicesConf([cdu()], BASELINE_CONFIG);
    expect(out).toContain('measurement_name = "cdu_primary_supply_temp_celsius"');
    expect(out).toContain('measurement_name = "cdu_leak_detector_ok"');
    expect(out).toContain('tags = ["detector"]');
    for (const m of ['sensor_temperature_celsius', 'gpu_temperature_celsius']) {
      expect(out).not.toContain(`measurement_name = "${m}"`);
    }
  });
});

describe('PDU device', () => {
  const pdu = (profile = 'vertiv-geist'): OwnedDevice =>
    device('pdu-1', { kind: 'pdu', pdu_profile: profile, bmc_ip: '10.4.0.2' });

  it('renders SNMP not Redfish', () => {
    const out = renderOwnedDevicesConf([pdu()], BASELINE_CONFIG);
    expect(countOccurrences(out, '[[inputs.snmp]]')).toBe(1);
    expect(countOccurrences(out, '[[inputs.http]]')).toBe(1);
    expect(out).not.toContain('/api/monitoring/device/sensors');
  });

  it('snmp agent + community + version', () => {
    const out = renderOwnedDevicesConf([pdu()], BASELINE_CONFIG);
    expect(out).toContain('agents = ["udp://10.4.0.2:161"]');
    expect(out).toContain('community = "${PDU_SNMP_COMMUNITY}"');
    expect(out).toContain('version = 2');
  });

  it('tables and conversions surface', () => {
    const out = renderOwnedDevicesConf([pdu()], BASELINE_CONFIG);
    expect(out).toContain('name = "pdu_phase"');
    expect(out).toContain('index_as_tag = true');
    expect(out).toContain('is_tag = true');
    expect(out).toContain('conversion = "float(1)"');
  });

  it('unknown profile emits no snmp stanza', () => {
    const out = renderOwnedDevicesConf([pdu('nonexistent')], BASELINE_CONFIG);
    expect(out).not.toContain('[[inputs.snmp]]');
    expect(countOccurrences(out, '[[inputs.http]]')).toBe(1);
  });
});

describe('multiple devices', () => {
  it('stanza count scales linearly', () => {
    const out = renderOwnedDevicesConf([device('a'), device('b'), device('c')], BASELINE_CONFIG);
    expect(countOccurrences(out, '[[inputs.http]]')).toBe(3 * STANZAS_PER_DEVICE);
    expect(out).toContain('Device count: 3');
  });
});

describe('jsonstr escape filter', () => {
  it('escapes quote, backslash, control chars', () => {
    expect(jsonstr('hello')).toBe('"hello"');
    expect(jsonstr('a"b')).toBe('"a\\"b"');
    expect(jsonstr('a\\b')).toBe('"a\\\\b"');
    expect(jsonstr('a\nb')).toBe('"a\\nb"');
    expect(jsonstr('a\tb')).toBe('"a\\tb"');
  });
});
