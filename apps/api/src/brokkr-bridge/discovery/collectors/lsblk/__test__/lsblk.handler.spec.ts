import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LsblkHandler } from '../lsblk.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/lsblk', `${name}.json`), 'utf8'));

describe('LsblkHandler', () => {
  const handler = new LsblkHandler();

  it('parses happy fixture, filters loop/sr, and emits StorageDrive upserts', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);

    expect(mutation.upserts?.storageDrives).toHaveLength(4);
    const names = mutation.upserts!.storageDrives!.map((d) => d.name).sort();
    expect(names).toEqual(['nvme0n1', 'nvme1n1', 'sda', 'sdb']);
  });

  it('classifies NVMe by name prefix (regardless of rota)', async () => {
    const parsed = handler.schema.parse([
      { name: 'nvme0n1', size: 100, rota: false, serial: 'x', wwn: 'x', model: 'x' },
      { name: 'sda', size: 100, rota: true, serial: 'x', wwn: 'x', model: 'x' },
      { name: 'sdb', size: 100, rota: false, serial: 'x', wwn: 'x', model: 'x' },
    ]);
    const mutation = await handler.handle(parsed);
    const byName = Object.fromEntries(mutation.upserts!.storageDrives!.map((d) => [d.name, d.type]));
    expect(byName).toEqual({ nvme0n1: 'NVME', sda: 'HDD', sdb: 'SSD' });
  });

  it('records a warning for a malformed row but keeps the rest', async () => {
    const parsed = handler.schema.parse([
      { name: 'nvme0n1', size: 100, rota: false, serial: 'x', wwn: 'x', model: 'x' },
      { name: 'broken' },
    ]);
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.storageDrives).toHaveLength(1);
    expect(mutation.warnings?.[0]).toMatch(/lsblk\[1\]/);
  });
});
