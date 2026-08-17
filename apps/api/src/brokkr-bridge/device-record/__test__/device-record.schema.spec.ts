import { describe, expect, it } from 'vitest';
import { DeviceRecordSchema } from '../device-record.schema';

const baseRecord = {
  id: '550e8400-e29b-41d4-a716-446655440042',
  is_placeholder: false,
  status: 'ACTIVE',
  role: 'discovered-hosts',
  installed_os: 'ubuntu-noble',
  rescue_os: null,
  platform_tags: ['layered'],
  device_type: 'dell-r740',
  netplan: null,
  serial_port_recommended: 'ttyS1',
  serial_baud_recommended: 115200,
  location_network_type: 'roce',
  is_vpc: false,
  last_job_id: 'job-1',
  buildarch: null,
};

describe('DeviceRecordSchema', () => {
  it('parses a fully-populated real-device record', () => {
    const result = DeviceRecordSchema.safeParse(baseRecord);
    expect(result.success).toBe(true);
  });

  it('parses a record with all nullable fields null', () => {
    const result = DeviceRecordSchema.safeParse({
      ...baseRecord,
      status: null,
      role: null,
      installed_os: null,
      rescue_os: null,
      platform_tags: [],
      device_type: null,
      netplan: null,
      serial_port_recommended: null,
      serial_baud_recommended: null,
      location_network_type: null,
      is_vpc: false,
      last_job_id: null,
      buildarch: null,
    });
    expect(result.success).toBe(true);
  });

  it('defaults platform_tags to [] when omitted', () => {
    const { platform_tags: _omit, ...withoutTags } = baseRecord;
    const result = DeviceRecordSchema.safeParse(withoutTags);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.platform_tags).toEqual([]);
    }
  });

  it('defaults is_vpc to false when omitted', () => {
    const { is_vpc: _omit, ...withoutVpc } = baseRecord;
    const result = DeviceRecordSchema.safeParse(withoutVpc);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.is_vpc).toBe(false);
    }
  });

  it('rejects an unknown field (strict)', () => {
    const result = DeviceRecordSchema.safeParse({ ...baseRecord, unknown_field: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string id', () => {
    const result = DeviceRecordSchema.safeParse({ ...baseRecord, id: 1.5 });
    expect(result.success).toBe(false);
  });

  it('defaults is_placeholder to false when omitted', () => {
    const { is_placeholder: _omit, ...withoutFlag } = baseRecord;
    const result = DeviceRecordSchema.safeParse(withoutFlag);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.is_placeholder).toBe(false);
    }
  });

  it('rejects a non-string status', () => {
    const result = DeviceRecordSchema.safeParse({ ...baseRecord, status: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-array platform_tags', () => {
    const result = DeviceRecordSchema.safeParse({ ...baseRecord, platform_tags: 'flat' });
    expect(result.success).toBe(false);
  });

  it('accepts a placeholder UUID with is_placeholder=true and buildarch set', () => {
    const result = DeviceRecordSchema.safeParse({
      ...baseRecord,
      id: 'aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee',
      is_placeholder: true,
      buildarch: 'amd64-x86_64',
    });
    expect(result.success).toBe(true);
  });
});
