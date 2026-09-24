import { describe, expect, it, vi } from 'vitest';
import { HealthSnapshotReader } from '../health-snapshot.reader';

const DEVICE = '22222222-2222-2222-2222-222222222222';
const ZONE = '11111111-1111-1111-1111-111111111111';

const snapshot = {
  device_id: DEVICE,
  primary_reachable: true,
  bmc_icmp_reachable: true,
  bmc_ipmi_reachable: true,
  bmc_redfish_reachable: true,
  bmc_creds_valid: true,
  powered_on: true,
  brokkr_live_running: null,
  checked_at: Date.parse('2026-09-16T11:56:00.000Z') / 1000,
};

function setup(raw: string | null) {
  const redis = { get: vi.fn().mockResolvedValue(raw) };
  return { reader: new HealthSnapshotReader(redis), redis };
}

describe('HealthSnapshotReader.read', () => {
  it('reads the zone-scoped snapshot key and returns the parsed snapshot', async () => {
    const { reader, redis } = setup(JSON.stringify(snapshot));
    await expect(reader.read(ZONE, DEVICE)).resolves.toEqual(snapshot);
    expect(redis.get).toHaveBeenCalledWith(`${ZONE}:device-health:${DEVICE}`);
  });

  it('returns null when no snapshot is stored', async () => {
    const { reader } = setup(null);
    await expect(reader.read(ZONE, DEVICE)).resolves.toBeNull();
  });

  it('returns null for a snapshot that is not json', async () => {
    const { reader } = setup('{not json');
    await expect(reader.read(ZONE, DEVICE)).resolves.toBeNull();
  });

  it('returns null for a snapshot that fails the schema', async () => {
    const { reader } = setup(JSON.stringify({ ...snapshot, checked_at: 'yesterday' }));
    await expect(reader.read(ZONE, DEVICE)).resolves.toBeNull();
  });
});
