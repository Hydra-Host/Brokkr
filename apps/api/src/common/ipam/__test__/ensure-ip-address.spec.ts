import { describe, expect, it, vi } from 'vitest';
import { ensureIpAddress, isValidInetString } from '../ensure-ip-address';

type ExistingRow = { id: string; interfaceId: string | null; deviceId: string | null };

const makeTx = (existing: ExistingRow | null) => ({
  $queryRaw: vi.fn().mockResolvedValue(existing ? [existing] : []),
  ipAddress: {
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
  },
});

const params = { address: '10.0.0.5/24', interfaceId: 'iface-1', deviceId: 'dev-1', organizationId: 'org-1' };

describe('isValidInetString', () => {
  it.each(['10.0.0.5', '10.0.0.5/24', '10.0.0.5/32', '2001:db8::1', '2001:db8::1/64', '2001:db8::1/128'])(
    '%s → valid',
    (address) => expect(isValidInetString(address)).toBe(true),
  );

  it.each(['', 'Unknown', '10.0.0.5/24/8', '10.0.0.5/33', '10.0.0.5/abc', '2001:db8::1/129', 'aa:bb:cc:dd:ee:ff'])(
    '%s → invalid',
    (address) => expect(isValidInetString(address)).toBe(false),
  );
});

describe('ensureIpAddress', () => {
  it('rejects malformed addresses without touching the DB', async () => {
    const tx = makeTx(null);
    expect(await ensureIpAddress(tx, { ...params, address: 'Unknown' })).toBe('invalid');
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.ipAddress.create).not.toHaveBeenCalled();
  });

  it('creates a row attached to the interface when none exists', async () => {
    const tx = makeTx(null);
    expect(await ensureIpAddress(tx, params)).toBe('created');
    expect(tx.ipAddress.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ address: '10.0.0.5/24', organizationId: 'org-1', interfaceId: 'iface-1' }),
    });
  });

  it('leaves a row already attached to this interface unchanged', async () => {
    const tx = makeTx({ id: 'ip-1', interfaceId: 'iface-1', deviceId: 'dev-1' });
    expect(await ensureIpAddress(tx, params)).toBe('unchanged');
    expect(tx.ipAddress.update).not.toHaveBeenCalled();
  });

  it('attaches an unassigned existing row', async () => {
    const tx = makeTx({ id: 'ip-1', interfaceId: null, deviceId: null });
    expect(await ensureIpAddress(tx, params)).toBe('attached');
    expect(tx.ipAddress.update).toHaveBeenCalledWith({
      where: { id: 'ip-1' },
      data: expect.objectContaining({ interfaceId: 'iface-1' }),
    });
  });

  it('re-attaches within the same device (NIC rename/replacement)', async () => {
    const tx = makeTx({ id: 'ip-1', interfaceId: 'old-iface', deviceId: 'dev-1' });
    expect(await ensureIpAddress(tx, params)).toBe('attached');
    expect(tx.ipAddress.update).toHaveBeenCalled();
  });

  it('never steals a row assigned to another device', async () => {
    const tx = makeTx({ id: 'ip-1', interfaceId: 'other-iface', deviceId: 'dev-2' });
    expect(await ensureIpAddress(tx, params)).toBe('assigned-elsewhere');
    expect(tx.ipAddress.update).not.toHaveBeenCalled();
    expect(tx.ipAddress.create).not.toHaveBeenCalled();
  });
});
