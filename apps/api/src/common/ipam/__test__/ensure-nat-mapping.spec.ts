import { describe, expect, it, vi } from 'vitest';
import { ensureNatMapping } from '../ensure-nat-mapping';

type InsideRow = { id: string };
type OutsideRow = { id: string; natInsideId: string | null };

const makeTx = (inside: InsideRow[], outside: OutsideRow[]) => ({
  $queryRaw: vi.fn().mockResolvedValueOnce(inside).mockResolvedValueOnce(outside),
  ipAddress: {
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
  },
});

const params = {
  outsideAddress: '198.51.100.42',
  insideAddress: '10.0.0.5/24',
  organizationId: 'org-1',
  deviceId: 'device-1',
};

describe('ensureNatMapping', () => {
  it('rejects malformed addresses without touching the DB', async () => {
    const tx = makeTx([], []);
    expect(await ensureNatMapping(tx, { ...params, outsideAddress: 'nope' })).toBe('invalid');
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('skips when the inside (private) row does not exist yet', async () => {
    const tx = makeTx([], []);
    expect(await ensureNatMapping(tx, params)).toBe('inside-missing');
    expect(tx.ipAddress.create).not.toHaveBeenCalled();
  });

  it('creates the outside row linked to the inside row', async () => {
    const tx = makeTx([{ id: 'inside-1' }], []);
    expect(await ensureNatMapping(tx, params)).toBe('linked');
    expect(tx.ipAddress.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ address: '198.51.100.42', organizationId: 'org-1', natInsideId: 'inside-1' }),
    });
  });

  it('leaves an already-correct mapping unchanged', async () => {
    const tx = makeTx([{ id: 'inside-1' }], [{ id: 'out-1', natInsideId: 'inside-1' }]);
    expect(await ensureNatMapping(tx, params)).toBe('unchanged');
    expect(tx.ipAddress.update).not.toHaveBeenCalled();
  });

  it('re-links an existing outside row pointing at a stale inside', async () => {
    const tx = makeTx([{ id: 'inside-1' }], [{ id: 'out-1', natInsideId: 'old-inside' }]);
    expect(await ensureNatMapping(tx, params)).toBe('linked');
    expect(tx.ipAddress.update).toHaveBeenCalledWith({
      where: { id: 'out-1' },
      data: { natInsideId: 'inside-1' },
    });
  });

  it('scopes the inside lookup to the device, not the whole organization', async () => {
    const tx = makeTx([{ id: 'inside-1' }], []);
    await ensureNatMapping(tx, params);
    const insideQuery = tx.$queryRaw.mock.calls[0]?.[0] as { strings: string[]; values: unknown[] };
    expect(insideQuery.strings.join('')).toContain('"Interface"');
    expect(insideQuery.values).toContain('device-1');
  });

  it('only adopts a standalone outside row — never an attached/assigned one', async () => {
    const tx = makeTx([{ id: 'inside-1' }], []);
    await ensureNatMapping(tx, params);
    const outsideQuery = tx.$queryRaw.mock.calls[1]?.[0] as { strings: string[]; values: unknown[] };
    const sql = outsideQuery.strings.join('');
    expect(sql).toContain('"interfaceId" IS NULL');
    expect(sql).toContain('"assignedObjectId" IS NULL');
  });
});
