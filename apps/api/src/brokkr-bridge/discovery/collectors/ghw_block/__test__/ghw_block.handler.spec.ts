import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GhwBlockHandler } from '../ghw_block.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/ghw_block', `${name}.json`), 'utf8'));

describe('GhwBlockHandler', () => {
  const handler = new GhwBlockHandler();

  it('filters loop*; classifies NVMe by name (not ghw drive_type)', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    const drives = mutation.upserts!.storageDrives!;
    expect(drives.map((d) => d.name).sort()).toEqual(['nvme1n1', 'sda']);

    const nvme = drives.find((d) => d.name === 'nvme1n1')!;
    expect(nvme.type).toBe('NVME');
    expect(nvme).toMatchObject({
      physicalBlockBytes: 4096,
      busPath: 'pci-0000:9a:00.0-nvme-1',
      storageController: 'nvme',
    });

    const hdd = drives.find((d) => d.name === 'sda')!;
    expect(hdd.type).toBe('HDD');
  });

  it('omits model/serial/wwn when hardwareString normalises them to null so lsblk values are not overwritten', async () => {
    const parsed = handler.schema.parse({
      block: {
        disks: [
          {
            name: 'nvme0n1',
            size_bytes: 100,
            physical_block_size_bytes: 4096,
            drive_type: 'ssd',
            storage_controller: 'nvme',
            bus_path: 'unknown',
            vendor: 'unknown',
            model: 'unknown',
            serial_number: 'unknown',
            wwn: 'unknown',
          },
        ],
      },
    });
    const mutation = await handler.handle(parsed);
    const drive = mutation.upserts!.storageDrives![0];
    expect(drive.busPath).toBeNull();
    expect('model' in drive).toBe(false);
    expect('serial' in drive).toBe(false);
    expect('wwn' in drive).toBe(false);
  });

  it('warns on malformed disk', async () => {
    const parsed = handler.schema.parse({
      block: {
        disks: [
          null,
          {
            name: 'nvme0n1',
            size_bytes: 100,
            physical_block_size_bytes: 4096,
            drive_type: 'ssd',
            storage_controller: 'nvme',
            bus_path: null,
            vendor: null,
            model: null,
            serial_number: null,
            wwn: null,
          },
        ],
      },
    });
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.storageDrives).toHaveLength(1);
    expect(mutation.warnings?.[0]).toMatch(/ghw_block\.disks\[0\]/);
  });
});
