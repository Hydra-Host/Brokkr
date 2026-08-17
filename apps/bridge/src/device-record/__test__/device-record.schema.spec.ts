import { describe, expect, it } from 'vitest';

import { deviceRecordSchema, isPlaceholder } from '../device-record.schema';

const REAL_ID = '11111111-1111-1111-1111-111111111111';
const PLACEHOLDER_ID = '22222222-2222-2222-2222-222222222222';

const MIN_VALID = {
  id: REAL_ID,
  status: null,
  role: null,
  platform_slug: null,
  device_type: null,
  netplan: null,
  serial_port_recommended: null,
  location_network_type: null,
  is_vpc: false,
  last_job_id: null,
  buildarch: null,
};

describe('deviceRecordSchema', () => {
  it('accepts minimal payload', () => {
    const record = deviceRecordSchema.parse({ id: REAL_ID });
    expect(record.id).toBe(REAL_ID);
    expect(record.platform_tags).toEqual([]);
    expect(record.status).toBeUndefined();
    expect(record.is_placeholder).toBe(false);
    expect(record.is_vpc).toBe(false);
    expect(record.location_network_type).toBeUndefined();
  });

  it('accepts full payload', () => {
    const record = deviceRecordSchema.parse({
      ...MIN_VALID,
      id: REAL_ID,
      is_placeholder: false,
      status: 'provisioning',
      role: 'server',
      platform_slug: 'ipxe-custom',
      platform_tags: ['rescue', 'experimental'],
      device_type: 'poweredge-xe9780',
      netplan: 'network:\n  version: 2',
      serial_port_recommended: 'ttyS1',
      location_network_type: 'roce',
      is_vpc: true,
      last_job_id: 'job-abc',
      buildarch: 'amd64',
    });
    expect(record.platform_tags).toEqual(['rescue', 'experimental']);
    expect(record.device_type).toBe('poweredge-xe9780');
    expect(record.location_network_type).toBe('roce');
    expect(record.is_vpc).toBe(true);
  });

  it('ignores extra fields (forward-compat for hub-ahead-of-spoke deploys)', () => {
    const record = deviceRecordSchema.parse({ id: REAL_ID, unexpected: 'field' });
    expect(record.id).toBe(REAL_ID);
    expect((record as Record<string, unknown>).unexpected).toBeUndefined();
  });

  it('rejects missing id', () => {
    expect(() => deviceRecordSchema.parse({ status: 'ok' })).toThrow();
  });

  it('isPlaceholder reads flag', () => {
    const real = deviceRecordSchema.parse({ id: REAL_ID });
    expect(isPlaceholder(real)).toBe(false);

    const realExplicit = deviceRecordSchema.parse({ id: REAL_ID, is_placeholder: false });
    expect(isPlaceholder(realExplicit)).toBe(false);

    const placeholder = deviceRecordSchema.parse({ id: PLACEHOLDER_ID, is_placeholder: true });
    expect(isPlaceholder(placeholder)).toBe(true);
  });
});
